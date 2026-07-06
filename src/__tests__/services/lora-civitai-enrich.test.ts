import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", () => ({
  config: {
    civitaiApiToken: undefined as string | undefined,
    comfyuiPath: undefined as string | undefined,
  },
  getInstanceSlug: () => "test-instance",
}));

const listLocalModels = vi.fn();

vi.mock("../../services/model-resolver.js", () => ({
  listLocalModels: (...args: unknown[]) => listLocalModels(...args),
}));

import { config } from "../../config.js";
import {
  getLoraCatalog,
  resetLoraCatalog,
} from "../../services/lora-catalog.js";
import { enrichLoraCatalogFromCivitai } from "../../services/lora-civitai-enrich.js";

const fetchMock = vi.fn();

let dir: string;
let comfyDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lora-enrich-"));
  comfyDir = mkdtempSync(join(tmpdir(), "comfy-root-"));
  process.env.COMFYUI_MCP_LORA_CATALOG = join(dir, "lora-catalog.json");
  process.env.COMFYUI_MCP_LORA_PREVIEWS = join(dir, "previews");
  config.comfyuiPath = comfyDir;
  config.civitaiApiToken = undefined;
  listLocalModels.mockReset();
  resetLoraCatalog();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_LORA_CATALOG;
  delete process.env.COMFYUI_MCP_LORA_PREVIEWS;
  config.comfyuiPath = undefined;
  resetLoraCatalog();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  rmSync(comfyDir, { recursive: true, force: true });
});

describe("enrichLoraCatalogFromCivitai", () => {
  it("enriches entry from hash lookup and version details", async () => {
    const loraDir = join(comfyDir, "models", "loras");
    mkdirSync(loraDir, { recursive: true });
    const loraPath = join(loraDir, "style.safetensors");
    writeFileSync(loraPath, "tiny-lora-bytes", { flag: "w" });

    const catalog = getLoraCatalog();
    catalog.upsert({ relPath: "loras/style.safetensors" });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 99,
          modelId: 12,
          name: "Style v1",
          trainedWords: ["styletag", "another"],
          baseModel: "SDXL",
          model: { id: 12, name: "Cool Style", tags: ["anime"] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 99,
          modelId: 12,
          name: "Style v1",
          trainedWords: ["styletag", "another"],
          baseModel: "SDXL",
          model: { id: 12, name: "Cool Style", tags: ["anime"] },
        }),
      });

    const result = await enrichLoraCatalogFromCivitai({ id_or_path: "loras/style.safetensors" });

    expect(result.enriched).toBe(1);
    const entry = catalog.get("loras/style.safetensors");
    expect(entry?.civitaiVersionId).toBe(99);
    expect(entry?.keywords).toContain("styletag");
    expect(entry?.baseModels).toContain("SDXL");
    expect(entry?.sourceUrl).toContain("civitai.com/models/12");
  });
});