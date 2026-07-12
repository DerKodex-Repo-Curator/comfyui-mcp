import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// COMFY_API_KEY resolution: env var first, then ~/.comfy-api-key file fallback.
// File fallback originally contributed by @joaolvivas in
// joaolvivas/comfyui-mcp-byjlucas@4b989e4 and reimplemented in config.ts.
//
// config.ts calls os.homedir() at module-eval time; point it at a temp dir we
// control. The mock factory is hoisted but only EXECUTES on first import of the
// mocked module (inside each test's dynamic import), after fakeHome is set.
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome,
    default: { ...actual, homedir: () => fakeHome },
  };
});

const OLD_ENV = process.env;
const OLD_ARGV = process.argv;
const tempRoot = mkdtempSync(join(tmpdir(), "comfy-api-key-test-"));
const keyFile = join(tempRoot, ".comfy-api-key");

describe("COMFY_API_KEY resolution (env → ~/.comfy-api-key)", () => {
  beforeEach(() => {
    vi.resetModules();
    fakeHome = tempRoot;
    process.env = { ...OLD_ENV };
    process.argv = [...OLD_ARGV];
    // Empty-string (not delete) so dotenv can't re-inject from a package .env.
    process.env.COMFYUI_API_KEY = "";
    process.env.COMFYUI_URL = "";
    process.env.COMFYUI_PATH = "";
    process.env.COMFYUI_HOST = "";
    process.env.COMFYUI_PORT = "8188";
    process.env.COMFYUI_MCP_FORCE_REMOTE = "";
    process.env.COMFY_API_KEY = "";
    if (existsSync(keyFile)) unlinkSync(keyFile);
  });

  afterEach(() => {
    process.env = OLD_ENV;
    process.argv = OLD_ARGV;
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("uses the COMFY_API_KEY env var when set (file ignored)", async () => {
    writeFileSync(keyFile, "file-key\n");
    process.env.COMFY_API_KEY = "env-key";
    const mod = await import("../config.js");
    expect(mod.config.comfyApiKey).toBe("env-key");
  });

  it("falls back to trimmed ~/.comfy-api-key contents when env is unset", async () => {
    writeFileSync(keyFile, "  file-key-123\n\n");
    const mod = await import("../config.js");
    expect(mod.config.comfyApiKey).toBe("file-key-123");
  });

  it("is undefined when neither env nor file provides a key", async () => {
    const mod = await import("../config.js");
    expect(mod.config.comfyApiKey).toBeUndefined();
  });

  it("treats an empty/whitespace-only key file as no key", async () => {
    writeFileSync(keyFile, "   \n");
    const mod = await import("../config.js");
    expect(mod.config.comfyApiKey).toBeUndefined();
  });
});
