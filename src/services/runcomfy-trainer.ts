import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunComfyTrainerGpuType = "ADA_80_PLUS" | "HOPPER_141";

export interface RunComfyTrainerConfig {
  apiKey: string;
  apiBase: string;
}

export interface RunComfyTrainerDatasetSummary {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  files?: Array<{ filename: string; size_bytes?: number }>;
  error?: unknown;
  [key: string]: unknown;
}

export interface RunComfyTrainerJobSummary {
  id: string;
  name?: string;
  status?: string;
  progress?: { current_step?: number; total_steps?: number; percent?: number };
  result_url?: string;
  cancel_url?: string;
  status_url?: string;
  artifacts?: {
    checkpoints?: Array<{ path: string }>;
    config?: { path: string };
    samples?: Array<Record<string, unknown>>;
  };
  error?: unknown;
  [key: string]: unknown;
}

export interface RunComfyTrainerDeps {
  fetch?: typeof fetch;
}

const DEFAULT_TRAINER_API_BASE = "https://trainer-api.runcomfy.net";

export function resolveRunComfyTrainerConfig(): RunComfyTrainerConfig {
  const apiKey = process.env.RUNCOMFY_API_KEY?.trim();
  if (!apiKey) {
    throw new ValidationError(
      "RUNCOMFY_API_KEY is required (Bearer token from RunComfy profile → API keys).",
    );
  }
  const apiBase =
    process.env.RUNCOMFY_TRAINER_API_BASE?.trim().replace(/\/$/, "") ||
    DEFAULT_TRAINER_API_BASE;
  return { apiKey, apiBase };
}

function authHeaders(cfg: RunComfyTrainerConfig): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };
}

