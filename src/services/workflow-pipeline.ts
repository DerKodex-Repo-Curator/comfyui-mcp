import { existsSync, readFileSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  backfillObjectInfo,
  getHistory,
  getObjectInfo,
  type HistoryEntry,
} from "../comfyui/client.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { ValidationError, WorkflowExecutionError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { applyReferenceToWorkflow, type ReferenceRole } from "./apply-reference.js";
import { applyOverrides } from "./asset-registry.js";
import { stageOutputAsInput, uploadImageAuto } from "./image-management.js";
import { enqueueWorkflow } from "./workflow-executor.js";
import { getJobStatus } from "./queue-manager.js";
import {
  collectNodeTypes,
  convertUiToApi,
  isUiFormat,
} from "./workflow-converter.js";

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

const referenceRoleSchema = z.enum(["primary", "reference", "control", "mask", "auto"]);

const stageSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    workflow: z.string().min(1),
    pin: z.string().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    node_inputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    assets: z.record(z.string(), referenceRoleSchema).optional(),
    chain_from: z.string().optional(),
    chain_role: referenceRoleSchema.optional(),
    chain_node_id: z.string().optional(),
    chain_input_name: z.string().optional(),
    wait: z.boolean().optional(),
    timeout_seconds: z.number().int().positive().optional(),
    output_node_id: z.string().optional(),
    disable_random_seed: z.boolean().optional(),
    extra_data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const projectSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    assets: z.record(z.string(), z.string()).optional(),
    stages: z.array(stageSchema).min(1),
  })
  .strict();

export type WorkflowProjectManifest = z.infer<typeof projectSchema>;
export type WorkflowPipelineStage = z.infer<typeof stageSchema>;

export interface WorkflowPipelineInput {
  project_path?: string;
  project_yaml?: string;
  start_at?: string;
  stop_at?: string;
  dry_run?: boolean;
  default_timeout_seconds?: number;
}

export interface StageOutputRef {
  filename: string;
  subfolder: string;
  type: string;
  kind: string;
  staged_filename?: string;
}

export interface PipelineStageResult {
  id: string;
  name?: string;
  pin?: string;
  workflow_source: string;
  workflow_path: string;
  prompt_id?: string;
  status: "planned" | "enqueued" | "completed" | "failed" | "skipped";
  waited: boolean;
  output?: StageOutputRef;
  error?: string;
  message?: string;
}

export interface WorkflowPipelineResult {
  project_name: string;
  description?: string;
  dry_run: boolean;
  assets_loaded: Record<string, string>;
  stages: PipelineStageResult[];
  completed: number;
  failed: number;
  message: string;
}

export interface WorkflowPipelineDeps {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  enqueue?: typeof enqueueWorkflow;
  getJobStatus?: typeof getJobStatus;
  getHistory?: typeof getHistory;
  getObjectInfo?: typeof getObjectInfo;
  backfillObjectInfo?: typeof backfillObjectInfo;
  uploadAsset?: typeof uploadImageAuto;
  stageOutput?: typeof stageOutputAsInput;
  sleep?: (ms: number) => Promise<void>;
}

const SAFE_PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const YAML_MAX_ALIAS_COUNT = 50;
const DEFAULT_STAGE_TIMEOUT_S = 1800;

// ---------------------------------------------------------------------------
// Pack / workflow resolution
// ---------------------------------------------------------------------------

function packsDir(): string {
  return fileURLToPath(new URL("../../packs", import.meta.url));
}

function resolveProjectPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new ValidationError("project_path is empty");
  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(process.cwd(), trimmed);
  if (!existsSync(resolved)) {
    throw new ValidationError(`Project manifest not found: ${resolved}`);
  }
  return resolved;
}

async function loadManifestText(
  input: WorkflowPipelineInput,
  readFile: WorkflowPipelineDeps["readFile"],
): Promise<{ raw: string; source: string }> {
  if (input.project_yaml?.trim()) {
    return { raw: input.project_yaml, source: "(inline yaml)" };
  }
  if (input.project_path?.trim()) {
    const path = resolveProjectPath(input.project_path);
    const raw = await readFile!(path, "utf-8");
    return { raw, source: path };
  }
  throw new ValidationError("Provide project_path or project_yaml.");
}

