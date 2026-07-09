import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

describe("panel-secrets credential slots", () => {
  beforeEach(() => {
    process.env.COMFYUI_MCP_PANEL_SECRETS = join(tmpdir(), `secrets-${randomUUID()}.json`);
    for (const k of ["OPENROUTER_API_KEY","XAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","HF_TOKEN","HUGGINGFACE_TOKEN","GLM_API_KEY","ZHIPU_API_KEY","ZHIPUAI_API_KEY","ZAI_API_KEY","KIMI_API_KEY","RUNCOMFY_API_KEY","REGISTRY_ACCESS_TOKEN","CIVITAI_API_TOKEN"]) delete process.env[k];
  });

  it("fans a slot out to all its env keys in the right store file", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("huggingface", "hf_abc123456789");
    const file = JSON.parse(readFileSync(process.env.COMFYUI_MCP_PANEL_SECRETS!, "utf-8"));
    expect(file.comfyuiEnv.HF_TOKEN).toBe("hf_abc123456789");
    expect(file.comfyuiEnv.HUGGINGFACE_TOKEN).toBe("hf_abc123456789");
  });

  it("routes a provider slot to the agent store and hydrates env", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("glm", "glm-secret-xyz789");
    const file = JSON.parse(readFileSync(process.env.COMFYUI_MCP_PANEL_SECRETS!, "utf-8"));
    expect(file.agentEnv.GLM_API_KEY).toBe("glm-secret-xyz789");
    expect(process.env.GLM_API_KEY).toBe("glm-secret-xyz789");
  });

  it("rejects an unknown slot", async () => {
    const m = await import("../../services/panel-secrets.js");
    expect(() => m.setPanelSecret("not-a-slot", "x")).toThrow(/unknown credential slot/i);
  });

  it("lists masked state without leaking values", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("openrouter", "sk-or-v1-abcdef123456");
    const rows = m.listPanelSecretsMasked();
    const or = rows.find((r) => r.id === "openrouter")!;
    expect(or.set).toBe(true);
    expect(or.masked).toBe("sk-o…456");
    expect(JSON.stringify(rows)).not.toContain("abcdef");
    const civ = rows.find((r) => r.id === "civitai")!;
    expect(civ.set).toBe(false);
    expect(civ.masked).toBeNull();
  });
});
