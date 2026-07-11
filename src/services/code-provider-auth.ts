import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ValidationError } from "../utils/errors.js";
import { assertAllowedTokenHost, OAUTH_PROVIDERS, type OAuthTokens } from "./oauth-flow.js";
import {
  setOAuthStatus,
  listOAuthStatus,
  clearOAuthStatus,
  type OAuthStatusRecord,
} from "./panel-secrets.js";

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_OAUTH_TOKEN_URL = "https://api.kimi.com/oauth/token";

export const GLM_CODE_DEFAULT_BASE = "https://api.z.ai/api/coding/paas/v4";
export const KIMI_CODE_DEFAULT_BASE = "https://api.kimi.com/coding/v1";

const TOKEN_REFRESH_SKEW_MS = 120_000;

export type CodeProviderAuthDeps = {
  home?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export type OpenAICodexOAuthCredentials = {
  accessToken: string;
  accountId: string;
  authMode?: string;
};

export type GlmCodeCredentials = {
  apiKey: string;
  baseUrl: string;
};

export type KimiCodeOAuthCredentials = {
  accessToken: string;
  baseUrl: string;
};

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    id_token?: string;
  };
  last_refresh?: string;
}

interface KimiCodeAuthFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface GrokAuthFile {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
}

export interface GrokOAuthCredentials {
  accessToken: string;
}

function codexAuthPath(home = homedir()): string {
  const root = process.env.CODEX_HOME || join(home, ".codex");
  return join(root, "auth.json");
}

function kimiCodeAuthPath(home = homedir()): string {
  const share = process.env.KIMI_SHARE_DIR || join(home, ".kimi");
  return join(share, "credentials", "kimi-code.json");
}

function grokAuthPath(home = homedir()): string {
  return join(home, ".grok", "auth.json");
}

function copilotAuthPath(home = homedir()): string {
  return join(home, ".comfyui-mcp", "copilot-auth.json");
}

function jwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtChatgptAccountId(idToken: string | undefined): string | null {
  if (!idToken?.trim()) return null;
  const payload = decodeJwtPayload(idToken) as {
    "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    chatgpt_account_id?: string;
  } | null;
  if (!payload) return null;
  return (
    payload["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() ||
    payload.chatgpt_account_id?.trim() ||
    null
  );
}

/** Best-effort email claim from an id_token, for a human-readable account label. */
function jwtEmailClaim(idToken: string | undefined): string | null {
  if (!idToken?.trim()) return null;
  const payload = decodeJwtPayload(idToken) as { email?: string } | null;
  return payload?.email?.trim() || null;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  // Landing a fresh OAuth sign-in may be the FIRST write to this provider's
  // credential directory (e.g. ~/.grok didn't exist before Grok sign-in) —
  // unlike the resolve* paths above, which only ever re-write an existing
  // file. Ensure the parent dir exists so this stays a drop-in atomic writer
  // for both "update in place" and "create for the first time" callers.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.auth-${randomBytes(8).toString("hex")}.tmp`);
  // 0600 on the TEMP file so it is never world-readable even briefly, and so
  // `rename` carries that mode to the destination — this both creates new token
  // files 0600 AND prevents an in-place refresh from downgrading a pre-existing
  // 0600 file (e.g. ~/.codex/auth.json) to the umask default. This helper only
  // ever writes credential/token files, so 0600 is universally correct here.
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function tokenExpiring(expiryMs: number | null, nowMs: number, skewMs = TOKEN_REFRESH_SKEW_MS): boolean {
  if (expiryMs == null) return false;
  return nowMs >= expiryMs - skewMs;
}

async function refreshOpenAICodexTokens(
  refreshToken: string,
  deps: CodeProviderAuthDeps,
): Promise<{ access_token: string; refresh_token?: string }> {
  const fetchFn = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_CODEX_CLIENT_ID,
  });
  const res = await fetchFn(OPENAI_OAUTH_TOKEN_URL, {
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
    const hint = res.status === 401 || res.status === 400 ? " Run `codex login` to re-authenticate." : "";
    throw new ValidationError(
      `OpenAI Codex OAuth refresh failed (${res.status}): ${text.slice(0, 300)}.${hint}`,
    );
  }
  const payload = JSON.parse(text) as { access_token?: string; refresh_token?: string };
  const access = payload.access_token?.trim();
  if (!access) {
    throw new ValidationError("OpenAI Codex OAuth refresh response missing access_token.");
  }
  return { access_token: access, refresh_token: payload.refresh_token?.trim() };
}

async function refreshKimiCodeTokens(
  refreshToken: string,
  deps: CodeProviderAuthDeps,
): Promise<KimiCodeAuthFile> {
  const fetchFn = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: KIMI_CODE_CLIENT_ID,
  });
  const res = await fetchFn(KIMI_OAUTH_TOKEN_URL, {
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
    const hint = res.status === 401 || res.status === 400 ? " Re-run `kimi` / Kimi Code login." : "";
    throw new ValidationError(
      `Kimi Code OAuth refresh failed (${res.status}): ${text.slice(0, 300)}.${hint}`,
    );
  }
  const payload = JSON.parse(text) as KimiCodeAuthFile;
  const access = payload.access_token?.trim();
  if (!access) {
    throw new ValidationError("Kimi Code OAuth refresh response missing access_token.");
  }
  const nowSec = (deps.now?.() ?? Date.now()) / 1000;
  const expiresIn = Number(payload.expires_in);
  return {
    ...payload,
    access_token: access,
    refresh_token: payload.refresh_token?.trim() || refreshToken,
    expires_at:
      typeof payload.expires_at === "number" && Number.isFinite(payload.expires_at)
        ? payload.expires_at
        : Number.isFinite(expiresIn) && expiresIn > 0
          ? nowSec + expiresIn
          : undefined,
  };
}