export function parseProjectManifest(raw: string): WorkflowProjectManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, { maxAliasCount: YAML_MAX_ALIAS_COUNT });
  } catch (err) {
    throw new ValidationError(
      `Invalid project YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = projectSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      `Project manifest validation failed: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

function parseWorkflowRef(ref: string): { kind: "pack" | "path"; value: string } {
  const trimmed = ref.trim();
  if (trimmed.startsWith("pack:")) {
    return { kind: "pack", value: trimmed.slice("pack:".length).trim() };
  }
  if (trimmed.startsWith("path:")) {
    return { kind: "path", value: trimmed.slice("path:".length).trim() };
  }
  if (SAFE_PACK_NAME.test(trimmed) && existsSync(join(packsDir(), trimmed, "pack.yaml"))) {
    return { kind: "pack", value: trimmed };
  }
  return { kind: "path", value: trimmed };
}

function resolvePackWorkflowPath(packName: string): string {
  const name = packName.trim();
  if (!SAFE_PACK_NAME.test(name)) {
    throw new ValidationError(`Invalid pack name "${packName}"`);
  }
  const root = packsDir();
  const packDir = join(root, name);
  if (!packDir.startsWith(root) || !existsSync(packDir)) {
    throw new ValidationError(`Pack not found: ${name}`);
  }
  let workflowName = "workflow.json";
  const metaFile = join(packDir, "pack.yaml");
  if (existsSync(metaFile)) {
    try {
      const meta = parseYaml(readFileSync(metaFile, "utf-8"), {
        maxAliasCount: YAML_MAX_ALIAS_COUNT,
      }) as Record<string, unknown>;
      if (typeof meta.workflow === "string") workflowName = meta.workflow;
    } catch {
      // keep default
    }
  }
  const wfFile = join(packDir, workflowName);
  if (!existsSync(wfFile)) {
    throw new ValidationError(`Pack "${name}" has no workflow file (${workflowName})`);
  }
  return wfFile;
}

async function resolveWorkflowFilePath(ref: string): Promise<{ source: string; path: string }> {
  const parsed = parseWorkflowRef(ref);
  if (parsed.kind === "pack") {
    const path = resolvePackWorkflowPath(parsed.value);
    return { source: `pack:${parsed.value}`, path };
  }
  const path = isAbsolute(parsed.value)
    ? resolve(parsed.value)
    : resolve(process.cwd(), parsed.value);
  if (!existsSync(path)) {
    throw new ValidationError(`Workflow file not found: ${path}`);
  }
  return { source: `path:${parsed.value}`, path };
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

async function loadWorkflowApi(
  ref: string,
  deps: Required<Pick<WorkflowPipelineDeps, "readFile" | "getObjectInfo" | "backfillObjectInfo">>,
): Promise<{ workflow: WorkflowJSON; source: string; path: string }> {
  const { source, path } = await resolveWorkflowFilePath(ref);
  const raw = await deps.readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(`Workflow is not valid JSON: ${path}`);
  }
  const unwrapped = unwrapPromptBody(parsed);
  if (isApiWorkflow(unwrapped)) {
    return { workflow: unwrapped, source, path };
  }
  if (isUiFormat(unwrapped)) {
    const bulk = await deps.getObjectInfo();
    const objectInfo = await deps.backfillObjectInfo(bulk, collectNodeTypes(unwrapped));
    const { workflow, warnings } = convertUiToApi(unwrapped as never, objectInfo);
    if (warnings.length > 0) {
      logger.warn("Pipeline UI→API conversion warnings", { path, warnings });
    }
    return { workflow, source, path };
  }
  throw new ValidationError(`Workflow must be UI or API format: ${path}`);
}

function applyNodeInputs(
  workflow: WorkflowJSON,
  nodeInputs?: Record<string, Record<string, unknown>>,
): WorkflowJSON {
  if (!nodeInputs) return workflow;
  const copy = JSON.parse(JSON.stringify(workflow)) as WorkflowJSON;
  for (const [nodeId, inputs] of Object.entries(nodeInputs)) {
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      throw new ValidationError(`node_inputs.${nodeId} must be an object`);
    }
    const node = copy[nodeId];
    if (!node) {
      throw new ValidationError(`node_inputs.${nodeId}: node does not exist in workflow`);
    }
    node.inputs = { ...(node.inputs ?? {}), ...inputs };
  }
  return copy;
}

function filterStages(
  stages: WorkflowPipelineStage[],
  startAt?: string,
  stopAt?: string,
): WorkflowPipelineStage[] {
  let list = stages;
  if (startAt) {
    const idx = list.findIndex((s) => s.id === startAt);
    if (idx < 0) throw new ValidationError(`start_at stage not found: ${startAt}`);
    list = list.slice(idx);
  }
  if (stopAt) {
    const idx = list.findIndex((s) => s.id === stopAt);
    if (idx < 0) throw new ValidationError(`stop_at stage not found: ${stopAt}`);
    list = list.slice(0, idx + 1);
  }
  return list;
}

async function loadSharedAssets(
  assets: Record<string, string> | undefined,
  projectDir: string | undefined,
  deps: Required<Pick<WorkflowPipelineDeps, "uploadAsset">>,
): Promise<Record<string, string>> {
  const loaded: Record<string, string> = {};
  if (!assets) return loaded;
  for (const [key, rawPath] of Object.entries(assets)) {
    const path = isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(projectDir ?? process.cwd(), rawPath);
    if (!existsSync(path)) {
      throw new ValidationError(`Shared asset "${key}" not found: ${path}`);
    }
    const uploaded = await deps.uploadAsset(path, basename(path));
    loaded[key] = uploaded.filename;
  }
  return loaded;
}

function pickHistoryOutput(
  entry: HistoryEntry,
  outputNodeId?: string,
): { filename: string; subfolder: string; type: string } | null {
  const outputs = entry.outputs;
  if (!outputs || typeof outputs !== "object") return null;

  const nodeIds = outputNodeId ? [outputNodeId] : Object.keys(outputs);
  for (const nodeId of nodeIds) {
    const nodeOut = outputs[nodeId];
    if (!nodeOut || typeof nodeOut !== "object") continue;
    const record = nodeOut as Record<string, unknown>;
    for (const key of ["images", "videos", "video", "gifs"] as const) {
      const arr = record[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const media = item as { filename?: unknown; subfolder?: unknown; type?: unknown };
        if (typeof media.filename !== "string" || !media.filename) continue;
        return {
          filename: media.filename,
          subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
          type: typeof media.type === "string" ? media.type : "output",
        };
      }
    }
  }
  return null;
}

async function waitForStageCompletion(
  promptId: string,
  timeoutSeconds: number,
  deps: Required<Pick<WorkflowPipelineDeps, "getJobStatus" | "sleep">>,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const status = await deps.getJobStatus(promptId);
    if (status.done) {
      if (status.error?.exception_message) {
        throw new WorkflowExecutionError(
          `Stage failed: ${status.error.exception_message}`,
          status.error,
        );
      }
      return;
    }
    await deps.sleep(2000);
  }
  throw new ValidationError(`Timed out after ${timeoutSeconds}s waiting for prompt ${promptId}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runWorkflowPipeline(
  input: WorkflowPipelineInput,
  deps: WorkflowPipelineDeps = {},
): Promise<WorkflowPipelineResult> {
  const readFile = deps.readFile ?? fsReadFile;
  const enqueue = deps.enqueue ?? enqueueWorkflow;
  const jobStatus = deps.getJobStatus ?? getJobStatus;
  const historyFn = deps.getHistory ?? getHistory;
  const objectInfoFn = deps.getObjectInfo ?? getObjectInfo;
  const backfillFn = deps.backfillObjectInfo ?? backfillObjectInfo;
  const uploadAsset = deps.uploadAsset ?? uploadImageAuto;
  const stageOutput = deps.stageOutput ?? stageOutputAsInput;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const { raw, source } = await loadManifestText(input, readFile);
  const manifest = parseProjectManifest(raw);
  const stages = filterStages(manifest.stages, input.start_at, input.stop_at);
  const projectDir = input.project_path
    ? dirname(resolveProjectPath(input.project_path))
    : undefined;

  const defaultTimeout = input.default_timeout_seconds ?? DEFAULT_STAGE_TIMEOUT_S;
  const dryRun = !!input.dry_run;

  const assetsLoaded = dryRun
    ? Object.fromEntries(Object.entries(manifest.assets ?? {}).map(([k, v]) => [k, v]))
    : await loadSharedAssets(manifest.assets, projectDir, { uploadAsset });

  const stageResults: PipelineStageResult[] = [];
  const outputsByStage = new Map<string, StageOutputRef>();
  let completed = 0;
  let failed = 0;

  for (const stage of stages) {
    const base: PipelineStageResult = {
      id: stage.id,
      name: stage.name,
      pin: stage.pin,
      workflow_source: stage.workflow,
      workflow_path: "",
      status: dryRun ? "planned" : "enqueued",
      waited: false,
    };

    try {
      const loaded = await loadWorkflowApi(stage.workflow, {
        readFile,
        getObjectInfo: objectInfoFn,
        backfillObjectInfo: backfillFn,
      });
      base.workflow_path = loaded.path;
      base.workflow_source = loaded.source;

      if (dryRun) {
        stageResults.push({
          ...base,
          message: `Would run ${loaded.source} (${loaded.path})`,
        });
        continue;
      }

      let workflow = applyOverrides(loaded.workflow, stage.inputs);
      workflow = applyNodeInputs(workflow, stage.node_inputs);

      if (stage.assets) {
        for (const [assetKey, role] of Object.entries(stage.assets)) {
          const filename = assetsLoaded[assetKey];
          if (!filename) {
            throw new ValidationError(
              `Stage "${stage.id}" references unknown asset "${assetKey}"`,
            );
          }
          const patched = applyReferenceToWorkflow({
            workflow,
            image_filename: filename,
            role: role as ReferenceRole,
            apply_all_matching: role !== "primary",
          });
          workflow = patched.workflow;
        }
      }

      if (stage.chain_from) {
        const prev = outputsByStage.get(stage.chain_from);
        if (!prev?.staged_filename) {
          throw new ValidationError(
            `chain_from "${stage.chain_from}" has no staged output yet`,
          );
        }
        const patched = applyReferenceToWorkflow({
          workflow,
          image_filename: prev.staged_filename,
          role: (stage.chain_role ?? "primary") as ReferenceRole,
          node_id: stage.chain_node_id,
          input_name: stage.chain_input_name,
        });
        workflow = patched.workflow;
      }

      const enqueued = await enqueue(workflow, {
        disable_random_seed: stage.disable_random_seed,
        extra_data: stage.extra_data,
      });
      base.prompt_id = enqueued.prompt_id;

      const shouldWait = stage.wait !== false;
      if (shouldWait) {
        const timeout = stage.timeout_seconds ?? defaultTimeout;
        await waitForStageCompletion(enqueued.prompt_id, timeout, {
          getJobStatus: jobStatus,
          sleep,
        });
        base.waited = true;
        base.status = "completed";

        const history = await historyFn(enqueued.prompt_id);
        const entry = history[enqueued.prompt_id];
        if (entry) {
          const picked = pickHistoryOutput(entry, stage.output_node_id);
          if (picked) {
            const staged = await stageOutput({
              filename: picked.filename,
              subfolder: picked.subfolder,
              type: picked.type === "temp" ? "temp" : "output",
            });
            const output: StageOutputRef = {
              filename: picked.filename,
              subfolder: picked.subfolder,
              type: picked.type,
              kind: staged.kind,
              staged_filename: staged.filename,
            };
            base.output = output;
            outputsByStage.set(stage.id, output);
          }
        }
        completed += 1;
        base.message = `Completed prompt ${enqueued.prompt_id}`;
      } else {
        base.status = "enqueued";
        base.message = `Enqueued prompt ${enqueued.prompt_id} (wait=false)`;
      }

      stageResults.push(base);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      stageResults.push({
        ...base,
        status: "failed",
        error: message,
        message,
      });
      break;
    }
  }

  const ranCount = stageResults.filter((s) => s.status !== "planned").length;
  const message = dryRun
    ? `Dry run: ${stages.length} stage(s) in project "${manifest.name}" from ${source}`
    : failed > 0
      ? `Pipeline "${manifest.name}" stopped after ${failed} failure (${completed}/${ranCount} completed)`
      : `Pipeline "${manifest.name}" finished (${completed} stage(s) completed)`;

  return {
    project_name: manifest.name,
    description: manifest.description,
    dry_run: dryRun,
    assets_loaded: assetsLoaded,
    stages: stageResults,
    completed,
    failed,
    message,
  };
}

