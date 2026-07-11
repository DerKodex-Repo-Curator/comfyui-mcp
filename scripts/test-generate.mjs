#!/usr/bin/env node
/**
 * End-to-end test: drive the freshly-built comfyui-mcp (our branch) against a live
 * ComfyUI and actually generate an image. Proves the full path — tool call →
 * workflow build → enqueue → render → output file.
 *
 * Usage: COMFYUI_URL=http://127.0.0.1:8188 node scripts/test-generate.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
const CHECKPOINT = process.env.TEST_CHECKPOINT ?? "SD1.5_v1-5-pruned-emaonly-fp16.safetensors";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: { ...process.env, COMFYUI_URL, COMFYUI_MCP_PANEL_AUTOINSTALL: "0", COMFYUI_MCP_AUTOUPDATE: "0", LOG_LEVEL: "error" },
});

const mcp = new Client({ name: "gen-test", version: "0.0.0" });
await mcp.connect(transport);
const textOf = (r) => r.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(r);

console.log(`→ generate_image via our build against ${COMFYUI_URL}`);
const gen = await mcp.callTool({
  name: "generate_image",
  arguments: {
    prompt: "a golden retriever puppy sitting in a field of wildflowers, soft morning light, sharp focus",
    checkpoint: CHECKPOINT,
    width: 512, height: 512, steps: 20, cfg: 7, sampler: "euler", scheduler: "normal", seed: 42,
  },
});
const genText = textOf(gen);
console.log("  response:", genText.replace(/\s+/g, " ").slice(0, 220));
const pid = (genText.match(/([0-9a-f]{8}-[0-9a-f-]{27,})/) || genText.match(/prompt[_ ]?id[":\s]+([\w-]+)/i) || [])[1];
if (!pid) { console.log("  ⚠️ no prompt_id parsed — dumping full response:\n", genText); await mcp.close(); process.exit(1); }
console.log("  prompt_id:", pid);

// Poll ComfyUI history until the render completes
process.stdout.write("  rendering");
let outputs = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  process.stdout.write(".");
  const h = await fetch(`${COMFYUI_URL}/history/${pid}`).then((r) => r.json()).catch(() => ({}));
  const entry = h[pid];
  if (entry?.outputs && Object.keys(entry.outputs).length) { outputs = entry.outputs; break; }
  if (entry?.status?.status_str === "error") { console.log("\n  ✗ ComfyUI reported error:", JSON.stringify(entry.status).slice(0, 300)); await mcp.close(); process.exit(1); }
}
console.log("");
if (!outputs) { console.log("  ✗ timed out waiting for render"); await mcp.close(); process.exit(1); }

const imgs = Object.values(outputs).flatMap((o) => o.images ?? []);
console.log(`  ✅ rendered ${imgs.length} image(s):`);
for (const im of imgs) console.log(`     ${im.subfolder ? im.subfolder + "/" : ""}${im.filename} (${im.type})`);
await mcp.close();
console.log("\n✅ end-to-end generation PASSED — MCP drove ComfyUI to a finished render");