async function trainerFetch(
  cfg: RunComfyTrainerConfig,
  path: string,
  init: RequestInit,
  deps: RunComfyTrainerDeps = {},
): Promise<Response> {
  const fetchFn = deps.fetch ?? fetch;
  const url = `${cfg.apiBase}${path}`;
  const res = await fetchFn(url, {
    ...init,
    headers: {
      ...authHeaders(cfg),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: init.signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ValidationError(
      `RunComfy Trainer API ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  return res;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

function normalizeDatasetList(payload: unknown): RunComfyTrainerDatasetSummary[] {
  if (Array.isArray(payload)) return payload as RunComfyTrainerDatasetSummary[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { datasets?: unknown }).datasets)) {
    return (payload as { datasets: RunComfyTrainerDatasetSummary[] }).datasets;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Dataset API
// ---------------------------------------------------------------------------

export async function runcomfyTrainerCreateDataset(
  input: { name?: string },
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerDatasetSummary> {
  const cfg = resolveRunComfyTrainerConfig();
  const res = await trainerFetch(
    cfg,
    "/prod/v1/trainers/datasets",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.name ? { name: input.name } : {}),
    },
    deps,
  );
  return readJson(res);
}

export async function runcomfyTrainerListDatasets(
  deps: RunComfyTrainerDeps = {},
): Promise<{ datasets: RunComfyTrainerDatasetSummary[]; count: number; api_base: string }> {
  const cfg = resolveRunComfyTrainerConfig();
  const res = await trainerFetch(cfg, "/prod/v1/trainers/datasets", { method: "GET" }, deps);
  const payload = await readJson<unknown>(res);
  const datasets = normalizeDatasetList(payload);
  return { datasets, count: datasets.length, api_base: cfg.apiBase };
}

export async function runcomfyTrainerDatasetStatus(
  datasetId: string,
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerDatasetSummary> {
  const cfg = resolveRunComfyTrainerConfig();
  const res = await trainerFetch(
    cfg,
    `/prod/v1/trainers/datasets/${encodeURIComponent(datasetId)}/status`,
    { method: "GET" },
    deps,
  );
  return readJson(res);
}

export async function runcomfyTrainerUploadDatasetFile(
  input: { dataset_id: string; file_path: string },
  deps: RunComfyTrainerDeps = {},
): Promise<Record<string, unknown>> {
  const cfg = resolveRunComfyTrainerConfig();
  const filePath = isAbsolute(input.file_path)
    ? input.file_path
    : resolve(process.cwd(), input.file_path);
  if (!existsSync(filePath)) {
    throw new ValidationError(`Dataset file not found: ${filePath}`);
  }
  const bytes = await readFile(filePath);
  const name = filePath.split(/[/\\]/).pop() ?? "upload.bin";
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);

  const fetchFn = deps.fetch ?? fetch;
  const url = `${cfg.apiBase}/prod/v1/trainers/datasets/${encodeURIComponent(input.dataset_id)}/upload`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: authHeaders(cfg),
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ValidationError(
      `RunComfy dataset upload failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  return readJson(res);
}

export async function runcomfyTrainerWaitDatasetReady(
  input: { dataset_id: string; timeout_seconds?: number; poll_seconds?: number },
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerDatasetSummary> {
  const timeoutMs = (input.timeout_seconds ?? 600) * 1000;
  const pollMs = (input.poll_seconds ?? 5) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last: RunComfyTrainerDatasetSummary | undefined;
  while (Date.now() < deadline) {
    last = await runcomfyTrainerDatasetStatus(input.dataset_id, deps);
    const status = (last.status ?? "").toUpperCase();
    if (status === "READY") return last;
    if (status === "FAILED") {
      throw new ValidationError(
        `Dataset ${input.dataset_id} failed: ${JSON.stringify(last.error ?? last).slice(0, 500)}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new ValidationError(
    `Dataset ${input.dataset_id} did not become READY within ${input.timeout_seconds ?? 600}s (last status: ${last?.status ?? "unknown"}).`,
  );
}

// ---------------------------------------------------------------------------
// Training jobs
// ---------------------------------------------------------------------------

export async function runcomfyTrainerSubmitJob(
  input: {
    config_file: string;
    config_file_path?: string;
    gpu_type: RunComfyTrainerGpuType;
    gpu_count?: number;
  },
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerJobSummary> {
  const cfg = resolveRunComfyTrainerConfig();
  let yaml = input.config_file?.trim() ?? "";
  if (!yaml && input.config_file_path) {
    const p = isAbsolute(input.config_file_path)
      ? input.config_file_path
      : resolve(process.cwd(), input.config_file_path);
    if (!existsSync(p)) {
      throw new ValidationError(`AI Toolkit config not found: ${p}`);
    }
    yaml = await readFile(p, "utf8");
  }
  if (!yaml) {
    throw new ValidationError("Provide config_file (YAML string) or config_file_path for training.");
  }

  const body: Record<string, unknown> = {
    config_file_format: "yaml",
    config_file: yaml,
    gpu_type: input.gpu_type,
  };
  if (input.gpu_count != null) body.gpu_count = input.gpu_count;

  const res = await trainerFetch(
    cfg,
    "/prod/v1/trainers/ai-toolkit/jobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    deps,
  );
  return readJson(res);
}

export async function runcomfyTrainerJobStatus(
  jobId: string,
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerJobSummary> {
  const cfg = resolveRunComfyTrainerConfig();
  const res = await trainerFetch(
    cfg,
    `/prod/v1/trainers/ai-toolkit/jobs/${encodeURIComponent(jobId)}/status`,
    { method: "GET" },
    deps,
  );
  return readJson(res);
}

export async function runcomfyTrainerJobResult(
  jobId: string,
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerJobSummary> {
  const cfg = resolveRunComfyTrainerConfig();
  const res = await trainerFetch(
    cfg,
    `/prod/v1/trainers/ai-toolkit/jobs/${encodeURIComponent(jobId)}/result`,
    { method: "GET" },
    deps,
  );
  return readJson(res);
}

export async function runcomfyTrainerCancelJob(
  jobId: string,
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerJobSummary> {
  const cfg = resolveRunComfyTrainerConfig();
  const res = await trainerFetch(
    cfg,
    `/prod/v1/trainers/ai-toolkit/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    deps,
  );
  return readJson(res);
}

export async function runcomfyTrainerWaitJobTerminal(
  input: { job_id: string; timeout_seconds?: number; poll_seconds?: number },
  deps: RunComfyTrainerDeps = {},
): Promise<RunComfyTrainerJobSummary> {
  const timeoutMs = (input.timeout_seconds ?? 7200) * 1000;
  const pollMs = (input.poll_seconds ?? 15) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last: RunComfyTrainerJobSummary | undefined;
  const terminal = new Set(["STOPPED", "FAILED", "CANCELED", "CANCELLED"]);
  while (Date.now() < deadline) {
    last = await runcomfyTrainerJobStatus(input.job_id, deps);
    const status = (last.status ?? "").toUpperCase();
    if (terminal.has(status)) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new ValidationError(
    `Training job ${input.job_id} did not finish within ${input.timeout_seconds ?? 7200}s (last status: ${last?.status ?? "unknown"}).`,
  );
}