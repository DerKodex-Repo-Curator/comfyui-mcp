import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  runcomfyTrainerCancelJob,
  runcomfyTrainerCreateDataset,
  runcomfyTrainerDatasetStatus,
  runcomfyTrainerJobResult,
  runcomfyTrainerJobStatus,
  runcomfyTrainerListDatasets,
  runcomfyTrainerSubmitJob,
  runcomfyTrainerUploadDatasetFile,
  runcomfyTrainerWaitDatasetReady,
  runcomfyTrainerWaitJobTerminal,
  type RunComfyTrainerGpuType,
} from "../services/runcomfy-trainer.js";
import { errorToToolResult } from "../utils/errors.js";

const gpuTypeSchema = z.enum(["ADA_80_PLUS", "HOPPER_141"]);

export function registerRunComfyTrainerTools(server: McpServer): void {
  server.tool(
    "runcomfy_trainer_create_dataset",
    "Create a RunComfy Trainer API dataset container for AI Toolkit LoRA training. " +
      "Returns dataset id — upload files with runcomfy_trainer_upload_dataset_file, then poll " +
      "runcomfy_trainer_dataset_status until READY. Env: RUNCOMFY_API_KEY.",
    {
      name: z.string().optional().describe("Optional human-readable dataset name"),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerCreateDataset(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_list_datasets",
    "List RunComfy Trainer API datasets for your account.",
    {},
    async () => {
      try {
        const result = await runcomfyTrainerListDatasets();
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_dataset_status",
    "Poll RunComfy Trainer dataset status (CREATING → READY or FAILED).",
    {
      dataset_id: z.string().describe("Dataset id from create_dataset"),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerDatasetStatus(args.dataset_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_upload_dataset_file",
    "Upload a training image or caption file into a RunComfy Trainer dataset (multipart upload).",
    {
      dataset_id: z.string().describe("Target dataset id"),
      file_path: z.string().describe("Absolute or workspace-relative path to the file on this machine"),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerUploadDatasetFile(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_wait_dataset_ready",
    "Block until a RunComfy Trainer dataset reaches READY (or FAILED / timeout).",
    {
      dataset_id: z.string(),
      timeout_seconds: z.number().int().positive().optional().describe("Default 600"),
      poll_seconds: z.number().int().positive().optional().describe("Default 5"),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerWaitDatasetReady(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_submit_job",
    "Submit an AI Toolkit YAML training job to RunComfy Trainer API (cloud GPU). " +
      "Provide config_file (YAML string) or config_file_path. gpu_type: ADA_80_PLUS (A100-class) or HOPPER_141 (H100-class).",
    {
      config_file: z.string().optional().describe("AI Toolkit config YAML body"),
      config_file_path: z.string().optional().describe("Path to local AI Toolkit YAML config"),
      gpu_type: gpuTypeSchema.describe("Cloud GPU tier"),
      gpu_count: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerSubmitJob({
          config_file: args.config_file ?? "",
          config_file_path: args.config_file_path,
          gpu_type: args.gpu_type as RunComfyTrainerGpuType,
          gpu_count: args.gpu_count,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_job_status",
    "Poll RunComfy Trainer AI Toolkit job status and progress.",
    {
      job_id: z.string().describe("Training job id from submit_job"),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerJobStatus(args.job_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_job_result",
    "Fetch RunComfy Trainer job result metadata (artifact URLs, checkpoints) after completion.",
    {
      job_id: z.string(),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerJobResult(args.job_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_cancel_job",
    "Cancel a running RunComfy Trainer AI Toolkit job.",
    {
      job_id: z.string(),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerCancelJob(args.job_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_trainer_wait_job_terminal",
    "Block until a RunComfy Trainer job reaches a terminal state (STOPPED, FAILED, CANCELED).",
    {
      job_id: z.string(),
      timeout_seconds: z.number().int().positive().optional().describe("Default 7200"),
      poll_seconds: z.number().int().positive().optional().describe("Default 15"),
    },
    async (args) => {
      try {
        const result = await runcomfyTrainerWaitJobTerminal(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}