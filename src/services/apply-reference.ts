import type { WorkflowJSON } from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";
import { assertSafeInputFilename } from "../utils/input-paths.js";
import { modifyWorkflow, type ModifyOperation } from "./workflow-composer.js";

export type ReferenceRole = "primary" | "reference" | "control" | "mask" | "auto";

export interface ReferenceSlot {
  node_id: string;
  class_type: string;
  input_name: string;
  role: ReferenceRole;
  title?: string;
}

export interface ApplyReferenceArgs {
  workflow: WorkflowJSON;
  /** ComfyUI input/ filename (from upload_image or fetch_concept_image upload). */
  image_filename: string;
  /** Apply only to slots matching this role. Default: auto (primary LoadImage + Qwen vl_resize_image1). */
  role?: ReferenceRole;
  /** Apply to a specific node/input instead of auto-detection. */
  node_id?: string;
  input_name?: string;
  /** When multiple slots match, patch all (default false — first match only). */
  apply_all_matching?: boolean;
}

export interface ApplyReferenceResult {
  workflow: WorkflowJSON;
  patches: Array<{ node_id: string; input_name: string; previous: unknown; value: string }>;
  slots_considered: ReferenceSlot[];
}

const QWEN_VL_PRIMARY = /^vl_resize_image1$/;
const QWEN_IMAGE_SLOTS = /^(vl_resize_image\d+|not_resize_image\d+|image\d*)$/;
function slotRole(classType: string, inputName: string): ReferenceRole {
  if (classType === "LoadImage" && inputName === "image") return "primary";
  if (QWEN_VL_PRIMARY.test(inputName)) return "primary";
  if (QWEN_IMAGE_SLOTS.test(inputName)) return "reference";
  if (inputName === "control_image" || inputName === "image" && classType.includes("ControlNet")) {
    return "control";
  }
  if (inputName === "mask" || inputName === "mask_path") return "mask";
  if (inputName === "reference_image") return "reference";
  return "reference";
}

/** Discover workflow nodes that accept an uploaded image filename. */
export function findReferenceSlots(workflow: WorkflowJSON): ReferenceSlot[] {
  const slots: ReferenceSlot[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const ct = node.class_type;
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (typeof value === "string") {
        if (
          (ct === "LoadImage" && inputName === "image") ||
          QWEN_IMAGE_SLOTS.test(inputName) ||
          inputName === "control_image" ||
          inputName === "reference_image" ||
          inputName === "mask_path"
        ) {
          slots.push({
            node_id: nodeId,
            class_type: ct,
            input_name: inputName,
            role: slotRole(ct, inputName),
            title: node._meta?.title,
          });
        }
      }
    }
  }
  return slots;
}

function pickSlots(slots: ReferenceSlot[], role: ReferenceRole): ReferenceSlot[] {
  if (role !== "auto") {
    return slots.filter((s) => s.role === role);
  }
  const primary = slots.filter((s) => s.role === "primary");
  if (primary.length) return primary;
  return slots.length ? [slots[0]] : [];
}

export function applyReferenceToWorkflow(args: ApplyReferenceArgs): ApplyReferenceResult {
  assertSafeInputFilename(args.image_filename, "image_filename");

  const wf = args.workflow;
  const allSlots = findReferenceSlots(wf);

  let targets: ReferenceSlot[];
  if (args.node_id && args.input_name) {
    const node = wf[args.node_id];
    if (!node) throw new ValidationError(`Node "${args.node_id}" not found in workflow.`);
    if (!(args.input_name in node.inputs)) {
      throw new ValidationError(
        `Node "${args.node_id}" (${node.class_type}) has no input "${args.input_name}".`,
      );
    }
    targets = [
      {
        node_id: args.node_id,
        class_type: node.class_type,
        input_name: args.input_name,
        role: slotRole(node.class_type, args.input_name),
        title: node._meta?.title,
      },
    ];
  } else {
    const role = args.role ?? "auto";
    targets = pickSlots(allSlots, role);
    if (!targets.length) {
      throw new ValidationError(
        "No reference image slots found in workflow (LoadImage, Qwen edit encoders, control_image, etc.).",
      );
    }
    if (!args.apply_all_matching) {
      targets = [targets[0]];
    }
  }

  const ops: ModifyOperation[] = targets.map((t) => ({
    op: "set_input",
    node_id: t.node_id,
    input_name: t.input_name,
    value: args.image_filename,
  }));

  const patches = targets.map((t) => ({
    node_id: t.node_id,
    input_name: t.input_name,
    previous: wf[t.node_id]?.inputs[t.input_name],
    value: args.image_filename,
  }));

  const { workflow } = modifyWorkflow(wf, ops);
  return { workflow, patches, slots_considered: allSlots };
}