#!/usr/bin/env node
/**
 * Smoke-test PhotoMapAI MCP service against a running server.
 * Usage: npm run build && node scripts/test-photomap.mjs
 * Env: PHOTOMAP_URL (default http://127.0.0.1:8050)
 */
import { photomapHealth, photomapListAlbums } from "../dist/services/photomap.js";

const base = process.env.PHOTOMAP_URL ?? process.env.PHOTOMAP_BASE_URL ?? "http://127.0.0.1:8050";

console.log(`PhotoMapAI probe → ${base}\n`);

try {
  const health = await photomapHealth();
  console.log("photomap_health:", JSON.stringify(health, null, 2));

  const albums = await photomapListAlbums();
  console.log("\nphotomap_list_albums:");
  for (const a of albums.albums) {
    console.log(`  - ${a.key}${a.name ? ` (${a.name})` : ""}`);
  }
  if (albums.count === 0) {
    console.log("  (no albums — create one in PhotoMapAI Settings → Manage Albums)");
  }
  process.exit(0);
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  console.error("\nStart PhotoMapAI first: start_photomap  (or open the desktop app)");
  process.exit(1);
}