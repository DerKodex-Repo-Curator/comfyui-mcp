import { describe, expect, it, vi } from "vitest";
import { pkcePair, assertAllowedTokenHost, runLoopbackPKCE, OAUTH_PROVIDERS } from "./oauth-flow.js";
import { createHash } from "node:crypto";

describe("pkcePair", () => {
  it("produces a verifier and its S256 challenge (base64url, no padding)", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(challenge).not.toMatch(/[=+/]/); // base64url, unpadded
  });
  it("is different each call", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe("assertAllowedTokenHost", () => {
  it("accepts https on an allowlisted host (exact + subdomain)", () => {
    expect(() => assertAllowedTokenHost("https://api.x.ai/v1", ["api.x.ai"])).not.toThrow();
    expect(() => assertAllowedTokenHost("https://foo.x.ai/v1", ["x.ai"])).not.toThrow();
  });
  it("rejects http, off-host, and lookalike hosts", () => {
    expect(() => assertAllowedTokenHost("http://api.x.ai/v1", ["api.x.ai"])).toThrow(/https/i);
    expect(() => assertAllowedTokenHost("https://evil.example/v1", ["api.x.ai"])).toThrow(/allow/i);
    expect(() => assertAllowedTokenHost("https://api.x.ai.evil.com/v1", ["x.ai"])).toThrow(/allow/i);
  });
});

describe("runLoopbackPKCE", () => {
  const cfg = {
    id: "codex" as const, label: "ChatGPT", kind: "loopback_pkce" as const,
    authorizeUrl: "https://auth.example/oauth/authorize",
    tokenUrl: "https://auth.example/oauth/token",
    clientId: "test-client", scopes: ["openid"],
    loopbackPort: 0, redirectPath: "/auth/callback",
    tokenFile: "/tmp/unused.json", apiHostAllowlist: ["auth.example"],
  };

  it("verifies state and exchanges the code for tokens", async () => {
    let capturedAuthorizeUrl = "";
    const openBrowser = vi.fn(async (url: string) => {
      capturedAuthorizeUrl = url;
      // Simulate the provider redirecting back to the loopback with code+state.
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const redirect = u.searchParams.get("redirect_uri")!;
      await fetch(`${redirect}?code=THECODE&state=${state}`);
    });
    const fetchFn = vi.fn(async (url: string, init?: any) => {
      if (String(url) === cfg.tokenUrl) {
        const body = new URLSearchParams(init.body);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("THECODE");
        expect(body.get("code_verifier")).toMatch(/.+/);
        return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }), { status: 200 });
      }
      // The loopback self-fetch from openBrowser goes to the real listener — pass through.
      return (globalThis as any).__realFetch(url, init);
    });
    (globalThis as any).__realFetch = (globalThis as any).__realFetch ?? fetch;
    const tokens = await runLoopbackPKCE(cfg, { fetch: fetchFn as any, openBrowser });
    expect(tokens.access_token).toBe("AT");
    expect(tokens.refresh_token).toBe("RT");
    expect(capturedAuthorizeUrl).toContain("code_challenge=");
    expect(capturedAuthorizeUrl).toContain("code_challenge_method=S256");
  });

  it("redacts token-shaped material from a failed-exchange error message", async () => {
    const openBrowser = vi.fn(async (url: string) => {
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const redirect = u.searchParams.get("redirect_uri")!;
      await fetch(`${redirect}?code=THECODE&state=${state}`);
    });
    const fetchFn = vi.fn(async (url: string, init?: any) => {
      if (String(url) === cfg.tokenUrl) {
        return new Response(JSON.stringify({ error: "bad", access_token: "LEAKED123" }), { status: 400 });
      }
      return (globalThis as any).__realFetch(url, init);
    });
    (globalThis as any).__realFetch = (globalThis as any).__realFetch ?? fetch;
    const err = await runLoopbackPKCE(cfg, { fetch: fetchFn as any, openBrowser }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("bad");
    expect(message).not.toContain("LEAKED123");
    expect(message).toContain("<redacted>");
  });

  it("rejects a callback whose state does not match", async () => {
    const openBrowser = vi.fn(async (url: string) => {
      const redirect = new URL(url).searchParams.get("redirect_uri")!;
      await fetch(`${redirect}?code=X&state=WRONG`);
    });
    await expect(runLoopbackPKCE(cfg, { openBrowser })).rejects.toThrow(/state/i);
  });
});

describe("OAUTH_PROVIDERS", () => {
  it("always includes codex with the pinned loopback port and locked redirect", () => {
    const c = OAUTH_PROVIDERS.codex;
    expect(c.loopbackPort).toBe(1455);
    expect(c.redirectPath).toBe("/auth/callback");
    expect(c.clientId).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(c.tokenUrl).toBe("https://auth.openai.com/oauth/token");
    expect(c.apiHostAllowlist).toContain("auth.openai.com");
  });

  it("includes grok with the pinned client, endpoints, and loopback port", () => {
    const g = OAUTH_PROVIDERS.grok;
    expect(g.clientId).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(g.tokenUrl).toBe("https://auth.x.ai/oauth2/token");
    expect(g.apiHostAllowlist).toContain("x.ai");
    expect(g.loopbackPort).toBe(56121);
  });
});
