import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startPanelConsoleHttpServer, type PanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";

const TOKEN = "test-console-token";
let srv: PanelConsoleHttpServer;
const base = () => srv.url;

describe("console /api/secrets", () => {
  beforeEach(async () => {
    process.env.COMFYUI_MCP_PANEL_SECRETS = join(tmpdir(), `secrets-${randomUUID()}.json`);
    srv = await startPanelConsoleHttpServer({ port: 0, bridgePort: 9180, comfyuiUrl: "http://127.0.0.1:8188", token: TOKEN });
  });
  afterEach(async () => { await srv.stop(); });

  it("401s without the token", async () => {
    const r = await fetch(`${base()}/api/secrets`);
    expect(r.status).toBe(401);
  });

  it("lists masked slots with the token", async () => {
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.slots.find((s: any) => s.id === "openrouter")).toBeTruthy();
    expect(body.slots.every((s: any) => s.masked === null || typeof s.masked === "string")).toBe(true);
  });

  it("sets a key and reflects it masked; rejects unknown slot", async () => {
    const ok = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_123456789" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).masked).toBe("civ_…789");

    const bad = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "nope", value: "x" }),
    });
    expect(bad.status).toBe(400);
  });

  it("rejects an oversized body instead of hanging", async () => {
    const oversized = JSON.stringify({ slot: "civitai", value: "x".repeat(1_100_000) });
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(r.status).toBe(400);
    await r.text().catch(() => {});
  }, 5000);
});
