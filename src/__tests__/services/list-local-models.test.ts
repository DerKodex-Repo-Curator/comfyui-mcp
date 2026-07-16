import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Per-test control over the comfyuiPath toggle.
vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
  },
}));

// Stub getClient so we control whether the HTTP REST path succeeds, fails, or
// throws (cloud mode).
const fetchApi = vi.fn();
const getClient = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: (...args: unknown[]) => getClient(...args),
}));

// Filesystem fallback hooks (readFile feeds the CivitAI sidecar enrichment).
const readdir = vi.fn();
const stat = vi.fn();
const readFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readdir: (...a: unknown[]) => readdir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readFile: (...a: unknown[]) => readFile(...a),
  // Unused by listLocalModels but required by other functions in the module.
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  utimes: vi.fn(),
}));

const { config } = await import("../../config.js");
const { listLocalModels } = await import("../../services/model-resolver.js");

beforeEach(() => {
  getClient.mockReset();
  fetchApi.mockReset();
  readdir.mockReset();
  stat.mockReset();
  readFile.mockReset();
  // Default: no sidecar next to any model file (enrichment is best-effort).
  readFile.mockRejectedValue(new Error("ENOENT"));
  config.comfyuiPath = "/comfy";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listLocalModels — HTTP-first with FS fallback", () => {
  it("returns HTTP /models/<dir> results when available (skips FS scan)", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models/checkpoints") {
        return new Response(JSON.stringify(["sd_xl_base_1.0.safetensors"]), {
          status: 200,
        });
      }
      return new Response("[]", { status: 200 });
    });
    const result = await listLocalModels("checkpoints");
    expect(result).toEqual([
      {
        name: "sd_xl_base_1.0.safetensors",
        path: "checkpoints/sd_xl_base_1.0.safetensors",
        size: 0,
        modified: "",
        type: "checkpoints",
      },
    ]);
    // FS scan must NOT have been attempted when HTTP yielded results.
    expect(readdir).not.toHaveBeenCalled();
  });

  it("falls back to filesystem when the HTTP endpoint returns empty", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("[]", { status: 200 }));
    readdir.mockResolvedValue(["my-lora.safetensors"]);
    stat.mockResolvedValue({
      isFile: () => true,
      size: 1024 * 1024 * 50,
      mtime: new Date("2026-06-01T12:00:00Z"),
    });
    const result = await listLocalModels("loras");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "my-lora.safetensors",
      type: "loras",
      size: 1024 * 1024 * 50,
      modified: "2026-06-01T12:00:00.000Z",
    });
  });

  it("enriches entries from the CivitAI sidecar: trigger words, base, and the source URL", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) =>
      path === "/models/loras"
        ? new Response(JSON.stringify(["detail.safetensors"]), { status: 200 })
        : new Response("[]", { status: 200 }),
    );
    readFile.mockResolvedValue(
      JSON.stringify({
        modelId: 162967,
        versionId: 183635,
        trainedWords: ["more detail"],
        baseModel: "SDXL 1.0",
        sourceUrl: "https://civitai.com/models/162967?modelVersionId=183635",
      }),
    );
    const result = await listLocalModels("loras");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "detail.safetensors",
      triggerWords: ["more detail"],
      baseModel: "SDXL 1.0",
      civitaiUrl: "https://civitai.com/models/162967?modelVersionId=183635",
    });
  });

  it("reconstructs the CivitAI URL from ids when the sidecar predates sourceUrl", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) =>
      path === "/models/loras"
        ? new Response(JSON.stringify(["a.safetensors", "b.safetensors"]), { status: 200 })
        : new Response("[]", { status: 200 }),
    );
    // a: version-only sidecar (no modelId, no sourceUrl); b: both ids, no sourceUrl.
    readFile.mockImplementation(async (p: string) =>
      String(p).includes("a.safetensors")
        ? JSON.stringify({ versionId: 28907 })
        : JSON.stringify({ modelId: 211726, versionId: 3101597 }),
    );
    const result = await listLocalModels("loras");
    expect(result.map((m) => m.civitaiUrl)).toEqual([
      "https://civitai.com/model-versions/28907",
      "https://civitai.com/models/211726?modelVersionId=3101597",
    ]);
  });

  it("returns empty (no throw) in cloud mode when no comfyuiPath is set", async () => {
    config.comfyuiPath = undefined;
    getClient.mockImplementation(() => {
      const err = new Error(
        "getClient is not supported in Comfy Cloud mode",
      ) as Error & { code: string };
      err.code = "CLOUD_UNSUPPORTED";
      throw err;
    });
    const result = await listLocalModels("checkpoints");
    expect(result).toEqual([]);
  });

  it("returns empty when HTTP is unreachable in remote mode (no FS path)", async () => {
    config.comfyuiPath = undefined;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("Not Found", { status: 404 }));
    const result = await listLocalModels("checkpoints");
    expect(result).toEqual([]);
  });
});
