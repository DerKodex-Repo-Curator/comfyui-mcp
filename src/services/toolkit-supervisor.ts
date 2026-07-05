import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolkitStatusAction = "probe" | "start" | "stop" | "restart";

export interface ToolkitConfig {
  root: string;
  baseUrl: string;
  port: number;
  authToken?: string;
}

export interface ToolkitGpuInfo {
  gpus?: unknown;
  [key: string]: unknown;
}

export interface ToolkitJobSummary {
  id: string;
  name: string;
  status?: string;
  gpu_ids?: string;
  queue_position?: number;
  info?: string;
}

export interface ToolkitQueueSummary {
  id?: number;
  gpu_ids: string;
  is_running?: boolean;
}

export interface ToolkitStatusResult {
  action: ToolkitStatusAction;
  running: boolean;
  port: number;
  pid: number | null;
  base_url: string;
  root: string;
  api_reachable: boolean;
  gpu?: ToolkitGpuInfo;
  jobs?: ToolkitJobSummary[];
  queues?: ToolkitQueueSummary[];
  message?: string;
  started?: boolean;
  stopped?: boolean;
}

export interface ToolkitModelExample {
  file: string;
  rel_path: string;
  name?: string;
  arch?: string;
  model_name_or_path?: string;
  job_type?: string;
}

export interface ToolkitListModelsResult {
  root: string;
  examples_dir: string;
  models: ToolkitModelExample[];
}

export interface ToolkitRunJobInput {
  name: string;
  job_config?: unknown;
  config_path?: string;
  gpu_ids?: string;
  job_type?: string;
}

export interface ToolkitRunJobResult {
  job_id: string;
  name: string;
  gpu_ids: string;
  status: string;
  queue_started: boolean;
  message: string;
}

export interface ToolkitDeps {
  fetch?: typeof fetch;
  findPidByPort?: (port: number) => number | null;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let supervisedChild: ChildProcess | null = null;
let lastSpawnRoot: string | null = null;

const IS_WIN = platform() === "win32";
const DEFAULT_PORT = 8675;

// ---------------------------------------------------------------------------
// Config / detection
// ---------------------------------------------------------------------------

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536
    ? Math.floor(parsed)
    : fallback;
}

function isToolkitRoot(path: string): boolean {
  return (
    existsSync(join(path, "run.py")) &&
    existsSync(join(path, "ui", "package.json"))
  );
}

export function detectToolkitRoot(): string | null {
  const envRoot = process.env.AI_TOOLKIT_ROOT?.trim();
  if (envRoot && isToolkitRoot(envRoot)) return resolve(envRoot);

  const home = homedir();
  const candidates = [
    "/workspace/ai-toolkit",
    join(home, "ai-toolkit"),
    join(home, "AI-Toolkit"),
    join(home, "code", "ai-toolkit"),
    join(home, "projects", "ai-toolkit"),
    join(home, "src", "ai-toolkit"),
  ];

  for (const candidate of candidates) {
    if (isToolkitRoot(candidate)) return resolve(candidate);
  }
  return null;
}

export function resolveToolkitConfig(): ToolkitConfig {
  const root = detectToolkitRoot();
  if (!root) {
    throw new ValidationError(
      "AI Toolkit install not found. Set AI_TOOLKIT_ROOT to a folder containing run.py and ui/, " +
        "or install to ~/ai-toolkit or /workspace/ai-toolkit.",
    );
  }

  const port = process.env.AI_TOOLKIT_URL
    ? (() => {
        try {
          const url = new URL(process.env.AI_TOOLKIT_URL!);
          return parsePort(url.port, DEFAULT_PORT);
        } catch {
          throw new ValidationError(
            `Invalid AI_TOOLKIT_URL: ${process.env.AI_TOOLKIT_URL}`,
          );
        }
      })()
    : parsePort(process.env.AI_TOOLKIT_PORT, DEFAULT_PORT);

  const baseUrl =
    process.env.AI_TOOLKIT_URL?.trim() ||
    `http://127.0.0.1:${port}`;

  const authToken = process.env.AI_TOOLKIT_AUTH?.trim() || undefined;

  return { root, baseUrl: baseUrl.replace(/\/$/, ""), port, authToken };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function defaultFindPidByPort(port: number): number | null {
  try {
    if (IS_WIN) {
      const out = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid) && pid > 0) return pid;
        }
      }
    } else {
      const out = execSync(`lsof -ti :${port}`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const pid = parseInt(out.split("\n")[0], 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  } catch {
    // no listener
  }
  return null;
}

function killProcessTree(pid: number): void {
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /T /F`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      try {
        execSync(`sleep 1 && kill -9 ${pid} 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 5000,
        });
      } catch {
        // already dead
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found|no such process|does not exist/i.test(msg)) {
      throw new ProcessControlError(`Failed to kill process ${pid}: ${msg}`);
    }
  }
}