/** Grok (xAI) OAuth refresh — mirrors `refreshOpenAICodexTokens`. Host-allowlist-checked
 *  against the provider config in oauth-flow.ts before any network call. */
async function refreshGrokTokens(
  refreshToken: string,
  deps: CodeProviderAuthDeps,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const cfg = OAUTH_PROVIDERS.grok;
  if (!cfg) throw new ValidationError("Grok OAuth is not configured.");
  assertAllowedTokenHost(cfg.tokenUrl, cfg.apiHostAllowlist);
  const fetchFn = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  const res = await fetchFn(cfg.tokenUrl, {
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
    const hint = res.status === 401 || res.status === 400 ? " Re-run Grok sign-in from the panel." : "";
    throw new ValidationError(
      `Grok OAuth refresh failed (${res.status}): ${text.slice(0, 300)}.${hint}`,
    );
  }
  const payload = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  const access = payload.access_token?.trim();
  if (!access) {
    throw new ValidationError("Grok OAuth refresh response missing access_token.");
  }
  return {
    access_token: access,
    refresh_token: payload.refresh_token?.trim(),
    expires_in: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
  };
}

/**
 * Resolve ChatGPT/Codex subscription OAuth from ~/.codex/auth.json (written by `codex login`).
 * Refreshes expired access tokens in place. Use with the Codex Responses backend — not api.openai.com.
 */
export async function resolveOpenAICodexOAuth(
  deps: CodeProviderAuthDeps = {},
): Promise<OpenAICodexOAuthCredentials> {
  const home = deps.home ?? homedir();
  const path = codexAuthPath(home);
  if (!existsSync(path)) {
    throw new ValidationError(
      "ChatGPT OAuth requires ~/.codex/auth.json. Run `codex login` once, then pick the ChatGPT (direct OAuth) backend.",
    );
  }

  const raw = JSON.parse(await readFile(path, "utf8")) as CodexAuthFile;
  const tokens = raw.tokens;
  if (!tokens?.access_token?.trim() && !tokens?.refresh_token?.trim()) {
    throw new ValidationError("No Codex OAuth tokens in ~/.codex/auth.json. Run `codex login`.");
  }

  const nowMs = deps.now?.() ?? Date.now();
  let accessToken = tokens.access_token?.trim() ?? "";
  const expMs = accessToken ? jwtExpMs(accessToken) : null;
  const needsRefresh = !accessToken || tokenExpiring(expMs, nowMs);

  if (needsRefresh) {
    const refreshToken = tokens.refresh_token?.trim();
    if (!refreshToken) {
      throw new ValidationError("Codex access token expired and refresh_token is missing. Run `codex login`.");
    }
    const refreshed = await refreshOpenAICodexTokens(refreshToken, deps);
    accessToken = refreshed.access_token;
    raw.tokens = {
      ...tokens,
      access_token: accessToken,
      refresh_token: refreshed.refresh_token ?? refreshToken,
    };
    raw.last_refresh = new Date(nowMs).toISOString();
    await atomicWriteJson(path, raw);
  }

  const accountId =
    tokens.account_id?.trim() ||
    jwtChatgptAccountId(tokens.id_token) ||
    "";
  if (!accountId) {
    throw new ValidationError(
      "Codex OAuth is missing chatgpt account_id. Run `codex login` again to refresh ~/.codex/auth.json.",
    );
  }

  return {
    accessToken,
    accountId,
    authMode: raw.auth_mode,
  };
}

/**
 * Resolve Grok (xAI) OAuth from ~/.grok/auth.json (written by the in-panel sign-in
 * via `persistOAuthResult`). Refreshes expired access tokens in place — mirrors
 * `resolveOpenAICodexOAuth`.
 */
export async function resolveGrokOAuth(
  deps: CodeProviderAuthDeps = {},
): Promise<GrokOAuthCredentials> {
  const home = deps.home ?? homedir();
  const path = grokAuthPath(home);
  if (!existsSync(path)) {
    throw new ValidationError(
      "Grok OAuth requires signing in via the panel's Connections tab first.",
    );
  }

  let creds = JSON.parse(await readFile(path, "utf8")) as GrokAuthFile;
  if (!creds.access_token?.trim() && !creds.refresh_token?.trim()) {
    throw new ValidationError("No Grok OAuth tokens in ~/.grok/auth.json. Sign in again from the panel.");
  }

  const nowMs = deps.now?.() ?? Date.now();
  const expMs = typeof creds.expires_at === "number" ? creds.expires_at * 1000 : null;
  const needsRefresh = !creds.access_token?.trim() || tokenExpiring(expMs, nowMs);

  if (needsRefresh) {
    const refreshToken = creds.refresh_token?.trim();
    if (!refreshToken) {
      throw new ValidationError("Grok access token expired and refresh_token is missing. Sign in again from the panel.");
    }
    const refreshed = await refreshGrokTokens(refreshToken, deps);
    const nowSec = Math.floor(nowMs / 1000);
    creds = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? refreshToken,
      expires_in: refreshed.expires_in,
      expires_at:
        typeof refreshed.expires_in === "number" ? nowSec + refreshed.expires_in : undefined,
    };
    await atomicWriteJson(path, creds);
  }

  const accessToken = creds.access_token?.trim();
  if (!accessToken) {
    throw new ValidationError("Grok OAuth access_token is missing after refresh.");
  }
  return { accessToken };
}

