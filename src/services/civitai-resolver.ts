import { config } from "../config.js";
import { ModelError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { htmlToMarkdown } from "../utils/html-to-markdown.js";
import { civitaiDisabled, CIVITAI_DISABLED_MESSAGE } from "./model-resolver.js";

const CIVITAI_API_BASE = "https://civitai.com/api/v1";

/**
 * Subset of the CivitAI model-version file object.
 * See https://developer.civitai.com (Public REST API v1).
 */
interface CivitaiFile {
  name?: string;
  downloadUrl?: string;
  primary?: boolean;
  type?: string;
  sizeKB?: number;
}

/** An example image/video shown in the model's gallery, with generation params. */
interface CivitaiImage {
  url?: string;
  width?: number;
  height?: number;
  nsfwLevel?: number;
  type?: string; // "image" | "video"
  hash?: string;
  meta?: Record<string, unknown> | null;
}

interface CivitaiModelVersion {
  id: number;
  name?: string;
  baseModel?: string;
  description?: string;
  trainedWords?: string[];
  downloadUrl?: string;
  files?: CivitaiFile[];
  images?: CivitaiImage[];
  // Present on GET /model-versions/{id} (not on the nested versions of /models/{id}).
  model?: { name?: string; type?: string };
}

interface CivitaiModel {
  id: number;
  name?: string;
  type?: string;
  description?: string;
  tags?: string[];
  creator?: { username?: string };
  modelVersions?: CivitaiModelVersion[];
}

/** One example generation captured from a model's gallery, for the recipe. */
export interface CivitaiExample {
  url?: string;
  type?: string; // image | video
  width?: number;
  height?: number;
  nsfwLevel?: number;
  meta?: Record<string, unknown> | null;
}

/**
 * Rich, human/agent-facing metadata about a downloaded CivitAI model, written
 * as a sidecar next to the file so the panel agent can read usage docs, trigger
 * words, and example generation params without re-querying CivitAI.
 */
export interface CivitaiMetadata {
  modelId?: number;
  modelName?: string;
  modelType?: string;
  creator?: string;
  tags?: string[];
  modelDescriptionHtml?: string;
  versionId: number;
  versionName?: string;
  versionDescriptionHtml?: string;
  baseModel?: string;
  trainedWords: string[];
  fileName?: string;
  fileSizeKB?: number;
  /** Canonical CivitAI page URL for this model/version. */
  sourceUrl: string;
  examples: CivitaiExample[];
}

export interface CivitaiResolved {
  /**
   * Direct download URL. No credentials are embedded — `downloadModel` attaches
   * the CivitAI token as an `Authorization` request header, so the token never
   * leaks into logs, error messages, or redirect URLs.
   */
  downloadUrl: string;
  /** Suggested filename from CivitAI metadata, when available. */
  filename?: string;
  /** Resolved model-version id. */
  versionId: number;
  /** Model name, when resolvable. */
  modelName?: string;
  /** Rich metadata for the download sidecar (best-effort; undefined if unbuildable). */
  metadata?: CivitaiMetadata;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.civitaiApiToken) {
    headers["Authorization"] = `Bearer ${config.civitaiApiToken}`;
  }
  return headers;
}