async function waitForPortFree(port: number, timeoutMs = 15000): Promise<void> {
  const findPid = defaultFindPidByPort;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findPid(port) === null) return;
    await sleep(500);
  }
  throw new ProcessControlError(
    `Port ${port} still in use after ${timeoutMs / 1000}s`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand(): string {
  return IS_WIN ? "npm.cmd" : "npm";
}

async function waitForApiReady(
  cfg: ToolkitConfig,
  deps: ToolkitDeps,
  timeoutMs = 120_000,
): Promise<boolean> {
  const fetchFn = deps.fetch ?? fetch;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await toolkitFetch(cfg, "/api/gpu", { method: "GET" }, fetchFn);
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await sleep(1000);
  }
  return false;
}

function spawnToolkitUi(cfg: ToolkitConfig): ChildProcess {
  const uiDir = join(cfg.root, "ui");
  if (!existsSync(join(uiDir, "package.json"))) {
    throw new ValidationError(`AI Toolkit UI not found at ${uiDir}`);
  }

  const env = { ...process.env };
  if (cfg.authToken) {
    env.AI_TOOLKIT_AUTH = cfg.authToken;
  }

  const child = spawn(npmCommand(), ["run", "start"], {
    cwd: uiDir,
    detached: true,
    stdio: "ignore",
    shell: false,
    env,
  });
  child.unref();
  supervisedChild = child;
  lastSpawnRoot = cfg.root;
  logger.info("Spawned AI Toolkit UI", { root: cfg.root, port: cfg.port });
  return child;
}

async function stopToolkitProcess(port: number): Promise<boolean> {
  detachSupervisedChild();
  const pid = defaultFindPidByPort(port);
  if (!pid) return false;
  killProcessTree(pid);
  try {
    await waitForPortFree(port, 15000);
  } catch {
    logger.warn("AI Toolkit port did not free in time after stop");
  }
  return true;
}

