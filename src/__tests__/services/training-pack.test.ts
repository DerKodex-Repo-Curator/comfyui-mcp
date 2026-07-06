import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getInstanceSlug: () => "test-instance",
  };
});

const photomapCurateSync = vi.fn();
const photomapExportDataset = vi.fn();

vi.mock("../../services/photomap.js", () => ({
  photomapCurateSync: (...args: unknown[]) => photomapCurateSync(...args),
  photomapExportDataset: (...args: unknown[]) => photomapExportDataset(...args),
}));

import {
  createTrainingPackFromPhotomap,
  listTrainingPacks,
  trainingPacksRoot,
} from "../../services/training-pack.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "training-pack-"));
  process.env.COMFYUI_MCP_DATA_DIR = dir;
  photomapCurateSync.mockReset();
  photomapExportDataset.mockReset();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("training-pack", () => {
  it("creates manifest after curate + export", async () => {
    photomapCurateSync.mockResolvedValue({
      status: "success",
      count: 2,
      target_count: 2,
      selected_indices: [0, 1],
      selected_files: ["/album/a.jpg", "/album/b.jpg"],
    });
    photomapExportDataset.mockImplementation(async (input: { output_folder: string }) => {
      mkdirSync(input.output_folder, { recursive: true });
      writeFileSync(join(input.output_folder, "a.jpg"), "fake");
      writeFileSync(join(input.output_folder, "b.jpg"), "fake");
      return { status: "success", exported: 2, errors: [] };
    });

    const { manifest } = await createTrainingPackFromPhotomap({
      name: "Jane Doe LoRA",
      album: "jane",
      target_count: 2,
    });

    expect(manifest.curationSource).toBe("photomapai");
    expect(manifest.imageCount).toBe(2);
    expect(manifest.album).toBe("jane");

    const listed = listTrainingPacks();
    expect(listed.some((p) => p.id === manifest.id)).toBe(true);
    expect(trainingPacksRoot()).toContain("training-packs");
  });
});