import { describe, expect, it } from "vitest";
import { startPanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";

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
});