function detachSupervisedChild(): void {
  supervisedChild = null;
  lastSpawnRoot = null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(cfg: ToolkitConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (cfg.authToken) {
    headers.Authorization = `Bearer ${cfg.authToken}`;
  }
  return headers;
}

async function toolkitFetch(
  cfg: ToolkitConfig,
  path: string,
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const url = `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    ...authHeaders(cfg),
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetchFn(url, { ...init, headers });
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      // use raw text
    }
    throw new ValidationError(
      `AI Toolkit API ${res.status}: ${detail || res.statusText}`,
    );
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Status probe
// ---------------------------------------------------------------------------

async function probeToolkitApi(
  cfg: ToolkitConfig,
  deps: ToolkitDeps,
): Promise<Pick<ToolkitStatusResult, "api_reachable" | "gpu" | "jobs" | "queues">> {
  const fetchFn = deps.fetch ?? fetch;
  try {
    const gpuRes = await toolkitFetch(cfg, "/api/gpu", { method: "GET" }, fetchFn);
    if (!gpuRes.ok) {
      return { api_reachable: false };
    }
    const gpu = (await gpuRes.json()) as ToolkitGpuInfo;

    let jobs: ToolkitJobSummary[] | undefined;
    let queues: ToolkitQueueSummary[] | undefined;

    try {
      const jobsRes = await toolkitFetch(cfg, "/api/jobs", { method: "GET" }, fetchFn);
      if (jobsRes.ok) {
        const body = (await jobsRes.json()) as { jobs?: ToolkitJobSummary[] };
        jobs = body.jobs;
      }
    } catch {
      // optional
    }

    try {
      const queueRes = await toolkitFetch(cfg, "/api/queue", { method: "GET" }, fetchFn);
      if (queueRes.ok) {
        const body = (await queueRes.json()) as { queues?: ToolkitQueueSummary[] };
        queues = body.queues;
      }
    } catch {
      // optional
    }

    return { api_reachable: true, gpu, jobs, queues };
  } catch {
    return { api_reachable: false };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function toolkitStatus(
  opts: { action?: ToolkitStatusAction } = {},
  deps: ToolkitDeps = {},
): Promise<ToolkitStatusResult> {
  const action = opts.action ?? "probe";
  const cfg = resolveToolkitConfig();
  const findPid = deps.findPidByPort ?? defaultFindPidByPort;
  const pid = findPid(cfg.port);
  const running = pid !== null;

  if (action === "stop") {
    const stopped = await stopToolkitProcess(cfg.port);
    return {
      action,
      running: false,
      port: cfg.port,
      pid: null,
      base_url: cfg.baseUrl,
      root: cfg.root,
      api_reachable: false,
      stopped,
      message: stopped
        ? `AI Toolkit stopped on port ${cfg.port}`
        : `No process listening on port ${cfg.port}`,
    };
  }

  if (action === "start") {
    if (running) {
      const probe = await probeToolkitApi(cfg, deps);
      return {
        action,
        running: true,
        port: cfg.port,
        pid,
        base_url: cfg.baseUrl,
        root: cfg.root,
        started: false,
        api_reachable: probe.api_reachable,
        gpu: probe.gpu,
        jobs: probe.jobs,
        queues: probe.queues,
        message: `AI Toolkit already running on port ${cfg.port} (PID ${pid})`,
      };
    }

    spawnToolkitUi(cfg);
    const ready = await waitForApiReady(cfg, deps);
    const newPid = findPid(cfg.port);
    const probe = ready ? await probeToolkitApi(cfg, deps) : { api_reachable: false };

    return {
      action,
      running: newPid !== null,
      port: cfg.port,
      pid: newPid,
      base_url: cfg.baseUrl,
      root: cfg.root,
      started: ready,
      api_reachable: probe.api_reachable,
      gpu: probe.gpu,
      jobs: probe.jobs,
      queues: probe.queues,
      message: ready
        ? `AI Toolkit started on ${cfg.baseUrl}`
        : `AI Toolkit process launched but API not ready on ${cfg.baseUrl}. Check ui/ build (npm run build_and_start) and logs.`,
    };
  }

  if (action === "restart") {
    await stopToolkitProcess(cfg.port);
    await sleep(1000);
    return toolkitStatus({ action: "start" }, deps);
  }

  const probe = running
    ? await probeToolkitApi(cfg, deps)
    : { api_reachable: false as const };

  return {
    action: "probe",
    running,
    port: cfg.port,
    pid,
    base_url: cfg.baseUrl,
    root: cfg.root,
    api_reachable: probe.api_reachable,
    gpu: probe.gpu,
    jobs: probe.jobs,
    queues: probe.queues,
    message: running
      ? probe.api_reachable
        ? `AI Toolkit API reachable at ${cfg.baseUrl}`
        : `Process on port ${cfg.port} but API not responding at ${cfg.baseUrl}`
      : `AI Toolkit not running on port ${cfg.port}`,
  };
}

function resolveConfigPath(root: string, configPath: string): string {
  const resolved = isAbsolute(configPath)
    ? resolve(configPath)
    : resolve(root, configPath);
  if (!existsSync(resolved)) {
    throw new ValidationError(`config_path not found: ${resolved}`);
  }
  return resolved;
}

async function loadJobConfig(
  root: string,
  input: ToolkitRunJobInput,
): Promise<unknown> {
  if (input.config_path) {
    const path = resolveConfigPath(root, input.config_path);
    const raw = await readFile(path, "utf-8");
    return parseYaml(raw);
  }
  if (input.job_config !== undefined) {
    return input.job_config;
  }
  throw new ValidationError("Provide job_config (object) or config_path (yaml file under AI Toolkit root).");
}

function extractModelFields(doc: unknown): Pick<ToolkitModelExample, "name" | "arch" | "model_name_or_path" | "job_type"> {
  if (!doc || typeof doc !== "object") return {};
  const root = doc as Record<string, unknown>;
  const job = typeof root.job === "string" ? root.job : undefined;
  const config =
    root.config && typeof root.config === "object"
      ? (root.config as Record<string, unknown>)
      : undefined;
  const name =
    typeof config?.name === "string"
      ? config.name
      : typeof root.name === "string"
        ? root.name
        : undefined;

  const processes = config?.process;
  if (!Array.isArray(processes)) {
    return { name, job_type: job };
  }

  for (const proc of processes) {
    if (!proc || typeof proc !== "object") continue;
    const model = (proc as Record<string, unknown>).model;
    if (!model || typeof model !== "object") continue;
    const m = model as Record<string, unknown>;
    return {
      name,
      job_type: job,
      arch: typeof m.arch === "string" ? m.arch : undefined,
      model_name_or_path:
        typeof m.name_or_path === "string" ? m.name_or_path : undefined,
    };
  }

  return { name, job_type: job };
}

export async function toolkitListModels(
  deps: ToolkitDeps = {},
): Promise<ToolkitListModelsResult> {
  void deps;
  const cfg = resolveToolkitConfig();
  const examplesDir = join(cfg.root, "config", "examples");
  if (!existsSync(examplesDir)) {
    throw new ValidationError(
      `AI Toolkit examples directory not found: ${examplesDir}`,
    );
  }

  const models: ToolkitModelExample[] = [];
  for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ya?ml)$/i.test(entry.name)) continue;
    const relPath = join("config", "examples", entry.name);
    const fullPath = join(examplesDir, entry.name);
    try {
      const raw = await readFile(fullPath, "utf-8");
      const doc = parseYaml(raw);
      models.push({
        file: entry.name,
        rel_path: relPath.replace(/\\/g, "/"),
        ...extractModelFields(doc),
      });
    } catch (err) {
      logger.warn("Skipping unreadable toolkit example config", {
        file: entry.name,
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  models.sort((a, b) => a.file.localeCompare(b.file));
  return { root: cfg.root, examples_dir: examplesDir, models };
}

export async function toolkitRunJob(
  input: ToolkitRunJobInput,
  deps: ToolkitDeps = {},
): Promise<ToolkitRunJobResult> {
  const fetchFn = deps.fetch ?? fetch;
  const cfg = resolveToolkitConfig();

  if (!input.name?.trim()) {
    throw new ValidationError("name is required");
  }

  const jobConfig = await loadJobConfig(cfg.root, input);
  const gpuIds =
    input.gpu_ids?.trim() ||
    (platform() === "darwin" ? "mps" : "0");

  const createRes = await toolkitFetch(
    cfg,
    "/api/jobs",
    {
      method: "POST",
      body: JSON.stringify({
        name: input.name.trim(),
        job_config: jobConfig,
        gpu_ids: gpuIds,
        ...(input.job_type ? { job_type: input.job_type } : {}),
      }),
    },
    fetchFn,
  );
  const created = await readJson<{ id: string; name: string; gpu_ids: string; status?: string }>(
    createRes,
  );

  const startRes = await toolkitFetch(
    cfg,
    `/api/jobs/${created.id}/start`,
    { method: "GET" },
    fetchFn,
  );
  await readJson(startRes);

  const queueRes = await toolkitFetch(
    cfg,
    `/api/queue/${encodeURIComponent(gpuIds)}/start`,
    { method: "GET" },
    fetchFn,
  );
  await readJson(queueRes);

  return {
    job_id: created.id,
    name: created.name,
    gpu_ids: created.gpu_ids ?? gpuIds,
    status: "queued",
    queue_started: true,
    message: `Job "${created.name}" created and queued on GPU ${created.gpu_ids ?? gpuIds}`,
  };
}

export const __toolkitSupervisorTestHooks = {
  reset(): void {
    detachSupervisedChild();
  },
  setSupervisedChild(child: ChildProcess | null): void {
    supervisedChild = child;
  },
  getSupervisedChild(): ChildProcess | null {
    return supervisedChild;
  },
  getLastSpawnRoot(): string | null {
    return lastSpawnRoot;
  },
};