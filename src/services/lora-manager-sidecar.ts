// Import curated metadata from ComfyUI LoRA Manager (willmiao) `.metadata.json` sidecars.
// Sidecars sit beside each model file and carry Civitai trigger words, usage_tips, previews, etc.
// See: https://github.com/willmiao/ComfyUI-Lora-Manager/blob/main/docs/metadata-json-schema.md

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { config } from "../config.js";
import {
  getLoraCatalog,
  loraIdFromPath,
  loraPreviewsDir,
  type LoraCatalogEntry,
} from "./lora-catalog.js";
import { logger } from "../utils/logger.js";

const LORA_MANAGER_REPO = "ComfyUI-Lora-Manager";
const LORA_MANAGER_NODE_NAMES = new Set([
  "ComfyUI-Lora-Manager",
  "comfyui-lora-manager",
  "ComfyUI LoRA Manager",
]);

export interface LoraManagerUsageTips {
  strength_min?: number;
  strength_max?: number;
  strength_range?: string;
  strength?: number;
  clip_strength?: number;
  clip_skip?: number;
}

export interface LoraManagerMetadata {
  file_name?: string;
  model_name?: string;
  file_path?: string;
  base_model?: string;
  preview_url?: string;
  notes?: string;
  modelDescription?: string;
  tags?: string[];
  usage_tips?: string;
  from_civitai?: boolean;
  civitai?: {
    id?: number;
    modelId?: number;
    trainedWords?: string[];
    baseModel?: string;
    description?: string;
    model?: {
      id?: number;
      name?: string;
      tags?: string[];
      description?: string;
    };
  };
}

export interface LoraManagerDetectResult {
  installed: boolean;
  customNodePath?: string;
  settingsPath?: string;
  hasCivitaiApiKey?: boolean;
  webUiHint?: string;
}

export interface LoraSidecarImportResult {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  previewsCopied: number;
  loraManagerDetected: boolean;
  details: Array<{
    relPath: string;
    id: string;
    displayName?: string;
    keywordsAdded?: number;
    previewCopied?: boolean;
    error?: string;
    skippedReason?: string;
  }>;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function relPathFromAbsolute(filePath: string, comfyuiPath: string): string | null {
  const fp = normalizePath(filePath);
  const root = normalizePath(comfyuiPath).replace(/\/+$/, "");
  const marker = "/models/";
  const idx = fp.toLowerCase().indexOf(marker);
  if (idx >= 0) {
    return fp.slice(idx + marker.length);
  }
  if (fp.startsWith(root + "/")) {
    const tail = fp.slice(root.length + 1);
    if (tail.startsWith("models/")) return tail.slice("models/".length);
  }
  return null;
}

function parseUsageTips(raw: string | undefined): LoraManagerUsageTips {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as LoraManagerUsageTips;
  } catch {
    /* ignore malformed usage_tips */
  }
  return {};
}

function buildSetupInstructions(tips: LoraManagerUsageTips): string {
  const parts: string[] = [];
  if (tips.clip_skip != null) parts.push(`CLIP skip: ${tips.clip_skip}`);
  if (tips.clip_strength != null) parts.push(`CLIP strength: ${tips.clip_strength}`);
  if (tips.strength_range) parts.push(`Strength range: ${tips.strength_range}`);
  return parts.join("; ");
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function defaultDisplayName(relPath: string): string {
  const file = basename(relPath);
  return file.replace(/\.(safetensors|ckpt|pt|bin)$/i, "").replace(/_/g, " ");
}

function catalogDisplayIsDefault(entry: LoraCatalogEntry | undefined, relPath: string): boolean {
  if (!entry) return true;
  return entry.displayName === defaultDisplayName(relPath);
}

function mergeKeywords(existing: string[], incoming: string[]): { merged: string[]; added: number } {
  const seen = new Set(existing.map((k) => k.toLowerCase()));
  const merged = [...existing];
  let added = 0;
  for (const w of incoming) {
    const t = w.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(t);
      added++;
    }
  }
  return { merged, added };
}

function mergeTags(existing: string[] | undefined, incoming: string[]): string[] {
  const tags = [...(existing ?? [])];
  const seen = new Set(tags.map((t) => t.toLowerCase()));
  for (const t of incoming) {
    const tag = t.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

function mergeBaseModels(existing: string[], incoming: string[]): string[] {
  const base = [...existing];
  const seen = new Set(base.map((b) => b.toLowerCase()));
  for (const b of incoming) {
    const v = b.trim();
    if (!v || v.toLowerCase() === "unknown") continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      base.push(v);
    }
  }
  return base;
}

export function parseLoraManagerMetadata(raw: string): LoraManagerMetadata | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as LoraManagerMetadata;
  } catch {
    return null;
  }
}

