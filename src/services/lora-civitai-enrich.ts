import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config.js";
import { getLoraCatalog, type LoraCatalogEntry } from "./lora-catalog.js";
import { logger } from "../utils/logger.js";

const CIVITAI_API_BASE = "https://civitai.com/api/v1";

export interface CivitaiVersionDetails {
  id: number;
  modelId: number;
  name: string;
  description?: string;
  trainedWords?: string[];
  baseModel?: string;
  downloadUrl?: string;
  model?: {
    id: number;
    name: string;
    type?: string;
    tags?: string[];
    nsfw?: boolean;
  };
  images?: Array<{ url: string; width?: number; height?: number }>;
}

export interface LoraEnrichResult {
  scanned: number;
  enriched: number;
  skipped: number;
  failed: number;
  details: Array<{
    id: string;
    relPath: string;
    civitaiVersionId?: number;
    civitaiModelId?: number;
    displayName?: string;
    keywordsAdded?: number;
    error?: string;
  }>;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.civitaiApiToken) {
    headers.Authorization = `Bearer ${config.civitaiApiToken}`;
  }
  return headers;
}

async function civitaiGet<T>(path: string): Promise<T | null> {
  const url = `${CIVITAI_API_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`CivitAI enrich GET ${path} failed: ${res.status} ${body.slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn(`CivitAI enrich GET ${path} error`, {
      error: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

async function sha256Hex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function autov2FromSha256(sha256: string): string {
  return sha256.slice(0, 10).toUpperCase();
}

function resolveLoraAbsolutePath(relPath: string): string | null {
  if (!config.comfyuiPath) return null;
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const candidates = [
    join(config.comfyuiPath, "models", norm),
    join(config.comfyuiPath, norm.startsWith("models/") ? norm : `models/${norm}`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function fetchCivitaiVersionDetails(
  versionId: number,
): Promise<CivitaiVersionDetails | null> {
  return civitaiGet<CivitaiVersionDetails>(`/model-versions/${versionId}`);
}

async function lookupVersionByHash(autov2: string): Promise<CivitaiVersionDetails | null> {
  return civitaiGet<CivitaiVersionDetails>(`/model-versions/by-hash/${autov2}`);
}

function mergeEnrichment(
  entry: LoraCatalogEntry,
  version: CivitaiVersionDetails,
): { entry: LoraCatalogEntry; keywordsAdded: number } {
  const catalog = getLoraCatalog();
  const trained = (version.trainedWords ?? []).map((w) => w.trim()).filter(Boolean);
  const existingKw = new Set(entry.keywords.map((k) => k.toLowerCase()));
  const newKeywords = trained.filter((w) => !existingKw.has(w.toLowerCase()));
  const mergedKeywords = [...entry.keywords, ...newKeywords];

  const modelName = version.model?.name ?? version.name;
  const description =
    entry.description.trim() ||
    (version.description?.trim() ?? "") ||
    (modelName ? `CivitAI: ${modelName}` : entry.description);

  const baseModels = [...(entry.baseModels ?? [])];
  if (version.baseModel) {
    const b = version.baseModel.trim();
    if (b && !baseModels.some((x) => x.toLowerCase() === b.toLowerCase())) {
      baseModels.push(b);
    }
  }

  const tags = [...(entry.tags ?? [])];
  for (const t of version.model?.tags ?? []) {
    const tag = t.trim();
    if (tag && !tags.some((x) => x.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }

  const sourceUrl =
    entry.sourceUrl ??
    (version.modelId
      ? `https://civitai.com/models/${version.modelId}?modelVersionId=${version.id}`
      : undefined);

  const updated = catalog.upsert({
    id: entry.id,
    displayName: entry.displayName === defaultDisplayName(entry.relPath)
      ? (modelName || entry.displayName)
      : entry.displayName,
    description,
    keywords: mergedKeywords,
    baseModels,
    tags,
    civitaiModelId: version.modelId ?? version.model?.id ?? entry.civitaiModelId,
    civitaiVersionId: version.id,
    sourceUrl,
  });

  return { entry: updated, keywordsAdded: newKeywords.length };
}

function defaultDisplayName(relPath: string): string {
  const file = basename(relPath);
  return file.replace(/\.(safetensors|ckpt|pt|bin)$/i, "").replace(/_/g, " ");
}

function needsEnrich(entry: LoraCatalogEntry, force: boolean): boolean {
  if (entry.missing) return false;
  if (force) return true;
  return !entry.civitaiVersionId || !entry.keywords.length || !entry.description.trim();
}

/**
 * Backfill CivitAI metadata into the LoRA catalog via hash lookup + version API.
 * Requires COMFYUI_PATH so files can be hashed; CIVITAI_API_TOKEN recommended.
 */
export async function enrichLoraCatalogFromCivitai(opts: {
  limit?: number;
  force?: boolean;
  id_or_path?: string;
} = {}): Promise<LoraEnrichResult> {
  const catalog = getLoraCatalog();
  let entries = catalog.list({ includeMissing: false });
  if (opts.id_or_path?.trim()) {
    const one = catalog.get(opts.id_or_path.trim());
    entries = one && !one.missing ? [one] : [];
  } else {
    entries = entries.filter((e) => needsEnrich(e, !!opts.force));
  }
  if (typeof opts.limit === "number" && opts.limit > 0) {
    entries = entries.slice(0, opts.limit);
  }

  const result: LoraEnrichResult = {
    scanned: entries.length,
    enriched: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  if (!config.comfyuiPath) {
    for (const entry of entries) {
      result.failed++;
      result.details.push({
        id: entry.id,
        relPath: entry.relPath,
        error: "COMFYUI_PATH not set — cannot hash LoRA files for CivitAI lookup",
      });
    }
    return result;
  }

  for (const entry of entries) {
    if (entry.civitaiVersionId && !opts.force) {
      const cached = await fetchCivitaiVersionDetails(entry.civitaiVersionId);
      if (cached) {
        const { entry: updated, keywordsAdded } = mergeEnrichment(entry, cached);
        result.enriched++;
        result.details.push({
          id: updated.id,
          relPath: updated.relPath,
          civitaiVersionId: updated.civitaiVersionId,
          civitaiModelId: updated.civitaiModelId,
          displayName: updated.displayName,
          keywordsAdded,
        });
        await delay(400);
        continue;
      }
    }

    const abs = resolveLoraAbsolutePath(entry.relPath);
    if (!abs) {
      result.skipped++;
      result.details.push({
        id: entry.id,
        relPath: entry.relPath,
        error: "file not found on disk",
      });
      continue;
    }

    try {
      const sha = await sha256Hex(abs);
      const autov2 = autov2FromSha256(sha);
      const version = await lookupVersionByHash(autov2);
      if (!version) {
        result.skipped++;
        result.details.push({
          id: entry.id,
          relPath: entry.relPath,
          error: "no CivitAI match for file hash",
        });
        await delay(500);
        continue;
      }
      const full = (await fetchCivitaiVersionDetails(version.id)) ?? version;
      const { entry: updated, keywordsAdded } = mergeEnrichment(entry, full);
      result.enriched++;
      result.details.push({
        id: updated.id,
        relPath: updated.relPath,
        civitaiVersionId: updated.civitaiVersionId,
        civitaiModelId: updated.civitaiModelId,
        displayName: updated.displayName,
        keywordsAdded,
      });
    } catch (err) {
      result.failed++;
      result.details.push({
        id: entry.id,
        relPath: entry.relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await delay(500);
  }

  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}