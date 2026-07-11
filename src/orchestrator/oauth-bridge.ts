// oauth-bridge.ts — panel↔orchestrator bridge handlers for in-panel OAuth:
// oauth_begin / oauth_status / oauth_signout. Extracted as pure, deps-injected
// functions so they're unit-testable without a live bridge/socket — index.ts's
// onPanelMessage dispatch just forwards the matching control frames here and
// ships the reply back over the bridge (see docs/superpowers/specs/2026-07-11-
// oauth-in-panel-design.md).
//
// SECURITY: every reply here is STATUS ONLY — provider id, account_label, mode,
// user_code, verification_url. Access/refresh/id tokens never leave oauth-flow.ts
// / code-provider-auth.ts, and never flow through these handlers or their
// return values. Copilot (`experimental: true` in OAUTH_PROVIDERS) is refused
// unless the caller explicitly passes allow_experimental:true — the panel only
// sets that from its experimental row, never by default.

import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  OAUTH_PROVIDERS,
  runLoopbackPKCE,
  beginDeviceCode,
  pollDeviceToken,
  type OAuthDeps,
  type OAuthProviderConfig,
} from "../services/oauth-flow.js";
import {
  persistOAuthResult,
  readOAuthStatus,
  clearOAuth,
  type CodeProviderAuthDeps,
} from "../services/code-provider-auth.js";
import type { OAuthStatusRecord } from "../services/panel-secrets.js";

/** Injected dependencies for the three handlers — lets tests mock the flow
 *  engine + persistence without touching the network or the filesystem. */
export interface OAuthBridgeDeps {
  /** Provider registry override (defaults to the real OAUTH_PROVIDERS). */
  providers?: Record<string, OAuthProviderConfig>;
  runLoopbackPKCE?: typeof runLoopbackPKCE;
  beginDeviceCode?: typeof beginDeviceCode;
  pollDeviceToken?: typeof pollDeviceToken;
  persistOAuthResult?: typeof persistOAuthResult;
  readOAuthStatus?: typeof readOAuthStatus;
  clearOAuth?: typeof clearOAuth;
  /** Forwarded to runLoopbackPKCE/beginDeviceCode/pollDeviceToken (fetch/openBrowser/now). */
  oauthFlowDeps?: OAuthDeps;
  /** Forwarded to persistOAuthResult/clearOAuth (home/fetch/now). */
  codeProviderAuthDeps?: CodeProviderAuthDeps;
  /** Fired once a loopback/device sign-in (or a sign-out) actually lands, so the
   *  caller can push a refreshed `{type:"backends"}` readiness frame. */
  onAuthChanged?: (providerId: string) => void;
  /** Best-effort error sink for a BACKGROUND loopback/device flow failure — the
   *  oauth_begin reply has already gone out by the time this can fire. Message
   *  text only (already redacted upstream) — never receives token material. */
  onBackgroundError?: (providerId: string, message: string) => void;
}

function resolveProvider(providerId: unknown, deps: OAuthBridgeDeps): OAuthProviderConfig {
  const id = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  const providers = deps.providers ?? OAUTH_PROVIDERS;
  const cfg = id ? providers[id] : undefined;
  if (!cfg) {
    throw new ValidationError(
      `Unknown OAuth provider "${String(providerId ?? "")}". Known providers: ${Object.keys(providers).join(", ")}.`,
    );
  }
  return cfg;
}

export interface OAuthBeginResult {
  mode: "loopback" | "device";
  opened?: boolean;
  user_code?: string;
  verification_url?: string;
}

/**
 * `oauth_begin {provider, allow_experimental?}` — starts sign-in for `provider`.
 *
 * - loopback providers (codex, grok): returns immediately with
 *   `{mode:"loopback", opened:true}`; the browser round-trip + token exchange
 *   run in the BACKGROUND (never blocking the bridge socket) and, on success,
 *   persist the result then call `onAuthChanged`.
 * - device providers (copilot): awaits the device-code request (fast — one
 *   HTTP round trip) and returns `{mode:"device", user_code,
 *   verification_url}` for the panel to display, then polls for completion in
 *   the background the same way.
 *
 * copilot (and any future `experimental:true` provider) is REFUSED unless
 * `allow_experimental === true`.
 */
export async function handleOAuthBegin(
  args: { provider?: unknown; allow_experimental?: unknown },
  deps: OAuthBridgeDeps = {},
): Promise<OAuthBeginResult> {
  const cfg = resolveProvider(args.provider, deps);
  if (cfg.experimental && args.allow_experimental !== true) {
    throw new ValidationError(
      `${cfg.label} sign-in is experimental (ToS risk) — refused unless explicitly enabled from the experimental row.`,
    );
  }

  const doLoopback = deps.runLoopbackPKCE ?? runLoopbackPKCE;
  const doBeginDevice = deps.beginDeviceCode ?? beginDeviceCode;
  const doPollDevice = deps.pollDeviceToken ?? pollDeviceToken;
  const doPersist = deps.persistOAuthResult ?? persistOAuthResult;
  const flowDeps = deps.oauthFlowDeps ?? {};
  const authDeps = deps.codeProviderAuthDeps ?? {};

  const onFlowError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[oauth-bridge] ${cfg.id} sign-in failed: ${message}`);
    deps.onBackgroundError?.(cfg.id, message);
  };

  if (cfg.kind === "loopback_pkce") {
    // Fire-and-forget: the actual sign-in completes in the browser the flow
    // opens, entirely out-of-band from this reply.
    void doLoopback(cfg, flowDeps)
      .then((tokens) => doPersist(cfg.id, tokens, authDeps))
      .then(() => deps.onAuthChanged?.(cfg.id))
      .catch(onFlowError);
    return { mode: "loopback", opened: true };
  }

  // device_code
  const { user_code, verification_url, device_code } = await doBeginDevice(cfg, flowDeps);
  void doPollDevice(cfg, device_code, flowDeps)
    .then((tokens) => doPersist(cfg.id, tokens, authDeps))
    .then(() => deps.onAuthChanged?.(cfg.id))
    .catch(onFlowError);
  return { mode: "device", user_code, verification_url };
}

/** `oauth_status {}` — the status-only mirror (provider/account_label/timestamps)
 *  for every provider ever signed into via the panel. Never token material. */
export function handleOAuthStatus(
  _args: Record<string, unknown>,
  deps: OAuthBridgeDeps = {},
): { providers: OAuthStatusRecord[] } {
  const doRead = deps.readOAuthStatus ?? readOAuthStatus;
  return { providers: doRead() };
}

/** `oauth_signout {provider}` — clears the native token file (best-effort) and
 *  the status mirror entry, then notifies `onAuthChanged` so readiness refreshes. */
export function handleOAuthSignout(
  args: { provider?: unknown },
  deps: OAuthBridgeDeps = {},
): { ok: true } {
  const cfg = resolveProvider(args.provider, deps);
  const doClear = deps.clearOAuth ?? clearOAuth;
  doClear(cfg.id, deps.codeProviderAuthDeps ?? {});
  deps.onAuthChanged?.(cfg.id);
  return { ok: true };
}