export function mapSidecarToCatalogPatch(
  meta: LoraManagerMetadata,
  relPath: string,
  existing?: LoraCatalogEntry,
  force = false,
): {
  patch: Partial<LoraCatalogEntry> & { relPath: string };
  keywordsAdded: number;
  previewSource?: string;
} {
  const civ = meta.civitai ?? {};
  const trained = (civ.trainedWords ?? []).map((w) => w.trim()).filter(Boolean);
  const tips = parseUsageTips(meta.usage_tips);

  const descriptionRaw =
    meta.modelDescription?.trim() ||
    civ.model?.description?.trim() ||
    civ.description?.trim() ||
    "";
  const description = descriptionRaw ? stripHtml(descriptionRaw) : "";

  const baseIncoming = [meta.base_model, civ.baseModel].filter(
    (b): b is string => !!b?.trim() && b.trim().toLowerCase() !== "unknown",
  );

  const modelId = civ.modelId ?? civ.model?.id;
  const versionId = civ.id;
  const sourceUrl =
    modelId && versionId
      ? `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`
      : modelId
        ? `https://civitai.com/models/${modelId}`
        : undefined;

  const displayName =
    meta.model_name?.trim() ||
    civ.model?.name?.trim() ||
    (force ? undefined : existing?.displayName) ||
    defaultDisplayName(relPath);

  const { merged: keywords, added: keywordsAdded } = mergeKeywords(
    force ? [] : (existing?.keywords ?? []),
    trained,
  );

  const setupFromTips = buildSetupInstructions(tips);
  const setupInstructions = force
    ? setupFromTips || existing?.setupInstructions || ""
    : existing?.setupInstructions?.trim()
      ? existing.setupInstructions
      : setupFromTips;

  const patch: Partial<LoraCatalogEntry> & { relPath: string } = {
    relPath,
    displayName:
      force || catalogDisplayIsDefault(existing, relPath) ? displayName : existing!.displayName,
    description: force || !existing?.description.trim() ? description : existing.description,
    setupInstructions,
    keywords,
    baseModels: mergeBaseModels(force ? [] : (existing?.baseModels ?? []), baseIncoming),
    tags: mergeTags(force ? [] : existing?.tags, meta.tags ?? civ.model?.tags ?? []),
    notes: meta.notes?.trim() || existing?.notes,
    strengthMin: tips.strength_min ?? existing?.strengthMin,
    strengthMax: tips.strength_max ?? existing?.strengthMax,
    strengthDefault: tips.strength ?? existing?.strengthDefault,
    civitaiModelId: modelId ?? existing?.civitaiModelId,
    civitaiVersionId: versionId ?? existing?.civitaiVersionId,
    sourceUrl: sourceUrl ?? existing?.sourceUrl,
  };

  let previewSource: string | undefined;
  const preview = meta.preview_url?.trim();
  if (preview && existsSync(preview)) {
    previewSource = preview;
  }

  return { patch, keywordsAdded, previewSource };
}

function listSidecarFiles(lorasRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(lorasRoot)) return out;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith(".metadata.json")) out.push(full);
    }
  }

  walk(lorasRoot);
  return out;
}

function copyPreviewIfNeeded(
  entryId: string,
  previewSource: string,
  existingPreview?: string,
): { copied: boolean; previewFile?: string } {
  const ext = extname(previewSource).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    return { copied: false };
  }
  const dir = loraPreviewsDir();
  mkdirSync(dir, { recursive: true });
  const destName = `${entryId}${ext}`;
  if (existingPreview === destName && existsSync(join(dir, destName))) {
    return { copied: false, previewFile: destName };
  }
  try {
    copyFileSync(previewSource, join(dir, destName));
    return { copied: true, previewFile: destName };
  } catch (err) {
    logger.warn("[lora-manager-sidecar] preview copy failed", {
      previewSource,
      error: err instanceof Error ? err.message : err,
    });
    return { copied: false };
  }
}

export function detectLoraManagerInstall(): LoraManagerDetectResult {
  const comfy = config.comfyuiPath?.trim();
  const result: LoraManagerDetectResult = {
    installed: false,
    webUiHint: comfy
      ? "LoRA Manager UI is typically at http://127.0.0.1:<comfy-port>/loras when the custom node is installed."
      : undefined,
  };

  if (comfy) {
    const customNodes = join(comfy, "custom_nodes");
    if (existsSync(customNodes)) {
      for (const name of readdirSync(customNodes)) {
        if (!LORA_MANAGER_NODE_NAMES.has(name) && !name.toLowerCase().includes("lora-manager")) {
          continue;
        }
        const candidate = join(customNodes, name);
        try {
          if (statSync(candidate).isDirectory()) {
            result.installed = true;
            result.customNodePath = candidate;
            break;
          }
        } catch {
          /* skip */
        }
      }
    }
    const portableSettings = join(comfy, "custom_nodes", LORA_MANAGER_REPO, "settings.json");
    if (existsSync(portableSettings)) {
      result.settingsPath = portableSettings;
    }
  }

  const userSettings = join(
    homedir(),
    "Library",
    "Application Support",
    "ComfyUI-LoRA-Manager",
    "settings.json",
  );
  if (!result.settingsPath && existsSync(userSettings)) {
    result.settingsPath = userSettings;
  }
  // Linux / Windows platformdirs fallback (common paths)
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const altSettings = join(
    xdg || join(homedir(), ".config"),
    "ComfyUI-LoRA-Manager",
    "settings.json",
  );
  if (!result.settingsPath && existsSync(altSettings)) {
    result.settingsPath = altSettings;
  }

  if (result.settingsPath) {
    try {
      const settings = JSON.parse(readFileSync(result.settingsPath, "utf-8")) as {
        civitai_api_key?: string;
        civitaiApiKey?: string;
      };
      const key = settings.civitai_api_key ?? settings.civitaiApiKey;
      result.hasCivitaiApiKey = !!key?.trim();
    } catch {
      /* ignore */
    }
  }

  return result;
}

