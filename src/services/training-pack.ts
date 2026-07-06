import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getInstanceSlug } from "../config.js";
import { ValidationError } from "../utils/errors.js";
import {
  photomapCurateSync,
  photomapExportDataset,
  type PhotomapCurationMethod,
  type PhotomapCurationResult,
} from "./photomap.js";

export interface TrainingPackManifest {
  version: 1;
  id: string;
  name: string;
  album: string;
  createdAt: string;
  method: PhotomapCurationMethod;
  targetCount: number;
  iterations: number;
  selectedIndices: number[];
  selectedFiles: string[];
  outputDir: string;
  imageCount: number;
  /** Optional subject / LoRA name this pack trains toward. */
  subject?: string;
  notes?: string;
  /** PhotoMapAI curation — MIT https://github.com/lstein/PhotoMapAI */
  curationSource: "photomapai";
}

export interface CreateTrainingPackInput {
  name: string;
  album: string;
  target_count: number;
  iterations?: number;
  method?: PhotomapCurationMethod;
  excluded_indices?: number[];
  subject?: string;
  notes?: string;
}

export interface TrainingPackSummary {
  id: string;
  name: string;
  album: string;
  createdAt: string;
  imageCount: number;
  outputDir: string;
  subject?: string;
}

function dataBaseDir(): string {
  return process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp");
}

export function trainingPacksRoot(): string {
  const slug = getInstanceSlug();
  return join(dataBaseDir(), "instances", slug, "training-packs");
}

function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base || "pack"}-${stamp}`;
}

function packDir(id: string): string {
  return join(trainingPacksRoot(), id);
}

function manifestPath(id: string): string {
  return join(packDir(id), "manifest.json");
}

function readManifest(id: string): TrainingPackManifest | null {
  const path = manifestPath(id);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as TrainingPackManifest;
    if (parsed?.version === 1 && parsed.id) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function countImages(dir: string): number {
  if (!existsSync(dir)) return 0;
  const exts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
  return readdirSync(dir).filter((f) => exts.has(f.slice(f.lastIndexOf(".")).toLowerCase())).length;
}

export function listTrainingPacks(): TrainingPackSummary[] {
  const root = trainingPacksRoot();
  if (!existsSync(root)) return [];
  const out: TrainingPackSummary[] = [];
  for (const id of readdirSync(root)) {
    const m = readManifest(id);
    if (!m) continue;
    out.push({
      id: m.id,
      name: m.name,
      album: m.album,
      createdAt: m.createdAt,
      imageCount: m.imageCount,
      outputDir: m.outputDir,
      subject: m.subject,
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export function getTrainingPack(id: string): TrainingPackManifest | null {
  return readManifest(id.trim());
}

/**
 * Curate a diverse subset via PhotoMapAI, export to a vault training pack folder,
 * and write manifest.json for RunComfy / local trainer pipelines.
 */
export async function createTrainingPackFromPhotomap(
  input: CreateTrainingPackInput,
): Promise<{ manifest: TrainingPackManifest; curation: PhotomapCurationResult }> {
  const name = input.name.trim();
  if (!name) throw new ValidationError("name is required");

  const curation = await photomapCurateSync({
    album: input.album,
    target_count: input.target_count,
    iterations: input.iterations ?? 3,
    method: input.method ?? "fps",
    excluded_indices: input.excluded_indices,
  });

  if (curation.status !== "success" || !curation.selected_files?.length) {
    throw new ValidationError(
      `PhotoMap curation produced no images (status=${curation.status}, count=${curation.count ?? 0})`,
    );
  }

  const id = slugifyId(name);
  const dir = packDir(id);
  const imagesDir = join(dir, "images");
  mkdirSync(imagesDir, { recursive: true });

  const exportResult = await photomapExportDataset({
    album: input.album,
    filenames: curation.selected_files,
    output_folder: imagesDir,
  });

  if (!exportResult.exported) {
    throw new ValidationError(
      `PhotoMap export copied 0 files: ${(exportResult.errors ?? []).join("; ") || "unknown error"}`,
    );
  }

  const manifest: TrainingPackManifest = {
    version: 1,
    id,
    name,
    album: input.album,
    createdAt: new Date().toISOString(),
    method: input.method ?? "fps",
    targetCount: input.target_count,
    iterations: input.iterations ?? 3,
    selectedIndices: curation.selected_indices ?? [],
    selectedFiles: curation.selected_files,
    outputDir: imagesDir,
    imageCount: countImages(imagesDir),
    subject: input.subject?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    curationSource: "photomapai",
  };

  writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2));
  return { manifest, curation };
}

/** List on-disk image paths inside a training pack (for upload to RunComfy). */
export function listTrainingPackImagePaths(packId: string): string[] {
  const m = getTrainingPack(packId);
  if (!m) throw new ValidationError(`Training pack not found: ${packId}`);
  const dir = m.outputDir;
  if (!existsSync(dir)) return [];
  const exts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
  return readdirSync(dir)
    .filter((f) => exts.has(f.slice(f.lastIndexOf(".")).toLowerCase()))
    .map((f) => join(dir, f));
}

export function trainingPackCaptionStem(imagePath: string): string {
  return basename(imagePath).replace(/\.[^.]+$/, "");
}