/** GLM Coding Plan API key (Z.AI). Env: ZAI_API_KEY, GLM_API_KEY, or ZHIPUAI_API_KEY. */
export function resolveGlmCodeCredentials(): GlmCodeCredentials {
  const apiKey =
    process.env.ZAI_API_KEY?.trim() ||
    process.env.GLM_API_KEY?.trim() ||
    process.env.ZHIPUAI_API_KEY?.trim() ||
    process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) {
    throw new ValidationError(
      "GLM Code API requires ZAI_API_KEY (or GLM_API_KEY / ZHIPUAI_API_KEY) from your Z.AI Coding Plan.",
    );
  }
  const baseUrl =
    process.env.COMFYUI_MCP_GLM_BASE_URL?.trim().replace(/\/$/, "") || GLM_CODE_DEFAULT_BASE;
  return { apiKey, baseUrl };
}

/**
 * Resolve Kimi Code subscription OAuth from ~/.kimi/credentials/kimi-code.json.
 * Falls back to KIMI_API_KEY when set (pay-per-token / CI).
 */
export async function resolveKimiCodeOAuth(
  deps: CodeProviderAuthDeps = {},
): Promise<KimiCodeOAuthCredentials> {
  const baseUrl =
    process.env.COMFYUI_MCP_KIMI_BASE_URL?.trim().replace(/\/$/, "") || KIMI_CODE_DEFAULT_BASE;

  const apiKey = process.env.KIMI_API_KEY?.trim();
  if (apiKey) {
    return { accessToken: apiKey, baseUrl };
  }

  const home = deps.home ?? homedir();
  const path = kimiCodeAuthPath(home);
  if (!existsSync(path)) {
    throw new ValidationError(
      "Kimi Code OAuth requires ~/.kimi/credentials/kimi-code.json (from Kimi Code login) or KIMI_API_KEY.",
    );
  }

  let creds = JSON.parse(await readFile(path, "utf8")) as KimiCodeAuthFile;
  const nowMs = deps.now?.() ?? Date.now();
  const nowSec = nowMs / 1000;
  const expirySec =
    typeof creds.expires_at === "number" && Number.isFinite(creds.expires_at)
      ? creds.expires_at
      : creds.access_token
        ? (jwtExpMs(creds.access_token) ?? 0) / 1000
        : null;

  const needsRefresh =
    !creds.access_token?.trim() ||
    (expirySec != null && nowSec >= expirySec - TOKEN_REFRESH_SKEW_MS / 1000);

  if (needsRefresh) {
    const refreshToken = creds.refresh_token?.trim();
    if (!refreshToken) {
      throw new ValidationError("Kimi Code access token expired and refresh_token is missing. Re-run Kimi Code login.");
    }
    creds = await refreshKimiCodeTokens(refreshToken, deps);
    await atomicWriteJson(path, creds);
  }

  const accessToken = creds.access_token?.trim();
  if (!accessToken) {
    throw new ValidationError("Kimi Code OAuth access_token is missing after refresh.");
  }

  return { accessToken, baseUrl };
}

