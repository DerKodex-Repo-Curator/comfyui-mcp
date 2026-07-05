import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ValidationError } from "../utils/errors.js";

export type ConceptImageProvider = "grok" | "google";

const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const GROK_AUTH_SCOPE_KEY = `https://auth.x.ai::${XAI_OAUTH_CLIENT_ID}`;
const GROK_ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME || homedir();
}

function grokHome(home = homedir()): string {
  return process.env.GROK_HOME || home;
}

function grokAuthPath(home = homedir()): string {
  return join(grokHome(home), ".grok", "auth.json");
}

interface GrokAuthEntry {
  key?: string;
  access_token?: string;
  refresh_token?: string;
  /** Grok CLI stores ISO-8601; some tools use unix ms. */
  expires_at?: string | number;
  oidc_client_id?: string;
  auth_mode?: string;
}

export type GrokOAuthDeps = {
  home?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

function parseExpiresAt(expiresAt: string | number | undefined): number | null {
  if (expiresAt == null) return null;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    // Heuristic: values < 1e12 are seconds; otherwise milliseconds.
    return expiresAt < 1_000_000_000_000 ? expiresAt * 1000 : expiresAt;
  }
  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const ms = Date.parse(expiresAt);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function accessTokenFromEntry(entry: GrokAuthEntry): string {
  return entry.key?.trim() || entry.access_token?.trim() || "";
}

function pickGrokAuthEntry(raw: Record<string, GrokAuthEntry>): {
  scopeKey: string;
  entry: GrokAuthEntry;
} | null {
  const preferred = raw[GROK_AUTH_SCOPE_KEY];
  if (preferred?.refresh_token?.trim() || accessTokenFromEntry(preferred)) {
    return { scopeKey: GROK_AUTH_SCOPE_KEY, entry: preferred };
  }

  for (const [scopeKey, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (scopeKey.includes("auth.x.ai") && (entry.refresh_token?.trim() || accessTokenFromEntry(entry))) {
      return { scopeKey, entry };
    }
  }

  for (const [scopeKey, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.refresh_token?.trim() || accessTokenFromEntry(entry)) {
      return { scopeKey, entry };
    }
  }
  return null;
}

function tokenIsExpiring(
  entry: GrokAuthEntry,
  nowMs: number,
  skewMs = GROK_ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  const expiryMs = parseExpiresAt(entry.expires_at);
  if (expiryMs == null) return false;
  return nowMs >= expiryMs - skewMs;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.auth-${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function refreshGrokOAuthEntry(
  entry: GrokAuthEntry,
  deps: GrokOAuthDeps,
): Promise<GrokAuthEntry> {
  const fetchFn = deps.fetch ?? fetch;
  const refreshToken = entry.refresh_token?.trim();
  if (!refreshToken) {
    throw new ValidationError(
      "Grok OAuth refresh_token is missing. Run `grok login` to sign in again.",
    );
  }

  const clientId = entry.oidc_client_id?.trim() || XAI_OAUTH_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });

  const res = await fetchFn(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 400
        ? " Run `grok login` to re-authenticate."
        : "";
    throw new ValidationError(
      `Grok OAuth token refresh failed (${res.status}): ${text.slice(0, 300)}.${hint}`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ValidationError("Grok OAuth token refresh returned non-JSON.");
  }

  const accessToken = String(payload.access_token ?? "").trim();
  if (!accessToken) {
    throw new ValidationError("Grok OAuth token refresh response missing access_token.");
  }

  const rotatedRefresh = String(payload.refresh_token ?? refreshToken).trim();
  const expiresIn = Number(payload.expires_in);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date((deps.now?.() ?? Date.now()) + expiresIn * 1000).toISOString()
      : entry.expires_at;

  return {
    ...entry,
    key: accessToken,
    access_token: accessToken,
    refresh_token: rotatedRefresh,
    expires_at: expiresAt,
    oidc_client_id: clientId,
    auth_mode: entry.auth_mode ?? "oidc",
  };
}

/**
 * Resolve a Grok SuperGrok OAuth bearer for Imagine API calls.
 * Uses ~/.grok/auth.json (from `grok login`) and refreshes expired tokens in place.
 * Developer API keys (XAI_API_KEY) are intentionally not supported.
 */
export async function resolveGrokOAuthBearer(deps: GrokOAuthDeps = {}): Promise<string> {
  const home = deps.home ?? homedir();
  const authPath = grokAuthPath(home);
  if (!existsSync(authPath)) {
    throw new ValidationError(
      "Grok image generation requires a signed-in Grok CLI (~/.grok/auth.json). Run `grok login` once.",
    );
  }

  const raw = JSON.parse(await readFile(authPath, "utf8")) as Record<string, GrokAuthEntry>;
  const picked = pickGrokAuthEntry(raw);
  if (!picked) {
    throw new ValidationError(
      "No Grok OAuth credentials in ~/.grok/auth.json. Run `grok login` to sign in.",
    );
  }

  const nowMs = deps.now?.() ?? Date.now();
  let entry = picked.entry;

  if (tokenIsExpiring(entry, nowMs) || !accessTokenFromEntry(entry)) {
    entry = await refreshGrokOAuthEntry(entry, deps);
    raw[picked.scopeKey] = entry;
    await atomicWriteJson(authPath, raw);
  }

  const bearer = accessTokenFromEntry(entry);
  if (!bearer) {
    throw new ValidationError(
      "Grok OAuth access token is missing after refresh. Run `grok login` to sign in.",
    );
  }
  return bearer;
}

/** @deprecated Use resolveGrokOAuthBearer — API keys are not supported for Grok images. */
export async function resolveGrokApiKey(home = homedir()): Promise<string> {
  return resolveGrokOAuthBearer({ home });
}

/** Resolve a Google API key (env) or a non-expired Gemini CLI OAuth access token. */
export async function resolveGoogleImageAuth(home = homedir()): Promise<
  | { kind: "api_key"; token: string }
  | { kind: "oauth"; accessToken: string }
> {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (apiKey) return { kind: "api_key", token: apiKey };

  const oauthPath = join(geminiHome(), ".gemini", "oauth_creds.json");
  if (!existsSync(oauthPath)) {
    throw new ValidationError(
      "Google image generation requires GEMINI_API_KEY (or GOOGLE_API_KEY) or a signed-in Gemini CLI " +
        "(~/.gemini/oauth_creds.json). Run `gemini` once or set GEMINI_API_KEY.",
    );
  }

  const creds = JSON.parse(await readFile(oauthPath, "utf8")) as {
    access_token?: string;
    expiry_date?: number;
  };
  const access = creds.access_token?.trim();
  if (!access) {
    throw new ValidationError("Gemini OAuth creds exist but access_token is missing. Re-run `gemini` to sign in.");
  }
  const expiry = creds.expiry_date;
  if (typeof expiry === "number" && expiry > 0 && Date.now() >= expiry - 60_000) {
    throw new ValidationError(
      "Gemini OAuth access token is expired. Re-run `gemini` to refresh, or set GEMINI_API_KEY.",
    );
  }
  return { kind: "oauth", accessToken: access };
}

// Test-only exports
export const __testing = {
  GROK_AUTH_SCOPE_KEY,
  XAI_OAUTH_CLIENT_ID,
  pickGrokAuthEntry,
  parseExpiresAt,
  tokenIsExpiring,
  refreshGrokOAuthEntry,
  grokAuthPath,
};