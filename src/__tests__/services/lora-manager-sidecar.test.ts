import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  },
  getInstanceSlug: () => "test-instance",
}));

import { config } from "../../config.js";
import {
  getLoraCatalog,
  resetLoraCatalog,
} from "../../services/lora-catalog.js";
import {
  detectLoraManagerInstall,
  importLoraCatalogFromSidecars,
  mapSidecarToCatalogPatch,
  parseLoraManagerMetadata,
} from "../../services/lora-manager-sidecar.js";

let dir: string;
let comfyDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lora-sidecar-"));
  comfyDir = mkdtempSync(join(tmpdir(), "comfy-lm-"));
  process.env.COMFYUI_MCP_LORA_CATALOG = join(dir, "lora-catalog.json");
  process.env.COMFYUI_MCP_LORA_PREVIEWS = join(dir, "previews");
  config.comfyuiPath = comfyDir;
  resetLoraCatalog();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_LORA_CATALOG;
  delete process.env.COMFYUI_MCP_LORA_PREVIEWS;
  config.comfyuiPath = undefined;
  resetLoraCatalog();
  rmSync(dir, { recursive: true, force: true });
  rmSync(comfyDir, { recursive: true, force: true });
});

describe("parseLoraManagerMetadata", () => {
  it("parses trainedWords and usage_tips", () => {
    const meta = parseLoraManagerMetadata(
      JSON.stringify({
        file_name: "anime_style",
        model_name: "Anime Style LoRA",
        file_path: "/ComfyUI/models/loras/anime_style.safetensors",
        base_model: "SDXL 1.0",
        usage_tips: JSON.stringify({ strength: 0.7, strength_min: 0.5, strength_max: 0.9, clip_skip: 2 }),
        civitai: {
          id: 42,
          modelId: 7,
          trainedWords: ["anime", "2d style"],
          model: { name: "Anime Pack", tags: ["style"] },
        },
        modelDescription: "<p>Soft anime look</p>",
        tags: ["anime"],
      }),
    );
    expect(meta?.civitai?.trainedWords).toEqual(["anime", "2d style"]);
    const { patch, keywordsAdded } = mapSidecarToCatalogPatch(
      meta!,
      "loras/anime_style.safetensors",
    );
    expect(keywordsAdded).toBe(2);
    expect(patch.keywords).toEqual(["anime", "2d style"]);
    expect(patch.civitaiVersionId).toBe(42);
    expect(patch.civitaiModelId).toBe(7);
    expect(patch.strengthDefault).toBe(0.7);
    expect(patch.setupInstructions).toContain("CLIP skip: 2");
    expect(patch.description).toContain("Soft anime look");
    expect(patch.baseModels).toContain("SDXL 1.0");
  });
});

describe("importLoraCatalogFromSidecars", () => {
  it("imports sidecar next to lora file into catalog", async () => {
    const loraDir = join(comfyDir, "models", "loras", "styles");
    mkdirSync(loraDir, { recursive: true });
    const loraPath = join(loraDir, "cool.safetensors");
    writeFileSync(loraPath, "lora-bytes");
    writeFileSync(
      join(loraDir, "cool.metadata.json"),
      JSON.stringify({
        file_name: "cool",
        model_name: "Cool Style",
        file_path: loraPath,
        civitai: { id: 100, modelId: 10, trainedWords: ["cooltag"] },
        usage_tips: '{"strength":0.65}',
      }),
    );

    const catalog = getLoraCatalog();
    catalog.upsert({ relPath: "loras/styles/cool.safetensors" });

    const result = await importLoraCatalogFromSidecars();
    expect(result.scanned).toBe(1);
    expect(result.imported).toBe(1);

    const entry = catalog.get("loras/styles/cool.safetensors");
    expect(entry?.displayName).toBe("Cool Style");
    expect(entry?.keywords).toEqual(["cooltag"]);
    expect(entry?.civitaiVersionId).toBe(100);
    expect(entry?.strengthDefault).toBe(0.65);
    expect(entry?.sourceUrl).toContain("civitai.com/models/10");
  });

  it("copies preview when import_previews is true", async () => {
    const loraDir = join(comfyDir, "models", "loras");
    mkdirSync(loraDir, { recursive: true });
    const preview = join(loraDir, "thumb.png");
    writeFileSync(preview, "png-bytes");
    writeFileSync(join(loraDir, "x.safetensors"), "lora");
    writeFileSync(
      join(loraDir, "x.metadata.json"),
      JSON.stringify({
        file_path: join(loraDir, "x.safetensors"),
        preview_url: preview,
        civitai: { trainedWords: ["x"] },
      }),
    );

    getLoraCatalog().upsert({ relPath: "loras/x.safetensors" });

    const result = await importLoraCatalogFromSidecars({ import_previews: true });
    expect(result.previewsCopied).toBe(1);

    const entry = getLoraCatalog().get("loras/x.safetensors");
    expect(entry?.previewFile).toBeTruthy();
    const previewPath = join(dir, "previews", entry!.previewFile!);
    expect(existsSync(previewPath)).toBe(true);
    expect(readFileSync(previewPath, "utf-8")).toBe("png-bytes");
  });
});

describe("detectLoraManagerInstall", () => {
  it("detects custom node folder under ComfyUI", () => {
    const nodeDir = join(comfyDir, "custom_nodes", "ComfyUI-Lora-Manager");
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "package.json"), "{}");

    const det = detectLoraManagerInstall();
    expect(det.installed).toBe(true);
    expect(det.customNodePath).toBe(nodeDir);
  });
});