/** Best-effort delete of a provider's native token file. Never throws — a
 *  missing file, missing directory, or permission wobble is not fatal to
 *  clearing the (separate) status mirror. */
function deleteNativeTokenFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

function nativeTokenFilePath(providerId: string, home: string): string | null {
  if (providerId === "codex") return codexAuthPath(home);
  if (providerId === "grok") return grokAuthPath(home);
  if (providerId === "copilot") return copilotAuthPath(home);
  return null;
}

/**
 * Persist the tokens an OAuth flow (`runLoopbackPKCE` / `pollDeviceToken` in
 * oauth-flow.ts) returned: writes the NATIVE token file in the shape that
 * provider's resolver reads (codex → `resolveOpenAICodexOAuth`, grok →
 * `resolveGrokOAuth`, copilot → the raw `{access_token, token_type}` GitHub
 * Copilot expects), derives a human-readable account label, and records a
 * STATUS-ONLY mirror entry via `setOAuthStatus` for the panel UI.
 *
 * SECURITY: only `account_label` (plus timestamps/flags) reaches the mirror —
 * never `access_token`/`refresh_token`/`id_token`. See panel-secrets.ts.
 */
export async function persistOAuthResult(
  providerId: string,
  tokens: OAuthTokens,
  deps: CodeProviderAuthDeps = {},
): Promise<{ account_label: string }> {
  const home = deps.home ?? homedir();
  const nowMs = deps.now?.() ?? Date.now();
  const experimental = providerId === "copilot";

  let accountLabel: string;
  let expiresAt: number | undefined;

  if (providerId === "codex") {
    const accountId = jwtChatgptAccountId(tokens.id_token) || "";
    const email = jwtEmailClaim(tokens.id_token);
    accountLabel = email || accountId || "ChatGPT account";
    const auth: CodexAuthFile = {
      auth_mode: "chatgpt",
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id: accountId || undefined,
        id_token: tokens.id_token,
      },
      last_refresh: new Date(nowMs).toISOString(),
    };
    await atomicWriteJson(codexAuthPath(home), auth);
    const expMs = jwtExpMs(tokens.access_token);
    expiresAt = expMs != null ? Math.floor(expMs / 1000) : undefined;
  } else if (providerId === "grok") {
    const email = jwtEmailClaim(tokens.id_token);
    accountLabel = email || "xAI account";
    const expiresIn = tokens.expires_in;
    const expAt =
      typeof expiresIn === "number" ? Math.floor(nowMs / 1000) + expiresIn : undefined;
    const auth: GrokAuthFile = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: expiresIn,
      expires_at: expAt,
    };
    await atomicWriteJson(grokAuthPath(home), auth);
    expiresAt = expAt;
  } else if (providerId === "copilot") {
    accountLabel = "GitHub Copilot";
    const tokenType =
      typeof tokens.raw?.token_type === "string" ? (tokens.raw.token_type as string) : "bearer";
    await atomicWriteJson(copilotAuthPath(home), {
      access_token: tokens.access_token,
      token_type: tokenType,
    });
  } else {
    throw new ValidationError(`persistOAuthResult: unknown OAuth provider "${providerId}".`);
  }

  setOAuthStatus({
    provider: providerId,
    account_label: accountLabel,
    obtained_at: nowMs,
    expires_at: expiresAt,
    experimental,
  });

  return { account_label: accountLabel };
}

/** All in-panel OAuth sign-ins' status (for the UI) — status only, never tokens. */
export function readOAuthStatus(): OAuthStatusRecord[] {
  return listOAuthStatus();
}

/** Sign a provider out: deletes its native token file (best-effort) and the
 *  status mirror entry. */
export function clearOAuth(providerId: string, deps: CodeProviderAuthDeps = {}): void {
  const home = deps.home ?? homedir();
  const path = nativeTokenFilePath(providerId, home);
  if (path) deleteNativeTokenFile(path);
  clearOAuthStatus(providerId);
}

export const __testing = {
  OPENAI_CODEX_CLIENT_ID,
  KIMI_CODE_CLIENT_ID,
  GLM_CODE_DEFAULT_BASE,
  KIMI_CODE_DEFAULT_BASE,
  codexAuthPath,
  kimiCodeAuthPath,
  grokAuthPath,
  copilotAuthPath,
  jwtExpMs,
  jwtChatgptAccountId,
  jwtEmailClaim,
  refreshOpenAICodexTokens,
  refreshKimiCodeTokens,
  refreshGrokTokens,
};