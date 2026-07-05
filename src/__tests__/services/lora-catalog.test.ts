import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listLocalModels = vi.fn();

vi.mock("../../services/model-resolver.js", () => ({
  listLocalModels: (...args: unknown[]) => listLocalModels(...args),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getInstanceSlug: () => "test-instance",
  };
});

import {
  LoraCatalog,
  loraCatalogPath,
  loraIdFromPath,
  loraPreviewsDir,
  resetLoraCatalog,
} from "../../services/lora-catalog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lora-catalog-"));
  process.env.COMFYUI_MCP_LORA_CATALOG = join(dir, "lora-catalog.json");
  process.env.COMFYUI_MCP_LORA_PREVIEWS = join(dir, "previews");
  listLocalModels.mockReset();
  resetLoraCatalog();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_LORA_CATALOG;
  delete process.env.COMFYUI_MCP_LORA_PREVIEWS;
  resetLoraCatalog();
  rmSync(dir, { recursive: true, force: true });
});

describe("loraIdFromPath", () => {
  it("slugifies nested paths", () => {
    expect(loraIdFromPath("loras/styles/My_Style_v2.safetensors")).toBe(
      "loras-styles-my-style-v2",
    );
  });
});

describe("LoraCatalog", () => {
  it("sync adds new loras and preserves curated fields", async () => {
    listLocalModels.mockResolvedValue([
      {
        name: "anime.safetensors",
        path: "loras/anime.safetensors",
        size: 1024,
        modified: "2026-01-01T00:00:00.000Z",
        type: "loras",
      },
    ]);

    const catalog = new LoraCatalog();
    catalog.upsert({
      relPath: "loras/anime.safetensors",
      displayName: "Anime Style",
      description: "Soft anime look",
      keywords: ["anime style", "2d"],
      setupInstructions: "Use with SDXL at strength 0.8",
      baseModels: ["SDXL"],
      strengthDefault: 0.8,
    });

    const result = await catalog.syncFromDisk();
    expect(result.scanned).toBe(1);
    expect(result.added).toBe(0);

    const entry = catalog.get("anime");
    expect(entry?.displayName).toBe("Anime Style");
    expect(entry?.keywords).toEqual(["anime style", "2d"]);
    expect(entry?.missing).toBeFalsy();
    expect(entry?.fileSize).toBe(1024);
  });

  it("marks removed files as missing", async () => {
    listLocalModels
      .mockResolvedValueOnce([
        {
          name: "gone.safetensors",
          path: "loras/gone.safetensors",
          size: 1,
          modified: "",
          type: "loras",
        },
      ])
      .mockResolvedValueOnce([]);

    const catalog = new LoraCatalog();
    await catalog.syncFromDisk();
    expect(catalog.get("loras-gone")?.missing).toBeFalsy();

    await catalog.syncFromDisk();
    expect(catalog.get("loras-gone")?.missing).toBe(true);
  });

  it("upsert creates entries and persists to disk", () => {
    const catalog = new LoraCatalog();
    catalog.upsert({
      relPath: "loras/new.safetensors",
      description: "Test",
      keywords: ["foo"],
    });
    expect(existsSync(loraCatalogPath())).toBe(true);
    const raw = JSON.parse(readFileSync(loraCatalogPath(), "utf-8"));
    expect(Object.keys(raw.entries)).toHaveLength(1);
  });

  it("list filters by query", () => {
    const catalog = new LoraCatalog();
    catalog.upsert({ relPath: "loras/a.safetensors", keywords: ["portrait"] });
    catalog.upsert({ relPath: "loras/b.safetensors", keywords: ["landscape"] });
    expect(catalog.list({ query: "portrait" })).toHaveLength(1);
  });

  it("setPreview copies image into preview store", () => {
    const catalog = new LoraCatalog();
    catalog.upsert({ relPath: "loras/preview.safetensors" });
    const src = join(dir, "sample.png");
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const entry = catalog.setPreview("preview", src);
    expect(entry.previewFile).toBe(`${entry.id}.png`);
    expect(existsSync(join(loraPreviewsDir(), entry.previewFile!))).toBe(true);
  });
});