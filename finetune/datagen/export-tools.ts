/**
 * Dump the FULL comfyui-mcp tool surface (name + description + category +
 * JSON Schema for all ~113 tools) to finetune/data/tools-full.json.
 *
 * Every training trajectory and eval run renders its tool list from this file,
 * so the model always trains against the exact schemas it will see at runtime.
 *
 * Run:  npm run ft:tools     (tsx; sets COMFYUI_URL so config.ts skips its
 * network port-probe at import time, same trick as docs:gen)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Env must be set before the tool modules load (config.ts probes at import).
process.env.COMFYUI_URL ??= "http://127.0.0.1:8188";
// Keep a developer's autoloaded workflows out of the canonical tool list.
process.env.COMFYUI_WORKFLOWS_DIR = mkdtempSync(join(tmpdir(), "comfyui-mcp-ft-"));

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(repoRoot, "finetune", "data");

async function main() {
  const { z } = await import("zod");
  const { collectToolCatalog } = await import("../../src/tools/index.js");

  const catalog = await collectToolCatalog();
  const tools = [...catalog.tools.values()].map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.schema ?? {}), { reused: "inline" }),
  }));

  const payload = JSON.stringify({ count: tools.length, tools }, null, 2);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "tools-full.json"), payload);

  // ~4 chars/token is close enough to size the training context window.
  const approxTokens = Math.round(payload.length / 4);
  const byCat = new Map<string, number>();
  for (const t of tools) byCat.set(t.category, (byCat.get(t.category) ?? 0) + 1);
  console.log(`[ft:tools] wrote ${tools.length} tools → finetune/data/tools-full.json`);
  console.log(`[ft:tools] payload ${payload.length} chars ≈ ${approxTokens} tokens`);
  for (const [cat, n] of byCat) console.log(`  ${cat}: ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
