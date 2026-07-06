// Persistent catalog of local LoRA files with human/agent-readable metadata:
// descriptions, setup instructions, trigger keywords, strength hints, and
// preview images. Synced against listLocalModels('loras') so missing files are
// flagged without dropping curated notes.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { getInstanceSlug } from "../config.js";
import { listLocalModels, type LocalModel } from "./model-resolver.js";
import { logger } from "../utils/logger.js";

/** ComfyUI-relative path under models/ (e.g. "loras/style/foo.safetensors"). */
export type LoraRelPath = string;

export interface LoraCatalogEntry {
  /** Stable slug derived from relPath. */
  id: string;
  /** Path relative to ComfyUI models/ root. */
  relPath: LoraRelPath;
  /** Short label for pickers and UI. */
  displayName: string;
  /** What this LoRA does — style, subject, effect, etc. */
  description: string;
  /** How to wire it: checkpoint pairing, node type, clip placement, etc. */
  setupInstructions: string;
  /** Trigger words / tokens to include in prompts. */
  keywords: string[];
  /** Optional tokens to avoid or negative-prompt hints. */
  negativeKeywords?: string[];
  /** Compatible base models (SDXL, Flux, Pony, etc.). */
  baseModels: string[];
  /** Suggested strength range and default for LoraLoader widgets. */
  strengthMin?: number;
  strengthMax?: number;
  strengthDefault?: number;
  /** Filename under the instance previews dir (not absolute). */
  previewFile?: string;
  /** Optional CivitAI / source links. */
  civitaiModelId?: number;
  civitaiVersionId?: number;
  sourceUrl?: string;
  tags?: string[];
  notes?: string;
  /** Present after sync when the file is no longer on disk. */
  missing?: boolean;
  fileSize?: number;
  modifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoraCatalogFile {
  version: 1;
  entries: Record<string, LoraCatalogEntry>;
}

export interface LoraCatalogListOptions {
  query?: string;
  includeMissing?: boolean;
  tag?: string;
  baseModel?: string;
  limit?: number;
}

export interface LoraCatalogSyncResult {
  scanned: number;
  added: number;
  updated: number;
  markedMissing: number;
  total: number;
}

const CATALOG_VERSION = 1 as const;
const PREVIEW_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function dataBaseDir(): string {
  return process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp");
}

/** Override for tests. */
export function loraCatalogPath(): string {
  const override = process.env.COMFYUI_MCP_LORA_CATALOG?.trim();
  if (override) return override;
  const slug = getInstanceSlug();
  return join(dataBaseDir(), "instances", slug, "lora-catalog.json");
}

export function loraPreviewsDir(): string {
  const override = process.env.COMFYUI_MCP_LORA_PREVIEWS?.trim();
  if (override) return override;
  const slug = getInstanceSlug();
  return join(dataBaseDir(), "instances", slug, "lora-previews");
}

export function loraIdFromPath(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const slug = base
    .toLowerCase()
    .replace(/\.(safetensors|ckpt|pt|bin)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lora";
}

function defaultDisplayName(relPath: string): string {
  const file = basename(relPath);
  return file.replace(/\.(safetensors|ckpt|pt|bin)$/i, "").replace(/_/g, " ");
}

function readCatalogFile(): LoraCatalogFile {
  const path = loraCatalogPath();
  if (!existsSync(path)) {
    return { version: CATALOG_VERSION, entries: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as LoraCatalogFile).version === CATALOG_VERSION &&
      typeof (parsed as LoraCatalogFile).entries === "object"
    ) {
      return parsed as LoraCatalogFile;
    }
  } catch (err) {
    logger.warn(
      `[lora-catalog] could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { version: CATALOG_VERSION, entries: {} };
}

function writeCatalogFile(data: LoraCatalogFile): void {
  const path = loraCatalogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function normalizeRelPath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.startsWith("models/")) return p.slice("models/".length);
  if (!p.startsWith("loras/") && !p.includes("/")) return `loras/${p}`;
  return p;
}

function entryFromLocal(model: LocalModel, now: string): LoraCatalogEntry {
  const relPath = normalizeRelPath(model.path.startsWith("loras/") ? model.path : `loras/${model.name}`);
  const id = loraIdFromPath(relPath);
  return {
    id,
    relPath,
    displayName: defaultDisplayName(relPath),
    description: "",
    setupInstructions: "",
    keywords: [],
    baseModels: [],
    fileSize: model.size || undefined,
    modifiedAt: model.modified || undefined,
    missing: false,
    createdAt: now,
    updatedAt: now,
  };
}

function mergeDiskEntry(existing: LoraCatalogEntry | undefined, disk: LoraCatalogEntry): LoraCatalogEntry {
  if (!existing) return disk;
  return {
    ...existing,
    relPath: disk.relPath,
    fileSize: disk.fileSize,
    modifiedAt: disk.modifiedAt,
    missing: false,
    updatedAt: new Date().toISOString(),
  };
}

function matchesQuery(entry: LoraCatalogEntry, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const hay = [
    entry.displayName,
    entry.relPath,
    entry.description,
    entry.setupInstructions,
    entry.notes ?? "",
    ...(entry.keywords ?? []),
    ...(entry.tags ?? []),
    ...(entry.baseModels ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** Public summary shape for panel UI and pickers. */
export function toLoraSummary(entry: LoraCatalogEntry): Record<string, unknown> {
  const previewUrl = entry.previewFile
    ? join(loraPreviewsDir(), entry.previewFile)
    : undefined;
  return {
    id: entry.id,
    relPath: entry.relPath,
    displayName: entry.displayName,
    description: entry.description,
    setupInstructions: entry.setupInstructions,
    keywords: entry.keywords,
    negativeKeywords: entry.negativeKeywords ?? [],
    baseModels: entry.baseModels,
    strengthDefault: entry.strengthDefault,
    strengthMin: entry.strengthMin,
    strengthMax: entry.strengthMax,
    previewFile: entry.previewFile,
    previewPath: previewUrl && existsSync(previewUrl) ? previewUrl : undefined,
    tags: entry.tags ?? [],
    missing: !!entry.missing,
    sourceUrl: entry.sourceUrl,
  };
}

export class LoraCatalog {
  private data: LoraCatalogFile;

  constructor() {
    this.data = readCatalogFile();
  }

  reload(): void {
    this.data = readCatalogFile();
  }

  list(opts: LoraCatalogListOptions = {}): LoraCatalogEntry[] {
    let entries = Object.values(this.data.entries);
    if (!opts.includeMissing) entries = entries.filter((e) => !e.missing);
    if (opts.tag) {
      const t = opts.tag.toLowerCase();
      entries = entries.filter((e) => (e.tags ?? []).some((x) => x.toLowerCase() === t));
    }
    if (opts.baseModel) {
      const b = opts.baseModel.toLowerCase();
      entries = entries.filter((e) =>
        (e.baseModels ?? []).some((x) => x.toLowerCase().includes(b)),
      );
    }
    if (opts.query) entries = entries.filter((e) => matchesQuery(e, opts.query!));
    entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (typeof opts.limit === "number" && opts.limit > 0) {
      entries = entries.slice(0, opts.limit);
    }
    return entries;
  }

  get(idOrPath: string): LoraCatalogEntry | null {
    const key = idOrPath.trim();
    if (this.data.entries[key]) return this.data.entries[key];
    const norm = normalizeRelPath(key);
    const id = loraIdFromPath(norm);
    if (this.data.entries[id]) return this.data.entries[id];
    for (const e of Object.values(this.data.entries)) {
      if (e.relPath === norm || e.relPath.endsWith(`/${basename(norm)}`)) return e;
    }
    return null;
  }

  async syncFromDisk(): Promise<LoraCatalogSyncResult> {
    const models = await listLocalModels("loras");
    const now = new Date().toISOString();
    const seenIds = new Set<string>();
    let added = 0;
    let updated = 0;

    for (const model of models) {
      const disk = entryFromLocal(model, now);
      seenIds.add(disk.id);
      const prev = this.data.entries[disk.id];
      if (!prev) {
        this.data.entries[disk.id] = disk;
        added++;
      } else {
        const wasMissing = !!prev.missing;
        this.data.entries[disk.id] = mergeDiskEntry(prev, disk);
        if (wasMissing) updated++;
      }
    }

    let markedMissing = 0;
    for (const [id, entry] of Object.entries(this.data.entries)) {
      if (!seenIds.has(id) && !entry.missing) {
        entry.missing = true;
        entry.updatedAt = now;
        markedMissing++;
      }
    }

    writeCatalogFile(this.data);
    return {
      scanned: models.length,
      added,
      updated: updated + markedMissing,
      markedMissing,
      total: Object.keys(this.data.entries).length,
    };
  }

  upsert(partial: Partial<LoraCatalogEntry> & { relPath?: string; id?: string }): LoraCatalogEntry {
    const now = new Date().toISOString();
    let id = partial.id?.trim();
    let relPath = partial.relPath ? normalizeRelPath(partial.relPath) : undefined;

    if (!id && relPath) id = loraIdFromPath(relPath);
    if (id && !relPath) relPath = this.data.entries[id]?.relPath;
    if (!id || !relPath) {
      throw new Error("upsert requires id or relPath");
    }

    const prev = this.data.entries[id];
    const entry: LoraCatalogEntry = {
      id,
      relPath,
      displayName: partial.displayName?.trim() || prev?.displayName || defaultDisplayName(relPath),
      description: partial.description ?? prev?.description ?? "",
      setupInstructions: partial.setupInstructions ?? prev?.setupInstructions ?? "",
      keywords: partial.keywords ?? prev?.keywords ?? [],
      negativeKeywords: partial.negativeKeywords ?? prev?.negativeKeywords,
      baseModels: partial.baseModels ?? prev?.baseModels ?? [],
      strengthMin: partial.strengthMin ?? prev?.strengthMin,
      strengthMax: partial.strengthMax ?? prev?.strengthMax,
      strengthDefault: partial.strengthDefault ?? prev?.strengthDefault,
      previewFile: partial.previewFile ?? prev?.previewFile,
      civitaiModelId: partial.civitaiModelId ?? prev?.civitaiModelId,
      civitaiVersionId: partial.civitaiVersionId ?? prev?.civitaiVersionId,
      sourceUrl: partial.sourceUrl ?? prev?.sourceUrl,
      tags: partial.tags ?? prev?.tags,
      notes: partial.notes ?? prev?.notes,
      missing: partial.missing ?? prev?.missing,
      fileSize: partial.fileSize ?? prev?.fileSize,
      modifiedAt: partial.modifiedAt ?? prev?.modifiedAt,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };

    this.data.entries[id] = entry;
    writeCatalogFile(this.data);
    return entry;
  }

  setPreview(idOrPath: string, sourcePath: string): LoraCatalogEntry {
    const entry = this.get(idOrPath);
    if (!entry) throw new Error(`No catalog entry for "${idOrPath}"`);

    const src = sourcePath.trim();
    if (!existsSync(src)) throw new Error(`Preview source not found: ${src}`);
    const ext = extname(src).toLowerCase();
    if (!PREVIEW_EXTS.has(ext)) {
      throw new Error(`Preview must be an image (${[...PREVIEW_EXTS].join(", ")})`);
    }

    const dir = loraPreviewsDir();
    mkdirSync(dir, { recursive: true });
    const destName = `${entry.id}${ext}`;
    const dest = join(dir, destName);

    if (entry.previewFile && entry.previewFile !== destName) {
      const old = join(dir, entry.previewFile);
      if (existsSync(old)) {
        try {
          unlinkSync(old);
        } catch {
          /* best effort */
        }
      }
    }

    copyFileSync(src, dest);
    return this.upsert({ id: entry.id, previewFile: destName });
  }

  remove(idOrPath: string): boolean {
    const entry = this.get(idOrPath);
    if (!entry) return false;
    if (entry.previewFile) {
      const p = join(loraPreviewsDir(), entry.previewFile);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* best effort */
        }
      }
    }
    delete this.data.entries[entry.id];
    writeCatalogFile(this.data);
    return true;
  }
}

let singleton: LoraCatalog | null = null;

export function getLoraCatalog(): LoraCatalog {
  if (!singleton) singleton = new LoraCatalog();
  else singleton.reload();
  return singleton;
}

/** Reset singleton — tests only. */
export function resetLoraCatalog(): void {
  singleton = null;
}