// a2ui-spec.ts — server-side validation of A2UI card specs (panel_ui_render /
// panel_ui_update). MUST stay in lockstep with the panel-side validator in
// comfyui-agent-panel/web/js/cmcp-a2ui.js — same caps, same vocabulary. The
// tool layer rejects here so the agent gets a retryable error; the panel
// re-validates before rendering (fence path has only the panel check).
//
// HARDENING NOTE: the panel-side validator gained four security fixes after
// this shape was first drafted, and this file mirrors all four so the two
// walls can't drift apart:
//   1. Children-array length cap: each Row/Column/Card `children` array is
//      capped at maxComponents (64) entries, via `.max()` on the zod schema.
//   2. Render-tree INSTANCE counting in the DFS: repeated child references
//      multiply the actual render tree, so the walk below counts every DFS
//      VISIT (not just declared components) and rejects once total instances
//      exceed maxComponents.
//   3. Image INSTANCE cap in the DFS: same idea for Image — the walk counts
//      every Image visited (not just declared), rejecting past maxImages.
//   4. Chart x-array length cap: `x` is capped at maxChartPoints, same as a
//      series' `values` array.
import { z } from "zod";

export const A2UI_CAPS = {
  maxComponents: 64,
  maxDepth: 8,
  maxGraphNodes: 30,
  maxGraphEdges: 60,
  maxChartSeries: 8,
  maxChartPoints: 256,
  maxSelectOptions: 24,
  maxImages: 4,
  maxTextLen: 2000,
  maxLabelLen: 200,
} as const;

const label = z.string().min(1).max(A2UI_CAPS.maxLabelLen);
const long = z.string().min(1).max(A2UI_CAPS.maxTextLen);
const imageSrc = z
  .string()
  .refine((s) => /^\/(api\/)?view\?/.test(s) || /^blob:/.test(s) || /^data:image\//.test(s), {
    message: "image src not allowed (ComfyUI /view, blob:, data:image/ only)",
  });

// Mirror-hardening #1: cap each container's children array at maxComponents so
// a single declared container can't smuggle in a huge (e.g. 50k-entry) fan-out
// via repeated ids — the DFS instance count (hardening #2) catches the deeper
// nesting variant, this catches the flat one at the schema layer.
const children = z.array(label).max(A2UI_CAPS.maxComponents);

const component = z.discriminatedUnion("type", [
  z.object({ id: label, type: z.literal("Text"), text: long }),
  z.object({
    id: label,
    type: z.literal("Heading"),
    text: label,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  }),
  z.object({
    id: label,
    type: z.literal("Button"),
    label,
    reply: long.optional(),
    submit: z.boolean().optional(),
    style: z.enum(["primary", "secondary"]).optional(),
  }),
  z.object({ id: label, type: z.literal("Row"), children }),
  z.object({ id: label, type: z.literal("Column"), children }),
  z.object({ id: label, type: z.literal("Card"), children }),
  z.object({ id: label, type: z.literal("Divider") }),
  z.object({ id: label, type: z.literal("Image"), src: imageSrc, caption: label.optional() }),
  z.object({
    id: label,
    type: z.literal("TextField"),
    label,
    name: label,
    value: long.optional(),
    placeholder: label.optional(),
  }),
  z.object({
    id: label,
    type: z.literal("Select"),
    label,
    name: label,
    value: label.optional(),
    options: z
      .array(z.object({ label, value: label.optional() }))
      .min(1)
      .max(A2UI_CAPS.maxSelectOptions),
  }),
  z.object({ id: label, type: z.literal("Checkbox"), label, name: label, checked: z.boolean().optional() }),
  z.object({
    id: label,
    type: z.literal("comfy:graph"),
    nodes: z
      .array(z.object({ id: label, label, color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional() }))
      .min(1)
      .max(A2UI_CAPS.maxGraphNodes),
    edges: z.array(z.object({ from: label, to: label, label: label.optional() })).max(A2UI_CAPS.maxGraphEdges).optional(),
    direction: z.enum(["lr", "tb"]).optional(),
  }),
  z.object({
    id: label,
    type: z.literal("comfy:chart"),
    kind: z.enum(["bar", "line"]),
    series: z
      .array(z.object({ label, values: z.array(z.number().finite()).min(1).max(A2UI_CAPS.maxChartPoints) }))
      .min(1)
      .max(A2UI_CAPS.maxChartSeries),
    // Mirror-hardening #4: cap x at maxChartPoints, same as series.values.
    x: z.array(label).max(A2UI_CAPS.maxChartPoints).optional(),
  }),
]);