async function civitaiGet<T>(path: string): Promise<T> {
  // User-initiated Civitai actions fail FAST with the config explanation when
  // the kill-switch is set (issue #127) — never a hang against a blocked host.
  if (civitaiDisabled()) {
    throw new ModelError(CIVITAI_DISABLED_MESSAGE);
  }
  const url = `${CIVITAI_API_BASE}${path}`;
  logger.debug("CivitAI API request", { url });

  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) {
    throw new ModelError(`CivitAI resource not found: ${path}`, {
      url,
      status: 404,
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ModelError(`CivitAI API ${res.status}: ${res.statusText}`, {
      url,
      status: res.status,
      body,
    });
  }
  return (await res.json()) as T;
}

/** Pick the best file from a version's file list: primary first, else the first. */
function pickFile(version: CivitaiModelVersion): CivitaiFile | undefined {
  const files = version.files ?? [];
  return files.find((f) => f.primary) ?? files[0];
}

/** Max example generations captured into the sidecar (those carrying params first). */
const MAX_EXAMPLES = 8;

function buildExamples(version: CivitaiModelVersion): CivitaiExample[] {
  const imgs = version.images ?? [];
  // Prefer examples that actually carry generation params (a usable recipe).
  const withMeta = imgs.filter((i) => i.meta && Object.keys(i.meta).length > 0);
  const ordered = [...withMeta, ...imgs.filter((i) => !withMeta.includes(i))];
  return ordered.slice(0, MAX_EXAMPLES).map((i) => ({
    url: i.url,
    type: i.type,
    width: i.width,
    height: i.height,
    nsfwLevel: i.nsfwLevel,
    meta: i.meta ?? null,
  }));
}

function buildMetadata(
  version: CivitaiModelVersion,
  file: CivitaiFile | undefined,
  model?: CivitaiModel,
): CivitaiMetadata {
  const modelId = model?.id;
  const sourceUrl = modelId
    ? `https://civitai.com/models/${modelId}?modelVersionId=${version.id}`
    : `https://civitai.com/model-versions/${version.id}`;
  return {
    modelId,
    modelName: model?.name ?? version.model?.name,
    modelType: model?.type ?? version.model?.type,
    creator: model?.creator?.username,
    tags: model?.tags,
    modelDescriptionHtml: model?.description,
    versionId: version.id,
    versionName: version.name,
    versionDescriptionHtml: version.description,
    baseModel: version.baseModel,
    trainedWords: version.trainedWords ?? [],
    fileName: file?.name,
    fileSizeKB: file?.sizeKB,
    sourceUrl,
    examples: buildExamples(version),
  };
}

function resolveFromVersion(
  version: CivitaiModelVersion,
  model?: CivitaiModel,
): CivitaiResolved {
  const file = pickFile(version);
  const downloadUrl =
    file?.downloadUrl ??
    version.downloadUrl ??
    `https://civitai.com/api/download/models/${version.id}`;

  return {
    downloadUrl,
    filename: file?.name,
    versionId: version.id,
    modelName: model?.name ?? version.model?.name,
    metadata: buildMetadata(version, file, model),
  };
}

/**
 * Resolve a CivitAI model-version id directly to a download URL.
 * Uses GET /api/v1/model-versions/{id}.
 */
export async function resolveCivitaiModelVersion(
  versionId: number,
): Promise<CivitaiResolved> {
  const version = await civitaiGet<CivitaiModelVersion>(
    `/model-versions/${versionId}`,
  );
  return resolveFromVersion(version);
}

/**
 * Render a CivitAI metadata bundle as agent-readable Markdown for the sidecar.
 * Usage docs (trigger words, base model, descriptions) up top; a compact
 * "example recipes" section from the gallery's generation params below.
 */
export function buildCivitaiMarkdown(m: CivitaiMetadata): string {
  const lines: string[] = [];
  lines.push(`# ${m.modelName ?? "CivitAI model"}`);
  const facts: string[] = [];
  if (m.modelType) facts.push(`**Type:** ${m.modelType}`);
  if (m.baseModel) facts.push(`**Base model:** ${m.baseModel}`);
  if (m.versionName) facts.push(`**Version:** ${m.versionName}`);
  if (m.creator) facts.push(`**Creator:** ${m.creator}`);
  if (facts.length) lines.push("", facts.join("  \n"));
  lines.push("", `Source: ${m.sourceUrl}`);

  if (m.trainedWords.length) {
    lines.push("", "## Trigger words", "");
    lines.push(m.trainedWords.map((w) => `\`${w}\``).join(", "));
  }

  const modelMd = htmlToMarkdown(m.modelDescriptionHtml);
  if (modelMd) lines.push("", "## Description", "", modelMd);

  const versionMd = htmlToMarkdown(m.versionDescriptionHtml);
  if (versionMd) lines.push("", "## Version notes", "", versionMd);

  const recipes = m.examples.filter(
    (e) => e.meta && Object.keys(e.meta).length > 0,
  );
  if (recipes.length) {
    lines.push("", "## Example recipes", "");
    lines.push(
      "Generation params pulled from the model's gallery — reuse the seed to replicate, or vary it to remix.",
    );
    recipes.forEach((e, i) => {
      lines.push("", `### Example ${i + 1}`);
      if (e.url) lines.push(`Image: ${e.url}`);
      lines.push("", "```", formatMeta(e.meta!), "```");
    });
  }

  return lines.join("\n") + "\n";
}

/** Flatten a CivitAI image `meta` object into readable `key: value` lines,
 *  surfacing the params that matter for reproduction first. */
function formatMeta(meta: Record<string, unknown>): string {
  const order = [
    "prompt",
    "negativePrompt",
    "seed",
    "steps",
    "sampler",
    "cfgScale",
    "Size",
    "Model",
    "Denoising strength",
    "Clip skip",
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    if (typeof v === "object") return; // skip nested (resources/hashes) here
    out.push(`${k}: ${v}`);
    seen.add(k);
  };
  for (const k of order) if (k in meta) push(k, meta[k]);
  for (const [k, v] of Object.entries(meta)) if (!seen.has(k)) push(k, v);
  return out.join("\n");
}

/**
 * Resolve a CivitAI model id to a download URL.
 * Uses GET /api/v1/models/{id} and picks a model version.
 * If `versionId` is supplied, that specific version is used; otherwise the
 * latest (first listed) version is chosen.
 */
export async function resolveCivitaiModel(
  modelId: number,
  versionId?: number,
): Promise<CivitaiResolved> {
  const model = await civitaiGet<CivitaiModel>(`/models/${modelId}`);
  const versions = model.modelVersions ?? [];

  if (versions.length === 0) {
    throw new ModelError(
      `CivitAI model ${modelId} has no downloadable versions.`,
      { modelId },
    );
  }

  let version: CivitaiModelVersion | undefined;
  if (versionId !== undefined) {
    version = versions.find((v) => v.id === versionId);
    if (!version) {
      throw new ValidationError(
        `Model ${modelId} has no version with id ${versionId}. ` +
          `Available versions: ${versions.map((v) => v.id).join(", ")}.`,
      );
    }
  } else {
    version = versions[0];
  }

  return resolveFromVersion(version, model);
}

// ---------------------------------------------------------------------------
// Keyword search (native — replaces the previously-bundled Civitai MCP for the
// search→download loop). GET /api/v1/models works UNAUTHENTICATED with query,
// type, and base-model filters, and each hit carries exactly what
// download_civitai_model consumes (model id + version id) plus the trigger
// words the prompt will need. Field driver: a local-model user asked to "find
// a good Flux LoRA on Civitai" and there was no tool that could.
// ---------------------------------------------------------------------------

export interface CivitaiSearchHit {
  model_id: number;
  name: string;
  type?: string;
  creator?: string;
  downloads?: number;
  thumbs_up?: number;
  nsfw?: boolean;
  /** Latest version — the one download_civitai_model fetches by default. */
  version_id?: number;
  version_name?: string;
  base_model?: string;
  trained_words?: string[];
  /** Approximate primary-file size, MB (when the API reports it). */
  size_mb?: number;
}

const CIVITAI_SORTS = ["Highest Rated", "Most Downloaded", "Newest"] as const;
export type CivitaiSort = (typeof CIVITAI_SORTS)[number];

export interface CivitaiSearchOptions {
  types?: string[];
  /** Civitai base-model labels, e.g. "Flux.1 D", "SDXL 1.0", "SD 1.5", "Pony", "Illustrious". */
  baseModels?: string[];
  sort?: CivitaiSort;
  nsfw?: boolean;
  limit?: number;
  /** Only models by this CivitAI creator (exact username). Sent as the API's
   *  `username` param; any keyword query is applied client-side because the
   *  API returns an empty page when `query` and `username` are combined
   *  (live-verified quirk). */
  creator?: string;
}

interface CivitaiSearchResponse {
  items?: Array<
    CivitaiModel & {
      nsfw?: boolean;
      stats?: { downloadCount?: number; thumbsUpCount?: number };
    }
  >;
}

export async function searchCivitaiModels(
  query: string,
  opts: CivitaiSearchOptions = {},
): Promise<CivitaiSearchHit[]> {
  const creator = opts.creator?.trim();
  const keyword = query.trim();
  if (!creator && !keyword) {
    throw new ValidationError("Provide a query, a creator, or both.");
  }
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const params = new URLSearchParams();
  params.set("sort", opts.sort ?? "Highest Rated");
  // Civitai defaults to including NSFW for authed accounts — pin it explicitly
  // so results are SFW unless the caller opted in.
  params.set("nsfw", opts.nsfw ? "true" : "false");
  for (const t of opts.types ?? []) params.append("types", t);
  for (const b of opts.baseModels ?? []) params.append("baseModels", b);
  if (creator) {
    // Creator mode: `query` + `username` together return an EMPTY page
    // (live-verified), so send only `username` and apply the keyword
    // client-side. Over-fetch so the post-filter still fills `limit`.
    params.set("username", creator);
    params.set("limit", String(keyword ? 100 : limit));
  } else {
    params.set("query", keyword);
    params.set("limit", String(limit));
  }

  const data = await civitaiGet<CivitaiSearchResponse>(`/models?${params.toString()}`);
  let items = data.items ?? [];
  if (creator && keyword) {
    const q = keyword.toLowerCase();
    items = items.filter(
      (m) =>
        (m.name ?? "").toLowerCase().includes(q) ||
        (m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }
  return items.slice(0, limit).map((m) => {
    const v = m.modelVersions?.[0];
    const file = v ? pickFile(v) : undefined;
    const sizeKb = (file as { sizeKB?: number } | undefined)?.sizeKB;
    return {
      model_id: m.id,
      name: m.name ?? `model ${m.id}`,
      type: m.type,
      creator: m.creator?.username,
      downloads: m.stats?.downloadCount,
      thumbs_up: m.stats?.thumbsUpCount,
      nsfw: m.nsfw,
      version_id: v?.id,
      version_name: v?.name,
      base_model: v?.baseModel,
      trained_words: v?.trainedWords?.slice(0, 6),
      ...(sizeKb ? { size_mb: Math.round(sizeKb / 1024) } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Creator search + top-creators leaderboard. Field driver: a mobile-beta user
// asked to "search posts by top creators, similar to the leaderboard on the
// actual website" (Discord). Two backends, one hit shape:
//   • GET /api/v1/creators           — username search (documented public API)
//   • tRPC leaderboard.getLeaderboard — the website's ranked creator boards;
//     the v1 API exposes NO leaderboard ordering (/creators is join-date
//     ordered), so this mirrors the site's own request. Civitai's bot gate
//     401s a plain fetch UA ("Please use the public API instead"), so the
//     request carries browser-shaped headers — same approach the mobile app
//     already uses for its tRPC calls.
// ---------------------------------------------------------------------------

export interface CivitaiCreatorHit {
  username: string;
  /** civitai.com profile page for the creator. */
  profile_url: string;
  /** Number of published models (username-search mode; API omits it for 0). */
  model_count?: number;
  /** Leaderboard rank, 1-based (top-creators mode only). */
  position?: number;
  /** Leaderboard score (top-creators mode only). */
  score?: number;
  downloads?: number;
  thumbs_up?: number;
  generations?: number;
  /** Models counted into the leaderboard score (top-creators mode only). */
  entries?: number;
}

const CIVITAI_LEADERBOARDS = [
  "overall",
  "overall_90",
  "overall_nsfw",
  "new_creators",
] as const;
export type CivitaiLeaderboard = (typeof CIVITAI_LEADERBOARDS)[number];

function creatorProfileUrl(username: string): string {
  return `https://civitai.com/user/${encodeURIComponent(username)}`;
}

interface CivitaiCreatorsResponse {
  items?: Array<{ username?: string; modelCount?: number; link?: string }>;
  metadata?: { totalItems?: number };
}

/**
 * Search CivitAI creators by (partial) username via GET /api/v1/creators.
 * Returns matching creators plus the API's total match count.
 */
export async function searchCivitaiCreators(
  query: string,
  opts: { limit?: number } = {},
): Promise<{ hits: CivitaiCreatorHit[]; total?: number }> {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("limit", String(Math.min(Math.max(opts.limit ?? 10, 1), 50)));
  const data = await civitaiGet<CivitaiCreatorsResponse>(
    `/creators?${params.toString()}`,
  );
  const hits = (data.items ?? [])
    .filter((c): c is { username: string; modelCount?: number } => !!c.username)
    .map((c) => ({
      username: c.username,
      profile_url: creatorProfileUrl(c.username),
      model_count: c.modelCount ?? 0,
    }));
  return { hits, total: data.metadata?.totalItems };
}

/** Browser-shaped headers for the tRPC leaderboard request (see section note). */
const TRPC_BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Referer: "https://civitai.com/",
};

interface CivitaiLeaderboardEntry {
  position?: number;
  score?: number;
  user?: { username?: string; deletedAt?: string | null };
  metrics?: Array<{ type?: string; value?: number }>;
}

/**
 * Fetch a CivitAI creator leaderboard (the site's civitai.com/leaderboard
 * ranking). `board` picks which one: "overall" (default), "overall_90",
 * "overall_nsfw", or "new_creators".
 */
export async function fetchCivitaiTopCreators(
  opts: { board?: CivitaiLeaderboard; limit?: number } = {},
): Promise<CivitaiCreatorHit[]> {
  if (civitaiDisabled()) {
    throw new ModelError(CIVITAI_DISABLED_MESSAGE);
  }
  const board = opts.board ?? "overall";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const input = encodeURIComponent(JSON.stringify({ json: { id: board } }));
  const url = `https://civitai.com/api/trpc/leaderboard.getLeaderboard?input=${input}`;
  logger.debug("CivitAI leaderboard request", { url });

  // No bearer token here: the leaderboard is public and the API token belongs
  // to the documented v1 surface, not the site's tRPC endpoints.
  const res = await fetch(url, { headers: TRPC_BROWSER_HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ModelError(`CivitAI leaderboard ${res.status}: ${res.statusText}`, {
      url,
      status: res.status,
      body,
    });
  }
  const data = (await res.json()) as {
    result?: { data?: { json?: CivitaiLeaderboardEntry[] } };
  };
  const entries = data.result?.data?.json ?? [];
  const metric = (e: CivitaiLeaderboardEntry, type: string) =>
    e.metrics?.find((m) => m.type === type)?.value;
  return entries
    .filter((e) => e.user?.username && !e.user.deletedAt)
    .slice(0, limit)
    .map((e) => ({
      username: e.user!.username!,
      profile_url: creatorProfileUrl(e.user!.username!),
      position: e.position,
      score: e.score,
      downloads: metric(e, "downloadCount"),
      thumbs_up: metric(e, "thumbsUpCount"),
      generations: metric(e, "generationCount"),
      entries: metric(e, "entries"),
    }));
}
