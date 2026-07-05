import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchConceptImage } from "../services/concept-image.js";
import { applyReferenceToWorkflow } from "../services/apply-reference.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import type { WorkflowJSON } from "../comfyui/types.js";

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("workflow must be a JSON object keyed by node id");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid workflow JSON: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("workflow must be a JSON string or object");
}

const aspectRatioSchema = z
  .enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "auto"])
  .optional();

export function registerConceptImageTools(server: McpServer): void {
  server.tool(
    "fetch_concept_image",
    "Generate a concept/reference image from Grok Imagine (xAI) or Google Nano Banana (Gemini image API) " +
      "and save it to a local temp file. Optionally upload to ComfyUI input/ for LoadImage nodes. " +
      "Auth: XAI_API_KEY or ~/.grok/auth.json for grok; GEMINI_API_KEY or Gemini CLI OAuth for google. " +
      "Use apply_reference_to_workflow to wire the returned comfy_filename into a workflow.",
    {
      provider: z
        .enum(["grok", "google"])
        .describe("Image provider: grok (xAI Imagine) or google (Gemini image / Nano Banana)"),
      prompt: z.string().describe("Text prompt describing the concept image to generate"),
      aspect_ratio: aspectRatioSchema.describe("Output aspect ratio (default auto)"),
      reference_image_path: z
        .string()
        .optional()
        .describe("Optional local image path for edit/style-transfer (provider edit API)"),
      output_dir: z
        .string()
        .optional()
        .describe("Directory to save the file (default: OS temp comfyui-concepts/)"),
      upload_to_comfyui: z
        .boolean()
        .optional()
        .default(true)
        .describe("Upload to ComfyUI input/ after generation (recommended for workflows)"),
      model: z
        .string()
        .optional()
        .describe(
          "Override provider model (grok default grok-imagine-image; google default gemini-2.5-flash-image)",
        ),
    },
    async (args) => {
      try {
        const result = await fetchConceptImage({
          provider: args.provider,
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio,
          reference_image_path: args.reference_image_path,
          output_dir: args.output_dir,
          upload_to_comfyui: args.upload_to_comfyui ?? true,
          model: args.model,
        });
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
    "apply_reference_to_workflow",
    "Wire an uploaded concept/reference image filename into a ComfyUI API-format workflow. " +
      "Targets LoadImage nodes, Qwen image-edit encoder slots (vl_resize_image*, image1), " +
      "control_image, and reference_image inputs. Returns the patched workflow JSON and a patch list. " +
      "Pair with fetch_concept_image (upload_to_comfyui=true) or upload_image.",
    {
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .describe("ComfyUI API-format workflow JSON (object or stringified)"),
      image_filename: z
        .string()
        .describe("Filename in ComfyUI input/ (from fetch_concept_image.comfy_filename or upload_image)"),
      role: z
        .enum(["primary", "reference", "control", "mask", "auto"])
        .optional()
        .default("auto")
        .describe(
          "Which slots to patch. auto = primary LoadImage / Qwen vl_resize_image1, else first slot.",
        ),
      node_id: z.string().optional().describe("Explicit node id to patch"),
      input_name: z.string().optional().describe("Explicit input/widget name (requires node_id)"),
      apply_all_matching: z
        .boolean()
        .optional()
        .describe("Patch every slot matching role (default: first match only)"),
    },
    async (args) => {
      try {
        const workflow = parseWorkflow(args.workflow);
        const result = applyReferenceToWorkflow({
          workflow,
          image_filename: args.image_filename,
          role: args.role,
          node_id: args.node_id,
          input_name: args.input_name,
          apply_all_matching: args.apply_all_matching,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  patches: result.patches,
                  slots_considered: result.slots_considered,
                  workflow: result.workflow,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}