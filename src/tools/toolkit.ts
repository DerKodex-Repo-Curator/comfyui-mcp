import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  toolkitListModels,
  toolkitRunJob,
  toolkitStatus,
} from "../services/toolkit-supervisor.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerToolkitTools(server: McpServer): void {
  server.tool(
    "toolkit_status",
    "Probe or manage the local ostris AI-Toolkit web UI (port 8675). " +
      "Actions: probe (default) — running state, GPU, jobs, queues; start — launch ui/ via npm run start; " +
      "stop — kill listener on the toolkit port; restart — stop then start. " +
      "Env: AI_TOOLKIT_ROOT, AI_TOOLKIT_PORT or AI_TOOLKIT_URL, AI_TOOLKIT_AUTH (Bearer for /api/*).",
    {
      action: z
        .enum(["probe", "start", "stop", "restart"])
        .optional()
        .describe("probe (default), start, stop, or restart the AI Toolkit UI process"),
    },
    async ({ action }) => {
      try {
        const result = await toolkitStatus({ action });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "toolkit_list_models",
    "List training model/architecture examples shipped with the local AI-Toolkit install " +
      "by scanning config/examples/*.yaml. Returns arch, model name_or_path, and example filenames " +
      "for WAN, Z-Image, Flux, Qwen, and other trainer presets.",
    {},
    async () => {
      try {
        const result = await toolkitListModels();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "toolkit_run_job",
    "Create and queue an AI-Toolkit training job through the local UI API. " +
      "Provide job_config (object) or config_path (yaml under AI_TOOLKIT_ROOT, e.g. config/examples/train_lora_wan22_14b_24gb.yaml). " +
      "The job is created, marked queued, and the GPU queue worker is started. " +
      "Requires the toolkit UI to be running (toolkit_status action=start).",
    {
      name: z.string().describe("Unique job name in the AI-Toolkit UI"),
      job_config: z
        .record(z.string(), z.any())
        .optional()
        .describe("Job config object (same shape as a config/examples yaml)"),
      config_path: z
        .string()
        .optional()
        .describe(
          "Path to a yaml job config relative to AI_TOOLKIT_ROOT or absolute",
        ),
      gpu_ids: z
        .string()
        .optional()
        .describe('GPU id string (default "0"; use "mps" on macOS)'),
      job_type: z
        .string()
        .optional()
        .describe("Optional job_type field stored with the job"),
    },
    async (args) => {
      try {
        const result = await toolkitRunJob(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}