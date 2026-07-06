import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  convertUiToApi,
  isUiFormat,
} from "./workflow-converter.js";
import type { ObjectInfo, WorkflowJSON } from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunComfyServerType =
  | "medium"
  | "large"
  | "extra-large"
  | "2x-large"
  | "2xl-turbo";

export interface RunComfyConfig {
  apiKey: string;
  userId: string;
  apiBase: string;
}

export interface RunComfyWorkflowVersion {
  version_id: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface RunComfyWorkflowSummary {
  workflow_id: string;
  name: string;
  latest_version_id?: string;
  versions: RunComfyWorkflowVersion[];
  [key: string]: unknown;
}

export interface RunComfyServerSummary {
  server_id: string;
  current_status?: string;
  main_service_url?: string;
  service_ready_at?: string;
  workflow_version_id?: string;
  server_type?: RunComfyServerType | string;
  estimated_duration?: number;
  [key: string]: unknown;
}

export interface RunComfyListPodsResult {
  user_id: string;
  api_base: string;
  servers: RunComfyServerSummary[];
  count: number;
}

export interface RunComfyLocalWorkflowMatch {
  path: string;
  name_guess?: string;
  content_hash: string;
  matched_workflow_id?: string;
  matched_workflow_name?: string;
  matched_version_id?: string;
}

export interface RunComfySyncWorkflowResult {
  user_id: string;
  api_base: string;
  workflows: RunComfyWorkflowSummary[];
  count: number;
  local_match?: RunComfyLocalWorkflowMatch;
  message?: string;
}

export interface RunComfyQueueInput {
  server_id?: string;
  main_service_url?: string;
  workflow?: Record<string, unknown>;
  workflow_path?: string;
  workflow_version_id?: string;
  server_type?: RunComfyServerType;
  estimated_duration?: number;
  launch_if_needed?: boolean;
  wait_ready_seconds?: number;
  extra_data?: Record<string, unknown>;
  front?: boolean;
}

export interface RunComfyQueueResult {
  server_id?: string;
  main_service_url: string;
  prompt_id: string;
  queue_remaining?: number;
  launched?: boolean;
  message: string;
}

export interface RunComfyDeps {
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = "https://beta-api.runcomfy.net";

export function resolveRunComfyConfig(): RunComfyConfig {
  const apiKey = process.env.RUNCOMFY_API_KEY?.trim();
  if (!apiKey) {
    throw new ValidationError(
      "RUNCOMFY_API_KEY is required (Bearer token from RunComfy dashboard).",
    );
  }

  const userId = process.env.RUNCOMFY_USER_ID?.trim();
  if (!userId) {
    throw new ValidationError(
      "RUNCOMFY_USER_ID is required (your RunComfy user UUID for Server API paths).",
    );
  }

  const apiBase =
    process.env.RUNCOMFY_API_BASE?.trim().replace(/\/$/, "") || DEFAULT_API_BASE;

  return { apiKey, userId, apiBase };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(cfg: RunComfyConfig): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };
}

async function runComfyFetch(
  cfg: RunComfyConfig,
  path: string,
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const url = `${cfg.apiBase}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    ...authHeaders(cfg),
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetchFn(url, { ...init, headers });
}

async function readJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = parsed.message || parsed.error || text;
    } catch {
      // use raw text
    }
    throw new ValidationError(
      `RunComfy ${context} ${res.status}: ${detail || res.statusText}`,
    );
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function userPath(cfg: RunComfyConfig, suffix: string): string {
  return `/prod/api/users/${encodeURIComponent(cfg.userId)}${suffix}`;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return [];
}

function normalizeWorkflows(body: unknown): RunComfyWorkflowSummary[] {
  const raw = asArray<Record<string, unknown>>(body);
  if (raw.length === 0 && body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const fromWorkflows = asArray<Record<string, unknown>>(record.workflows);
    const nested =
      fromWorkflows.length > 0
        ? fromWorkflows
        : asArray<Record<string, unknown>>(record.data);
    if (nested.length > 0) return normalizeWorkflows(nested);
  }

  return raw.map((item) => {
    const versions = asArray<RunComfyWorkflowVersion>(item.versions);
    const latest =
      typeof item.latest_version_id === "string"
        ? item.latest_version_id
        : typeof item.workflow_version_id === "string"
          ? item.workflow_version_id
          : versions[0]?.version_id;
    return {
      ...item,
      workflow_id: String(item.workflow_id ?? item.id ?? ""),
      name: String(item.name ?? item.workflow_name ?? "unnamed"),
      latest_version_id: latest,
      versions,
    } as RunComfyWorkflowSummary;
  });
}

function normalizeServers(body: unknown): RunComfyServerSummary[] {
  const raw = asArray<Record<string, unknown>>(body);
  if (raw.length === 0 && body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const fromServers = asArray<Record<string, unknown>>(record.servers);
    const nested =
      fromServers.length > 0
        ? fromServers
        : asArray<Record<string, unknown>>(record.data);
    if (nested.length > 0) return normalizeServers(nested);
    if (record.server_id || record.id) {
      return normalizeServers([record]);
    }
  }

  return raw.map((item) => ({
    ...item,
    server_id: String(item.server_id ?? item.id ?? ""),
    main_service_url:
      typeof item.main_service_url === "string"
        ? item.main_service_url.replace(/\/$/, "")
        : undefined,
  })) as RunComfyServerSummary[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function workflowNameGuess(path: string, parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.trim()) {
      return record.name.trim();
    }
  }
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.(json|png)$/i, "").replace(/[-_]/g, " ").trim() || undefined;
}

function hashWorkflowContent(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function isApiWorkflow(obj: unknown): obj is WorkflowJSON {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const values = Object.values(obj as Record<string, unknown>);
  if (values.length === 0) return false;
  return values.every(
    (v) =>
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      "class_type" in (v as Record<string, unknown>),
  );
}

function unwrapPromptBody(json: unknown): unknown {
  if (
    json != null &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    "prompt" in (json as Record<string, unknown>)
  ) {
    const prompt = (json as Record<string, unknown>).prompt;
    if (isApiWorkflow(prompt)) return prompt;
  }
  return json;
}

async function loadWorkflowFromPath(path: string): Promise<{
  path: string;
  raw: string;
  parsed: unknown;
}> {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new ValidationError(`workflow_path not found: ${resolved}`);
  }
  const raw = await readFile(resolved, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(`workflow_path is not valid JSON: ${resolved}`);
  }
  return { path: resolved, raw, parsed: unwrapPromptBody(parsed) };
}

async function resolveApiWorkflow(
  input: RunComfyQueueInput,
  serviceUrl: string,
  deps: RunComfyDeps,
): Promise<WorkflowJSON> {
  const fetchFn = deps.fetch ?? fetch;

  if (input.workflow) {
    const unwrapped = unwrapPromptBody(input.workflow);
    if (isApiWorkflow(unwrapped)) return unwrapped;
    if (isUiFormat(unwrapped)) {
      return convertWorkflowForRemote(unwrapped, serviceUrl, fetchFn);
    }
    throw new ValidationError(
      "workflow must be ComfyUI API format (class_type + inputs) or UI format (nodes + links).",
    );
  }

  if (input.workflow_path) {
    const loaded = await loadWorkflowFromPath(input.workflow_path);
    if (isApiWorkflow(loaded.parsed)) {
      return loaded.parsed;
    }
    if (isUiFormat(loaded.parsed)) {
      return convertWorkflowForRemote(loaded.parsed, serviceUrl, fetchFn);
    }
    throw new ValidationError(
      `workflow_path must contain API or UI workflow JSON: ${loaded.path}`,
    );
  }

  throw new ValidationError("Provide workflow (object) or workflow_path for runcomfy_queue.");
}

async function convertWorkflowForRemote(
  uiWorkflow: unknown,
  serviceUrl: string,
  fetchFn: typeof fetch,
): Promise<WorkflowJSON> {
  const objectInfo = await fetchRemoteObjectInfo(serviceUrl, fetchFn);
  const { workflow, warnings } = convertUiToApi(uiWorkflow as never, objectInfo);
  if (warnings.length > 0) {
    logger.warn("RunComfy UI→API conversion warnings", { warnings });
  }
  return workflow;
}

async function fetchRemoteObjectInfo(
  serviceUrl: string,
  fetchFn: typeof fetch,
): Promise<ObjectInfo> {
  const url = `${serviceUrl.replace(/\/$/, "")}/object_info`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ValidationError(
      `Remote ComfyUI object_info ${res.status}: ${body.slice(0, 300) || res.statusText}`,
    );
  }
  return (await res.json()) as ObjectInfo;
}

async function enqueueOnRemotePod(
  serviceUrl: string,
  workflow: WorkflowJSON,
  opts: { extra_data?: Record<string, unknown>; front?: boolean },
  fetchFn: typeof fetch,
): Promise<{ prompt_id: string; queue_remaining?: number }> {
  const url = `${serviceUrl.replace(/\/$/, "")}/prompt`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: workflow,
      client_id: "comfyui-mcp-runcomfy",
      ...(opts.extra_data ? { extra_data: opts.extra_data } : {}),
      ...(opts.front ? { front: true } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ValidationError(
      `Remote ComfyUI /prompt ${res.status}: ${body.slice(0, 500) || res.statusText}`,
    );
  }
  const data = (await res.json()) as { prompt_id?: string; number?: number };
  if (!data.prompt_id) {
    throw new ValidationError("Remote ComfyUI /prompt did not return prompt_id.");
  }
  return { prompt_id: data.prompt_id, queue_remaining: data.number };
}

function findWorkflowMatch(
  workflows: RunComfyWorkflowSummary[],
  nameGuess?: string,
): { workflow?: RunComfyWorkflowSummary; version_id?: string } {
  if (!nameGuess) return {};
  const needle = nameGuess.toLowerCase();
  for (const wf of workflows) {
    const wfName = wf.name.toLowerCase();
    if (wfName === needle || wfName.includes(needle) || needle.includes(wfName)) {
      return {
        workflow: wf,
        version_id: wf.latest_version_id ?? wf.versions[0]?.version_id,
      };
    }
  }
  return {};
}

async function getServer(
  cfg: RunComfyConfig,
  serverId: string,
  fetchFn: typeof fetch,
): Promise<RunComfyServerSummary> {
  const res = await runComfyFetch(
    cfg,
    userPath(cfg, `/servers/${encodeURIComponent(serverId)}`),
    { method: "GET" },
    fetchFn,
  );
  const body = await readJson<Record<string, unknown>>(res, "get server");
  const servers = normalizeServers(body.server ? [body.server] : body);
  const server = servers[0];
  if (!server?.server_id) {
    throw new ValidationError(`RunComfy server not found: ${serverId}`);
  }
  return server;
}

async function launchServer(
  cfg: RunComfyConfig,
  input: {
    workflow_version_id: string;
    server_type?: RunComfyServerType;
    estimated_duration?: number;
  },
  fetchFn: typeof fetch,
): Promise<RunComfyServerSummary> {
  const res = await runComfyFetch(
    cfg,
    userPath(cfg, "/servers"),
    {
      method: "POST",
      body: JSON.stringify({
        workflow_version_id: input.workflow_version_id,
        server_type: input.server_type ?? "medium",
        estimated_duration: input.estimated_duration ?? 3600,
      }),
    },
    fetchFn,
  );
  const body = await readJson<Record<string, unknown>>(res, "launch server");
  const servers = normalizeServers(body.server ? [body.server] : body);
  const server = servers[0];
  if (!server?.server_id) {
    throw new ValidationError("RunComfy launch did not return a server_id.");
  }
  return server;
}

async function waitForServerReady(
  cfg: RunComfyConfig,
  serverId: string,
  timeoutSeconds: number,
  fetchFn: typeof fetch,
): Promise<RunComfyServerSummary> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: RunComfyServerSummary | undefined;
  while (Date.now() < deadline) {
    last = await getServer(cfg, serverId, fetchFn);
    const url = last.main_service_url;
    const status = (last.current_status ?? "").toLowerCase();
    if (url && (status.includes("ready") || status.includes("running") || last.service_ready_at)) {
      try {
        const probe = await fetchFn(`${url}/system_stats`, { method: "GET" });
        if (probe.ok) return last;
      } catch {
        // not ready yet
      }
    }
    await sleep(3000);
  }
  throw new ValidationError(
    `RunComfy server ${serverId} not ready after ${timeoutSeconds}s` +
      (last?.current_status ? ` (status: ${last.current_status})` : ""),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runcomfyListPods(
  deps: RunComfyDeps = {},
): Promise<RunComfyListPodsResult> {
  const fetchFn = deps.fetch ?? fetch;
  const cfg = resolveRunComfyConfig();
  const res = await runComfyFetch(
    cfg,
    userPath(cfg, "/servers"),
    { method: "GET" },
    fetchFn,
  );
  const body = await readJson<unknown>(res, "list servers");
  const servers = normalizeServers(body);
  return {
    user_id: cfg.userId,
    api_base: cfg.apiBase,
    servers,
    count: servers.length,
  };
}

export async function runcomfySyncWorkflow(
  opts: {
    workflow_name?: string;
    local_workflow_path?: string;
  } = {},
  deps: RunComfyDeps = {},
): Promise<RunComfySyncWorkflowResult> {
  const fetchFn = deps.fetch ?? fetch;
  const cfg = resolveRunComfyConfig();
  const res = await runComfyFetch(
    cfg,
    userPath(cfg, "/workflows"),
    { method: "GET" },
    fetchFn,
  );
  const body = await readJson<unknown>(res, "list workflows");
  let workflows = normalizeWorkflows(body);

  const filter = opts.workflow_name?.trim().toLowerCase();
  if (filter) {
    workflows = workflows.filter((wf) => wf.name.toLowerCase().includes(filter));
  }

  const result: RunComfySyncWorkflowResult = {
    user_id: cfg.userId,
    api_base: cfg.apiBase,
    workflows,
    count: workflows.length,
  };

  if (opts.local_workflow_path) {
    const loaded = await loadWorkflowFromPath(opts.local_workflow_path);
    const nameGuess = workflowNameGuess(loaded.path, loaded.parsed);
    const match = findWorkflowMatch(workflows, nameGuess);
    result.local_match = {
      path: loaded.path,
      name_guess: nameGuess,
      content_hash: hashWorkflowContent(loaded.raw),
      matched_workflow_id: match.workflow?.workflow_id,
      matched_workflow_name: match.workflow?.name,
      matched_version_id: match.version_id,
    };
    if (match.version_id) {
      result.message = `Matched cloud workflow "${match.workflow?.name}" → version ${match.version_id}`;
    } else {
      result.message =
        "No cloud workflow name match for local file. Upload/sync in RunComfy UI, then re-run.";
    }
  }

  return result;
}

export async function runcomfyQueue(
  input: RunComfyQueueInput,
  deps: RunComfyDeps = {},
): Promise<RunComfyQueueResult> {
  const fetchFn = deps.fetch ?? fetch;
  const cfg = resolveRunComfyConfig();

  let server: RunComfyServerSummary | undefined;
  let launched = false;

  if (input.server_id) {
    server = await getServer(cfg, input.server_id, fetchFn);
  } else if (input.workflow_version_id && input.launch_if_needed !== false) {
    server = await launchServer(
      cfg,
      {
        workflow_version_id: input.workflow_version_id,
        server_type: input.server_type,
        estimated_duration: input.estimated_duration,
      },
      fetchFn,
    );
    launched = true;
    const waitSec = input.wait_ready_seconds ?? 180;
    server = await waitForServerReady(cfg, server.server_id, waitSec, fetchFn);
  }

  const serviceUrl =
    input.main_service_url?.replace(/\/$/, "") || server?.main_service_url;
  if (!serviceUrl) {
    throw new ValidationError(
      "Provide main_service_url, server_id (ready pod), or workflow_version_id with launch_if_needed to start a pod.",
    );
  }

  const workflow = await resolveApiWorkflow(input, serviceUrl, deps);
  const queued = await enqueueOnRemotePod(
    serviceUrl,
    workflow,
    { extra_data: input.extra_data, front: input.front },
    fetchFn,
  );

  return {
    server_id: server?.server_id ?? input.server_id,
    main_service_url: serviceUrl,
    prompt_id: queued.prompt_id,
    queue_remaining: queued.queue_remaining,
    launched,
    message: launched
      ? `Launched pod ${server?.server_id} and queued prompt ${queued.prompt_id}`
      : `Queued prompt ${queued.prompt_id} on ${serviceUrl}`,
  };
}