import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ValidationError } from "../utils/errors.js";

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

function codexAuthPath(home = homedir()): string {
  const root = process.env.CODEX_HOME || join(home, ".codex");
  return join(root, "auth.json");
}

function kimiCodeAuthPath(home = homedir()): string {
  const share = process.env.KIMI_SHARE_DIR || join(home, ".kimi");
  return join(share, "credentials", "kimi-code.json");
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

function jwtChatgptAccountId(idToken: string | undefined): string | null {
  if (!idToken?.trim()) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    };
    return payload["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() || null;
  } catch {
    return null;
  }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.auth-${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

export const __testing = {
  OPENAI_CODEX_CLIENT_ID,
  KIMI_CODE_CLIENT_ID,
  GLM_CODE_DEFAULT_BASE,
  KIMI_CODE_DEFAULT_BASE,
  codexAuthPath,
  kimiCodeAuthPath,
  jwtExpMs,
  jwtChatgptAccountId,
  refreshOpenAICodexTokens,
  refreshKimiCodeTokens,
};