import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runWorkflowPipeline } from "../services/workflow-pipeline.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerWorkflowPipelineTools(server: McpServer): void {
  server.tool(
    "run_workflow_pipeline",
    "Execute a multi-stage ComfyUI project from a YAML manifest: ordered workflows, shared assets, " +
      "optional per-stage pins (workflow paths for panel_set_workflow_target), and chain_from to feed " +
      "one stage's output into the next via stage_output_as_input + apply_reference_to_workflow. " +
      "Each stage loads workflow as pack:<name> or path:<file> (UI or API JSON), applies inputs/node_inputs, " +
      "enqueues, and waits by default. Use dry_run:true to validate the manifest without executing. " +
      "Requires a reachable ComfyUI server.",
    {
      project_path: z
        .string()
        .optional()
        .describe("Path to project YAML (.yaml/.yml)"),
      project_yaml: z
        .string()
        .optional()
        .describe("Inline project manifest YAML (alternative to project_path)"),
      start_at: z
        .string()
        .optional()
        .describe("Run from this stage id onward"),
      stop_at: z
        .string()
        .optional()
        .describe("Stop after this stage id (inclusive)"),
      dry_run: z
        .boolean()
        .optional()
        .describe("Parse manifest and list stages without enqueueing"),
      default_timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Default per-stage wait timeout when stage omits timeout_seconds (default 1800)"),
    },
    async (args) => {
      try {
        const result = await runWorkflowPipeline(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}