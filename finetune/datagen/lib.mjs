// Shared constants for the fine-tune data pipeline (see finetune/README.md).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(REPO_ROOT, "finetune", "data");
export const TOOLS_JSON = join(DATA_DIR, "tools-full.json");

/**
 * Teacher models whose outputs are licensed for distillation. Provider ToS for
 * Anthropic, OpenAI, Google, and xAI all prohibit training other models on
 * their outputs — transcripts from those models must NEVER enter the dataset,
 * no matter how good they score.
 */
export const ALLOWED_TEACHER_PREFIXES = [
  "deepseek/",
  "z-ai/",
  "moonshotai/",
  "minimax/",
  "xiaomi/",
  "qwen/",
];

export const BLOCKED_TEACHER_PREFIXES = ["anthropic/", "openai/", "google/", "x-ai/"];

export function isAllowedTeacher(model) {
  if (BLOCKED_TEACHER_PREFIXES.some((p) => model.startsWith(p))) return false;
  return ALLOWED_TEACHER_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * System prompt for FULL-surface trajectories — what the fine-tuned model will
 * run under in production (adapted from OLLAMA_SYSTEM_PROMPT, minus the
 * 3-meta-tool routing which full mode doesn't have).
 */
export const FULL_SYSTEM_PROMPT =
  "You are a ComfyUI expert agent. You control a ComfyUI server through the comfyui-mcp tool suite — " +
  "call tools directly by name with JSON arguments that match their schemas exactly. " +
  "Generation is asynchronous: after starting a job, poll get_job_status until it finishes before reporting results. " +
  "Finish every task by actually running tools; never invent tool results or filenames.";

/** Render the tools-full.json entries as OpenAI-style tool definitions. */
export function toOpenAiTools(toolsFull) {
  return toolsFull.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