export const a2uiSpecSchema = z.object({
  surface: z.enum(["inline", "wide"]).default("inline"),
  title: label.optional(),
  root: label,
  components: z.array(component).min(1).max(A2UI_CAPS.maxComponents),
});

export type A2UISpec = z.infer<typeof a2uiSpecSchema>;

const CONTAINERS = new Set(["Row", "Column", "Card"]);

export function validateA2UISpecServer(
  raw: unknown,
): { ok: true; spec: A2UISpec } | { ok: false; errors: string[] } {
  const parsed = a2uiSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 8),
    };
  }
  const spec = parsed.data;
  const errors: string[] = [];
  const byId = new Map<string, A2UISpec["components"][number]>();
  for (const c of spec.components) {
    if (byId.has(c.id)) errors.push(`duplicate id "${c.id}"`);
    byId.set(c.id, c);
  }
  if (!byId.has(spec.root)) errors.push(`root: unknown component id "${spec.root}"`);
  let images = 0;
  for (const c of byId.values()) {
    if (c.type === "Image") images++;
    if (CONTAINERS.has(c.type)) {
      for (const k of (c as { children: string[] }).children) {
        if (!byId.has(k)) errors.push(`"${c.id}": child references unknown component id "${k}"`);
      }
    }
    if (c.type === "comfy:graph") {
      const ids = new Set(c.nodes.map((n) => n.id));
      for (const e of c.edges ?? []) {
        if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`"${c.id}": edge references unknown graph node`);
      }
    }
  }
  if (images > A2UI_CAPS.maxImages) errors.push(`too many images (${images} > ${A2UI_CAPS.maxImages})`);
  if (errors.length) return { ok: false, errors };

  // Cycle + depth check via DFS from root — and cap total INSTANCES: repeated
  // child references multiply the render tree, so we count every DFS VISIT,
  // not just declared components (mirror-hardenings #2 and #3 — 2 declared
  // components must not be able to render 50k node instances, and 1 declared
  // Image referenced 5 times must not render 5 images).
  const visiting = new Set<string>();
  let instances = 0;
  let imageInstances = 0;
  const walk = (id: string, depth: number): void => {
    if (errors.length) return;
    if (++instances > A2UI_CAPS.maxComponents) {
      errors.push(`render tree exceeds ${A2UI_CAPS.maxComponents} component instances (repeated child references count)`);
      return;
    }
    if (depth > A2UI_CAPS.maxDepth) {
      errors.push(`nesting depth exceeds ${A2UI_CAPS.maxDepth}`);
      return;
    }
    if (visiting.has(id)) {
      errors.push(`reference cycle through "${id}"`);
      return;
    }
    const c = byId.get(id)!;
    if (c.type === "Image" && ++imageInstances > A2UI_CAPS.maxImages) {
      errors.push(`render tree exceeds ${A2UI_CAPS.maxImages} image instances`);
      return;
    }
    if (!CONTAINERS.has(c.type)) return;
    visiting.add(id);
    for (const k of (c as { children: string[] }).children) {
      walk(k, depth + 1);
      if (errors.length) { visiting.delete(id); return; }
    }
    visiting.delete(id);
  };
  walk(spec.root, 1);
  if (errors.length) return { ok: false, errors };
  return { ok: true, spec };
}
