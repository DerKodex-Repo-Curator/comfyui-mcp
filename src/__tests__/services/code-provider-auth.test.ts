import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGlmCodeCredentials,
  resolveKimiCodeOAuth,
  resolveOpenAICodexOAuth,
  __testing,
} from "../../services/code-provider-auth.js";

describe("resolveGlmCodeCredentials", () => {
  const keys = ["ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY", "ZHIPU_API_KEY"] as const;

  afterEach(() => {
    for (const k of keys) delete process.env[k];
    delete process.env.COMFYUI_MCP_GLM_BASE_URL;
  });

  it("reads ZAI_API_KEY and default base URL", () => {
    process.env.ZAI_API_KEY = "zai-test-key";
    const creds = resolveGlmCodeCredentials();
    expect(creds.apiKey).toBe("zai-test-key");
    expect(creds.baseUrl).toBe(__testing.GLM_CODE_DEFAULT_BASE);
  });

  it("throws when no GLM key is set", () => {
    expect(() => resolveGlmCodeCredentials()).toThrow(/ZAI_API_KEY/);
  });
});

describe("resolveOpenAICodexOAuth", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "codex-oauth-test-"));
  });

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("returns access token and account id from auth.json", async () => {
    const dir = join(home, ".codex");
    await mkdir(dir, { recursive: true });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: `hdr.${payload}.sig`,
          refresh_token: "rt-1",
          account_id: "acct-123",
        },
      }),
      "utf8",
    );

    const creds = await resolveOpenAICodexOAuth({ home, now: () => Date.now() });
    expect(creds.accessToken).toMatch(/^hdr\./);
    expect(creds.accountId).toBe("acct-123");
  });
});

describe("resolveKimiCodeOAuth", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kimi-oauth-test-"));
  });

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    delete process.env.KIMI_API_KEY;
  });

  it("prefers KIMI_API_KEY when set", async () => {
    process.env.KIMI_API_KEY = "kimi-api-key";
    const creds = await resolveKimiCodeOAuth({ home });
    expect(creds.accessToken).toBe("kimi-api-key");
    expect(creds.baseUrl).toBe(__testing.KIMI_CODE_DEFAULT_BASE);
  });

  it("refreshes expired kimi-code.json tokens", async () => {
    const credDir = join(home, ".kimi", "credentials");
    await mkdir(credDir, { recursive: true });
    await writeFile(
      join(credDir, "kimi-code.json"),
      JSON.stringify({
        access_token: "stale",
        refresh_token: "rt-kimi",
        expires_at: Math.floor(Date.now() / 1000) - 60,
      }),
      "utf8",
    );

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "fresh-kimi",
          refresh_token: "rt-kimi-2",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const creds = await resolveKimiCodeOAuth({
      home,
      fetch: fetchMock as typeof fetch,
      now: () => Date.now(),
    });
    expect(creds.accessToken).toBe("fresh-kimi");
    expect(fetchMock).toHaveBeenCalledOnce();
    const saved = JSON.parse(await readFile(join(credDir, "kimi-code.json"), "utf8")) as {
      access_token?: string;
    };
    expect(saved.access_token).toBe("fresh-kimi");
  });
});