// oauth-flow.ts — generic OAuth engine for in-panel provider sign-in.
// Two primitives (loopback-PKCE, device-code) driven by a per-provider config.
// SECURITY: PKCE S256 + state on every loopback exchange; loopback bound to
// 127.0.0.1 only and torn down after use; bearer only sent to allowlisted HTTPS
// hosts; token material never logged. See docs/superpowers/specs/2026-07-11-oauth-in-panel-design.md.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export type OAuthFlowKind = "loopback_pkce" | "device_code";

export interface OAuthProviderConfig {
  id: "grok" | "codex" | "copilot";
  label: string;
  kind: OAuthFlowKind;
  authorizeUrl: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  clientId: string;
  scopes: string[];
  loopbackPort?: number;
  redirectPath?: string;
  tokenFile: string;
  apiHostAllowlist: string[];
  experimental?: boolean;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  raw: Record<string, unknown>;
}

export interface OAuthDeps {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void> | void;
  now?: () => number;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** S256 PKCE pair. verifier: 43-128 chars unreserved; challenge = base64url(sha256(verifier)). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32)); // 43 base64url chars, all in the unreserved set
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Throw unless `url` is HTTPS on an allowlisted host (exact host or a subdomain of one). */
export function assertAllowedTokenHost(url: string, allowlist: string[]): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ValidationError(`OAuth: malformed URL "${String(url).slice(0, 80)}"`);
  }
  if (u.protocol !== "https:") throw new ValidationError(`OAuth: refusing non-HTTPS token host "${u.protocol}"`);
  const host = u.hostname.toLowerCase();
  const ok = allowlist.some((a) => {
    const base = a.toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  });
  if (!ok) throw new ValidationError(`OAuth: token host "${host}" not in allowlist [${allowlist.join(", ")}]`);
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    logger.warn(`[oauth] could not open a browser automatically — visit: ${url}`);
  }
}

/**
 * Loopback authorization-code + PKCE. Binds 127.0.0.1:cfg.loopbackPort, opens the
 * browser to the authorize URL, resolves when the provider redirects back with a
 * matching state, exchanges the code, and always tears the listener down.
 */
export function runLoopbackPKCE(cfg: OAuthProviderConfig, deps: OAuthDeps = {}): Promise<OAuthTokens> {
  const fetchFn = deps.fetch ?? fetch;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const port = cfg.loopbackPort ?? 0;
  const redirectPath = cfg.redirectPath ?? "/auth/callback";
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));

  return new Promise<OAuthTokens>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${addrPort}`);
        if (url.pathname !== redirectPath) {
          res.writeHead(404).end("not found");
          return;
        }
        const code = url.searchParams.get("code");
        const gotState = url.searchParams.get("state");
        if (!gotState || gotState !== state) {
          res.writeHead(400).end("state mismatch");
          done(() => reject(new ValidationError("OAuth: callback state did not match — aborting (possible CSRF).")));
          return;
        }
        if (!code) {
          res.writeHead(400).end("missing code");
          done(() => reject(new ValidationError("OAuth: callback missing authorization code.")));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" }).end(
          "<html><body style='font:14px system-ui;padding:2rem'>Signed in — you can close this tab and return to ComfyUI.</body></html>",
        );
        // Exchange the code.
        assertAllowedTokenHost(cfg.tokenUrl, cfg.apiHostAllowlist);
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: cfg.clientId,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        });
        const tokRes = await fetchFn(cfg.tokenUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await tokRes.text();
        if (!tokRes.ok) {
          done(() => reject(new ValidationError(`OAuth token exchange failed (${tokRes.status}): ${text.slice(0, 300)}`)));
          return;
        }
        const raw = JSON.parse(text) as Record<string, unknown>;
        const access = String(raw.access_token ?? "").trim();
        if (!access) {
          done(() => reject(new ValidationError("OAuth token exchange response missing access_token.")));
          return;
        }
        done(() =>
          resolve({
            access_token: access,
            refresh_token: raw.refresh_token ? String(raw.refresh_token) : undefined,
            id_token: raw.id_token ? String(raw.id_token) : undefined,
            expires_in: typeof raw.expires_in === "number" ? raw.expires_in : undefined,
            raw,
          }),
        );
      } catch (err) {
        done(() => reject(err instanceof Error ? err : new ValidationError(String(err))));
      }
    });

    let addrPort = port;
    let redirectUri = "";
    const timer = setTimeout(
      () => done(() => reject(new ValidationError("OAuth sign-in timed out (5 min) — no callback received."))),
      5 * 60_000,
    );

    server.on("error", (err) => done(() => reject(err)));
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      addrPort = typeof addr === "object" && addr ? addr.port : port;
      redirectUri = `http://127.0.0.1:${addrPort}${redirectPath}`;
      const authUrl = new URL(cfg.authorizeUrl);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", cfg.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", cfg.scopes.join(" "));
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      Promise.resolve(openBrowser(authUrl.toString())).catch((err) =>
        done(() => reject(err instanceof Error ? err : new ValidationError(String(err)))),
      );
    });
  });
}

const codexTokenFile = join(homedir(), ".codex", "auth.json");
const grokTokenFile = join(homedir(), ".grok", "auth.json");
const copilotTokenFile = join(homedir(), ".comfyui-mcp", "copilot-auth.json");

/** Provider registry. Codex always present; grok added ONLY if Task 1 was GO
 *  (fill in clientId/scopes from the recorded decision); copilot in Task 3. */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  codex: {
    id: "codex",
    label: "ChatGPT",
    kind: "loopback_pkce",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    scopes: ["openid", "profile", "email", "offline_access"],
    loopbackPort: 1455,
    redirectPath: "/auth/callback",
    tokenFile: codexTokenFile,
    apiHostAllowlist: ["auth.openai.com", "chatgpt.com"],
  },
  // grok: Task 1 recorded GO — clientId/scopes/endpoints from the recorded decision.
  grok: {
    id: "grok",
    label: "Grok",
    kind: "loopback_pkce",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    loopbackPort: 56121,
    redirectPath: "/callback",
    tokenFile: grokTokenFile,
    apiHostAllowlist: ["x.ai"],
  },
};

export { grokTokenFile, copilotTokenFile };