/**
 * Import LoRA Manager `.metadata.json` sidecars into the comfyui-mcp catalog.
 * Requires COMFYUI_PATH. Run lora_catalog_sync first so entries exist for each file.
 */
export async function importLoraCatalogFromSidecars(opts: {
  limit?: number;
  force?: boolean;
  import_previews?: boolean;
  rel_path?: string;
} = {}): Promise<LoraSidecarImportResult> {
  const detection = detectLoraManagerInstall();
  const result: LoraSidecarImportResult = {
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    previewsCopied: 0,
    loraManagerDetected: detection.installed,
    details: [],
  };

  if (!config.comfyuiPath) {
    result.failed = 1;
    result.details.push({
      relPath: "",
      id: "",
      error: "COMFYUI_PATH not set — cannot locate LoRA Manager sidecar files",
    });
    return result;
  }

  const lorasRoot = join(config.comfyuiPath, "models", "loras");
  let sidecarPaths = listSidecarFiles(lorasRoot);

  if (opts.rel_path?.trim()) {
    const norm = opts.rel_path.replace(/\\/g, "/").replace(/^\/+/, "");
    const modelBase = basename(norm).replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
    const expected = join(lorasRoot, dirname(norm), `${modelBase}.metadata.json`);
    sidecarPaths = sidecarPaths.filter(
      (p) => normalizePath(p) === normalizePath(expected) || p.endsWith(`${modelBase}.metadata.json`),
    );
  }

  if (typeof opts.limit === "number" && opts.limit > 0) {
    sidecarPaths = sidecarPaths.slice(0, opts.limit);
  }

  result.scanned = sidecarPaths.length;
  const catalog = getLoraCatalog();

  for (const sidecarPath of sidecarPaths) {
    let raw: string;
    try {
      raw = readFileSync(sidecarPath, "utf-8");
    } catch (err) {
      result.failed++;
      result.details.push({
        relPath: sidecarPath,
        id: "",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const meta = parseLoraManagerMetadata(raw);
    if (!meta) {
      result.failed++;
      result.details.push({
        relPath: sidecarPath,
        id: "",
        error: "invalid metadata.json",
      });
      continue;
    }

    const modelFile = sidecarPath.replace(/\.metadata\.json$/i, "");
    const relFromMeta = meta.file_path
      ? relPathFromAbsolute(meta.file_path, config.comfyuiPath!)
      : null;
    const relFromSidecar = relPathFromAbsolute(modelFile, config.comfyuiPath!);
    const relPath =
      relFromMeta ??
      relFromSidecar ??
      normalizePath(sidecarPath)
        .replace(normalizePath(join(config.comfyuiPath!, "models", "")), "")
        .replace(/\.metadata\.json$/i, "");

    if (!relPath || !relPath.includes("loras/")) {
      result.skipped++;
      result.details.push({
        relPath: sidecarPath,
        id: "",
        skippedReason: "could not derive models/ relative path",
      });
      continue;
    }

    const id = loraIdFromPath(relPath);
    let existing = catalog.get(relPath) ?? catalog.get(id);

    if (!existing) {
      try {
        existing = catalog.upsert({ relPath });
      } catch (err) {
        result.failed++;
        result.details.push({
          relPath,
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    if (!opts.force && existing.civitaiVersionId && existing.keywords.length && existing.description.trim()) {
      result.skipped++;
      result.details.push({
        relPath,
        id: existing.id,
        skippedReason: "catalog already enriched (use force:true to overwrite)",
      });
      continue;
    }

    try {
      const { patch, keywordsAdded, previewSource } = mapSidecarToCatalogPatch(
        meta,
        relPath,
        existing,
        !!opts.force,
      );
      let updated = catalog.upsert({ id: existing.id, ...patch });

      let previewCopied = false;
      if (opts.import_previews !== false && previewSource) {
        const { copied, previewFile } = copyPreviewIfNeeded(
          updated.id,
          previewSource,
          updated.previewFile,
        );
        if (copied && previewFile) {
          updated = catalog.upsert({ id: updated.id, previewFile });
          previewCopied = true;
          result.previewsCopied++;
        }
      }

      result.imported++;
      result.details.push({
        relPath: updated.relPath,
        id: updated.id,
        displayName: updated.displayName,
        keywordsAdded,
        previewCopied,
      });
    } catch (err) {
      result.failed++;
      result.details.push({
        relPath,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}