import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// PhotoMapAI local FastAPI client (default http://127.0.0.1:8050).
// API reference: https://lstein.github.io/PhotoMapAI/developer/api/
// ---------------------------------------------------------------------------

export interface PhotomapConfig {
  baseUrl: string;
}

export interface PhotomapDeps {
  fetch?: typeof fetch;
}

export interface PhotomapAlbumSummary {
  key: string;
  name?: string;
  description?: string;
  index?: unknown;
  umap_eps?: number;
  image_paths?: string[];
  [key: string]: unknown;
}

export interface PhotomapSearchHit {
  index: number;
  score: number;
}

export interface PhotomapSearchResult {
  album_key: string;
  hits: PhotomapSearchHit[];
  count: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8050";

export function resolvePhotomapConfig(): PhotomapConfig {
  const baseUrl =
    process.env.PHOTOMAP_URL?.trim() ||
    process.env.PHOTOMAP_BASE_URL?.trim() ||
    DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/$/, "") };
}

async function photomapFetch(
  cfg: PhotomapConfig,
  path: string,
  init: RequestInit = {},
  deps: PhotomapDeps = {},
): Promise<Response> {
  const fetchFn = deps.fetch ?? fetch;
  const url = `${cfg.baseUrl}${path}`;
  try {
    const res = await fetchFn(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ValidationError(
        `PhotoMapAI ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `PhotoMapAI unreachable at ${cfg.baseUrl}: ${msg}. Start PhotoMapAI (start_photomap) or set PHOTOMAP_URL.`,
    );
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

function resolveLocalPath(filePath: string): string {
  const p = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  if (!existsSync(p)) {
    throw new ValidationError(`File not found: ${p}`);
  }
  return p;
}

async function fileToBase64(filePath: string): Promise<string> {
  const buf = await readFile(resolveLocalPath(filePath));
  return buf.toString("base64");
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

export async function photomapHealth(
  deps: PhotomapDeps = {},
): Promise<{ ok: true; baseUrl: string; albumCount: number }> {
  const listed = await photomapListAlbums(deps);
  return { ok: true, baseUrl: listed.baseUrl, albumCount: listed.count };
}

export async function photomapListAlbums(
  deps: PhotomapDeps = {},
): Promise<{ baseUrl: string; albums: PhotomapAlbumSummary[]; count: number }> {
  const cfg = resolvePhotomapConfig();
  const res = await photomapFetch(cfg, "/available_albums/", {}, deps);
  const albums = await readJson<PhotomapAlbumSummary[]>(res);
  return {
    baseUrl: cfg.baseUrl,
    albums: Array.isArray(albums) ? albums : [],
    count: Array.isArray(albums) ? albums.length : 0,
  };
}

export async function photomapGetAlbum(
  albumKey: string,
  deps: PhotomapDeps = {},
): Promise<{ baseUrl: string; album: PhotomapAlbumSummary }> {
  const cfg = resolvePhotomapConfig();
  const key = albumKey.trim();
  if (!key) throw new ValidationError("album_key is required");
  const res = await photomapFetch(cfg, `/album/${encodeURIComponent(key)}/`, {}, deps);
  const album = await readJson<PhotomapAlbumSummary>(res);
  return { baseUrl: cfg.baseUrl, album };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function photomapSearch(
  input: {
    album_key: string;
    positive_query?: string;
    negative_query?: string;
    image_path?: string;
    image_weight?: number;
    positive_weight?: number;
    negative_weight?: number;
    top_k?: number;
  },
  deps: PhotomapDeps = {},
): Promise<PhotomapSearchResult> {
  const cfg = resolvePhotomapConfig();
  const albumKey = input.album_key.trim();
  if (!albumKey) throw new ValidationError("album_key is required");

  const body: Record<string, unknown> = {
    positive_query: input.positive_query ?? "",
    negative_query: input.negative_query ?? "",
    image_weight: input.image_weight ?? 1,
    positive_weight: input.positive_weight ?? 1,
    negative_weight: input.negative_weight ?? 1,
    top_k: input.top_k ?? 10,
  };

  if (input.image_path?.trim()) {
    body.image_data = await fileToBase64(input.image_path.trim());
  }

  const res = await photomapFetch(
    cfg,
    `/search_with_text_and_image/${encodeURIComponent(albumKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    deps,
  );
  const hits = await readJson<PhotomapSearchHit[]>(res);
  const list = Array.isArray(hits) ? hits : [];
  return { album_key: albumKey, hits: list, count: list.length };
}

// ---------------------------------------------------------------------------
// Image metadata / paths
// ---------------------------------------------------------------------------

export async function photomapImagePath(
  albumKey: string,
  index: number,
  deps: PhotomapDeps = {},
): Promise<{ album_key: string; index: number; path: string }> {
  const cfg = resolvePhotomapConfig();
  const key = albumKey.trim();
  if (!key) throw new ValidationError("album_key is required");
  if (!Number.isInteger(index) || index < 0) {
    throw new ValidationError("index must be a non-negative integer");
  }
  const res = await photomapFetch(
    cfg,
    `/image_path/${encodeURIComponent(key)}/${index}`,
    {},
    deps,
  );
  const path = (await res.text()).trim();
  return { album_key: key, index, path };
}

export async function photomapImageInfo(
  albumKey: string,
  index: number,
  deps: PhotomapDeps = {},
): Promise<{ album_key: string; index: number; info: unknown }> {
  const cfg = resolvePhotomapConfig();
  const key = albumKey.trim();
  if (!key) throw new ValidationError("album_key is required");
  if (!Number.isInteger(index) || index < 0) {
    throw new ValidationError("index must be a non-negative integer");
  }
  const res = await photomapFetch(
    cfg,
    `/image_info/${encodeURIComponent(key)}/${index}`,
    {},
    deps,
  );
  const info = await readJson<unknown>(res);
  return { album_key: key, index, info };
}

export async function photomapGetMetadata(
  albumKey: string,
  index: number,
  deps: PhotomapDeps = {},
): Promise<{ album_key: string; index: number; metadata: unknown }> {
  const cfg = resolvePhotomapConfig();
  const key = albumKey.trim();
  if (!key) throw new ValidationError("album_key is required");
  if (!Number.isInteger(index) || index < 0) {
    throw new ValidationError("index must be a non-negative integer");
  }
  const res = await photomapFetch(
    cfg,
    `/get_metadata/${encodeURIComponent(key)}/${index}`,
    {},
    deps,
  );
  const metadata = await readJson<unknown>(res);
  return { album_key: key, index, metadata };
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export async function photomapUpdateIndexAsync(
  albumKey: string,
  deps: PhotomapDeps = {},
): Promise<{ album_key: string; accepted: boolean; response: unknown }> {
  const cfg = resolvePhotomapConfig();
  const key = albumKey.trim();
  if (!key) throw new ValidationError("album_key is required");
  const res = await photomapFetch(
    cfg,
    "/update_index_async/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album_key: key }),
    },
    deps,
  );
  const response = await readJson<unknown>(res);
  return { album_key: key, accepted: res.status === 202 || res.status === 200, response };
}

export async function photomapIndexProgress(
  albumKey: string,
  deps: PhotomapDeps = {},
): Promise<{ album_key: string; progress: unknown }> {
  const cfg = resolvePhotomapConfig();
  const key = albumKey.trim();
  if (!key) throw new ValidationError("album_key is required");
  const res = await photomapFetch(
    cfg,
    `/index_progress/${encodeURIComponent(key)}`,
    {},
    deps,
  );
  const progress = await readJson<unknown>(res);
  return { album_key: key, progress };
}