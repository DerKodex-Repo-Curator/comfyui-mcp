import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getInstanceSlug: () => "test-instance",
  };
});

import { LoraCatalog, resetLoraCatalog } from "../../services/lora-catalog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panel-console-"));
  process.env.COMFYUI_MCP_LORA_CATALOG = join(dir, "lora-catalog.json");
  process.env.COMFYUI_MCP_LORA_PREVIEWS = join(dir, "previews");
  resetLoraCatalog();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_LORA_CATALOG;
  delete process.env.COMFYUI_MCP_LORA_PREVIEWS;
  resetLoraCatalog();
  rmSync(dir, { recursive: true, force: true });
});

describe("panel-console-http", () => {
  it("serves /api/status and landing page on loopback", async () => {
    const srv = await startPanelConsoleHttpServer({
      port: 0,
      bridgePort: 9180,
      comfyuiUrl: "http://127.0.0.1:9500",
    });
    try {
      const statusRes = await fetch(`${srv.url}/api/status`);
      expect(statusRes.ok).toBe(true);
      const body = (await statusRes.json()) as { ok: boolean; bridge_port: number; backends: unknown[] };
      expect(body.ok).toBe(true);
      expect(body.bridge_port).toBe(9180);
      expect(Array.isArray(body.backends)).toBe(true);

      const htmlRes = await fetch(srv.url);
      expect(htmlRes.ok).toBe(true);
      const html = await htmlRes.text();
      expect(html).toContain("ComfyUI MCP Console");
    } finally {
      await srv.stop();
    }
  });

  it("serves LoRA preview images by catalog id", async () => {
    const previews = join(dir, "previews");
    mkdirSync(previews, { recursive: true });
    writeFileSync(join(previews, "thumb.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const catalog = new LoraCatalog();
    const entry = catalog.upsert({
      relPath: "loras/test.safetensors",
      displayName: "Test LoRA",
      previewFile: "thumb.png",
    });

    const srv = await startPanelConsoleHttpServer({
      port: 0,
      bridgePort: 9180,
      comfyuiUrl: "http://127.0.0.1:9500",
    });
    try {
      const miss = await fetch(`${srv.url}/api/lora-preview?id=missing`);
      expect(miss.status).toBe(404);

      const res = await fetch(`${srv.url}/api/lora-preview?id=${encodeURIComponent(entry.id)}`);
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toMatch(/image\/png/);
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.slice(0, 4).toString("hex")).toBe("89504e47");
    } finally {
      await srv.stop();
    }
  });
});