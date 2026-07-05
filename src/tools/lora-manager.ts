import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getLoraCatalog,
  toLoraSummary,
  type LoraCatalogEntry,
} from "../services/lora-catalog.js";
import { errorToToolResult } from "../utils/errors.js";

function formatEntry(entry: LoraCatalogEntry): string {
  const lines = [
    `**${entry.displayName}** (\`${entry.relPath}\`)`,
    entry.missing ? "⚠️ file missing on disk" : "✓ on disk",
    entry.description ? `Description: ${entry.description}` : null,
    entry.setupInstructions ? `Setup: ${entry.setupInstructions}` : null,
    entry.keywords.length ? `Keywords: ${entry.keywords.join(", ")}` : null,
    entry.negativeKeywords?.length
      ? `Avoid: ${entry.negativeKeywords.join(", ")}`
      : null,
    entry.baseModels.length ? `Base models: ${entry.baseModels.join(", ")}` : null,
    entry.strengthDefault != null
      ? `Strength: default ${entry.strengthDefault}${entry.strengthMin != null ? ` (range ${entry.strengthMin}–${entry.strengthMax ?? entry.strengthDefault})` : ""}`
      : null,
    entry.previewFile ? `Preview: ${entry.previewFile}` : null,
    entry.sourceUrl ? `Source: ${entry.sourceUrl}` : null,
    entry.notes ? `Notes: ${entry.notes}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

const upsertSchema = {
  id: z.string().optional().describe("Catalog id (auto-derived from rel_path if omitted)"),
  rel_path: z
    .string()
    .optional()
    .describe("ComfyUI-relative path under models/ (e.g. loras/style/foo.safetensors)"),
  display_name: z.string().optional(),
  description: z.string().optional().describe("What this LoRA does"),
  setup_instructions: z
    .string()
    .optional()
    .describe("How to wire it: checkpoint, node placement, clip skip, etc."),
  keywords: z.array(z.string()).optional().describe("Trigger words for prompts"),
  negative_keywords: z.array(z.string()).optional(),
  base_models: z.array(z.string()).optional().describe("Compatible base models (SDXL, Flux, …)"),
  strength_min: z.number().optional(),
  strength_max: z.number().optional(),
  strength_default: z.number().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  source_url: z.string().url().optional(),
  civitai_model_id: z.number().int().optional(),
  civitai_version_id: z.number().int().optional(),
};

export function registerLoraManagerTools(server: McpServer): void {
  server.tool(
    "lora_catalog_sync",
    "Scan the connected ComfyUI for LoRA files and merge them into the persistent LoRA catalog. " +
      "New files get stub entries; existing curated metadata is preserved. Files no longer on disk are flagged missing. " +
      "Call this after downloading LoRAs or when the catalog looks stale.",
    {},
    async () => {
      try {
        const catalog = getLoraCatalog();
        const result = await catalog.syncFromDisk();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "lora_catalog_list",
    "List LoRAs in the curated catalog with metadata (description, setup, keywords, strength hints, preview). " +
      "Use before applying a LoRA so you use the right trigger words and checkpoint pairing. " +
      "Run lora_catalog_sync first if the list may be incomplete.",
    {
      query: z.string().optional().describe("Free-text filter across name, description, keywords, tags"),
      tag: z.string().optional(),
      base_model: z.string().optional(),
      include_missing: z.boolean().optional().describe("Include entries whose file was removed"),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      try {
        const catalog = getLoraCatalog();
        const entries = catalog.list({
          query: args.query,
          tag: args.tag,
          baseModel: args.base_model,
          includeMissing: args.include_missing,
          limit: args.limit,
        });
        if (!entries.length) {
          return { content: [{ type: "text", text: "No LoRA catalog entries match. Run lora_catalog_sync to import local files." }] };
        }
        const text = entries.map(formatEntry).join("\n\n---\n\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "lora_catalog_get",
    "Get full metadata for one LoRA by catalog id or models/ relative path.",
    {
      id_or_path: z.string().describe("Catalog id or rel path (e.g. loras/foo.safetensors)"),
    },
    async (args) => {
      try {
        const catalog = getLoraCatalog();
        const entry = catalog.get(args.id_or_path);
        if (!entry) {
          return {
            content: [{ type: "text", text: `No catalog entry for "${args.id_or_path}". Run lora_catalog_sync or lora_catalog_upsert.` }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: formatEntry(entry) },
            { type: "text", text: JSON.stringify(toLoraSummary(entry), null, 2) },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "lora_catalog_upsert",
    "Create or update curated metadata for a LoRA (description, setup instructions, keywords, strength hints). " +
      "The file must exist in the catalog — run lora_catalog_sync first for new downloads.",
    upsertSchema,
    async (args) => {
      try {
        const catalog = getLoraCatalog();
        const entry = catalog.upsert({
          id: args.id,
          relPath: args.rel_path,
          displayName: args.display_name,
          description: args.description,
          setupInstructions: args.setup_instructions,
          keywords: args.keywords,
          negativeKeywords: args.negative_keywords,
          baseModels: args.base_models,
          strengthMin: args.strength_min,
          strengthMax: args.strength_max,
          strengthDefault: args.strength_default,
          tags: args.tags,
          notes: args.notes,
          sourceUrl: args.source_url,
          civitaiModelId: args.civitai_model_id,
          civitaiVersionId: args.civitai_version_id,
        });
        return {
          content: [{ type: "text", text: `Saved catalog entry for ${entry.displayName} (${entry.id}).\n\n${formatEntry(entry)}` }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "lora_catalog_set_preview",
    "Attach a preview image to a catalog entry (copied into the instance preview store). " +
      "Use a sample render or CivitAI thumbnail so users and agents can recognize the LoRA.",
    {
      id_or_path: z.string(),
      image_path: z.string().describe("Absolute path to a local image file on the orchestrator host"),
    },
    async (args) => {
      try {
        const catalog = getLoraCatalog();
        const entry = catalog.setPreview(args.id_or_path, args.image_path);
        return {
          content: [
            {
              type: "text",
              text: `Preview set for ${entry.displayName} → ${entry.previewFile}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "lora_catalog_search",
    "Search the LoRA catalog by keyword, tag, or base model. Returns compact JSON summaries for matching entries.",
    {
      query: z.string().optional(),
      tag: z.string().optional(),
      base_model: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      try {
        const catalog = getLoraCatalog();
        const entries = catalog.list({
          query: args.query,
          tag: args.tag,
          baseModel: args.base_model,
          limit: args.limit ?? 20,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(entries.map(toLoraSummary), null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}