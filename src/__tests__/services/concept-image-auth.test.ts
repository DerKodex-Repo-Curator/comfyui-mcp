import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGrokOAuthBearer,
  __testing,
} from "../../services/concept-image-auth.js";

const { GROK_AUTH_SCOPE_KEY } = __testing;

describe("resolveGrokOAuthBearer", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "grok-oauth-test-"));
  });

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    delete process.env.XAI_API_KEY;
  });

  async function writeAuth(entry: Record<string, unknown>): Promise<void> {
    const dir = join(home, ".grok");
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ [GROK_AUTH_SCOPE_KEY]: entry }, null, 2),
      "utf8",
    );
  }

  it("returns a valid non-expired OAuth bearer without refresh", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".grok"), { recursive: true });
    await writeAuth({
      key: "live-bearer-token",
      refresh_token: "rt-1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      auth_mode: "oidc",
      oidc_client_id: __testing.XAI_OAUTH_CLIENT_ID,
    });

    const token = await resolveGrokOAuthBearer({
      home,
      now: () => Date.now(),
    });
    expect(token).toBe("live-bearer-token");
  });

  it("ignores XAI_API_KEY and uses Grok CLI OAuth only", async () => {
    process.env.XAI_API_KEY = "developer-key-should-not-be-used";
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".grok"), { recursive: true });
    await writeAuth({
      key: "oauth-only-token",
      refresh_token: "rt-1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const token = await resolveGrokOAuthBearer({ home });
    expect(token).toBe("oauth-only-token");
  });

  it("refreshes expired tokens and persists updated auth.json", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".grok"), { recursive: true });
    await writeAuth({
      key: "stale-token",
      refresh_token: "rt-rotate",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      auth_mode: "oidc",
    });

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "rt-new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const now = Date.now();
    const token = await resolveGrokOAuthBearer({
      home,
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });

    expect(token).toBe("fresh-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("rt-rotate");

    const saved = JSON.parse(
      await readFile(join(home, ".grok", "auth.json"), "utf8"),
    ) as Record<string, { key?: string; refresh_token?: string }>;
    expect(saved[GROK_AUTH_SCOPE_KEY].key).toBe("fresh-token");
    expect(saved[GROK_AUTH_SCOPE_KEY].refresh_token).toBe("rt-new");
  });

  it("throws when auth.json is missing", async () => {
    await expect(resolveGrokOAuthBearer({ home })).rejects.toThrow(/grok login/i);
  });
});

describe("concept-image-auth helpers", () => {
  it("parseExpiresAt handles ISO and unix seconds", () => {
    const iso = "2026-07-06T01:42:13.308773Z";
    expect(__testing.parseExpiresAt(iso)).toBe(Date.parse(iso));
    expect(__testing.parseExpiresAt(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("tokenIsExpiring respects skew window", () => {
    const now = 1_700_000_000_000;
    expect(
      __testing.tokenIsExpiring({ expires_at: now + 30_000 }, now, 60_000),
    ).toBe(true);
    expect(
      __testing.tokenIsExpiring({ expires_at: now + 180_000 }, now, 60_000),
    ).toBe(false);
  });
});