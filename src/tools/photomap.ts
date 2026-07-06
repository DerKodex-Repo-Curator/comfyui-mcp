import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  photomapCurateAsync,
  photomapCurateProgress,
  photomapCurateSync,
  photomapExportDataset,
  photomapGetAlbum,
  photomapGetMetadata,
  photomapHealth,
  photomapImageInfo,
  photomapImagePath,
  photomapIndexProgress,
  photomapListAlbums,
  photomapSearch,
  photomapUpdateIndexAsync,
} from "../services/photomap.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerPhotomapTools(server: McpServer): void {
  server.tool(
    "photomap_health",
    "Check that PhotoMapAI is running and list how many albums are configured. " +
      "Default base URL http://127.0.0.1:8050; override with PHOTOMAP_URL or PHOTOMAP_BASE_URL.",
    {},
    async () => {
      try {
        const result = await photomapHealth();
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_list_albums",
    "List PhotoMapAI albums (key, name, image folders, index state). Requires PhotoMapAI server on PHOTOMAP_URL.",
    {},
    async () => {
      try {
        const result = await photomapListAlbums();
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_get_album",
    "Get one PhotoMapAI album by key.",
    {
      album_key: z.string().describe("Album key from photomap_list_albums"),
    },
    async (args) => {
      try {
        const result = await photomapGetAlbum(args.album_key);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_search",
    "CLIP text/image similarity search in a PhotoMapAI album. Returns ranked image indices and scores. " +
      "Chain with photomap_image_path then upload_image for ComfyUI workflows.",
    {
      album_key: z.string(),
      positive_query: z.string().optional().describe("Text to match (can combine with image_path)"),
      negative_query: z.string().optional().describe("Text to avoid"),
      image_path: z.string().optional().describe("Local reference image for similarity search"),
      image_weight: z.number().optional(),
      positive_weight: z.number().optional(),
      negative_weight: z.number().optional(),
      top_k: z.number().int().positive().optional().describe("Max results (default 10)"),
    },
    async (args) => {
      try {
        const result = await photomapSearch(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_image_path",
    "Resolve a PhotoMapAI album index to the on-disk file path (for upload_image / LoadImage when ComfyUI shares the filesystem).",
    {
      album_key: z.string(),
      index: z.number().int().nonnegative(),
    },
    async (args) => {
      try {
        const result = await photomapImagePath(args.album_key, args.index);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_image_info",
    "Get basic PhotoMapAI image info for an album index.",
    {
      album_key: z.string(),
      index: z.number().int().nonnegative(),
    },
    async (args) => {
      try {
        const result = await photomapImageInfo(args.album_key, args.index);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_get_metadata",
    "Download JSON metadata for a PhotoMapAI image (EXIF, InvokeAI gen params if present, etc.).",
    {
      album_key: z.string(),
      index: z.number().int().nonnegative(),
    },
    async (args) => {
      try {
        const result = await photomapGetMetadata(args.album_key, args.index);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_update_index",
    "Trigger async re-index of a PhotoMapAI album (e.g. after new ComfyUI outputs land in the album folder). Poll with photomap_index_progress.",
    {
      album_key: z.string(),
    },
    async (args) => {
      try {
        const result = await photomapUpdateIndexAsync(args.album_key);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_index_progress",
    "Poll PhotoMapAI index update progress for an album.",
    {
      album_key: z.string(),
    },
    async (args) => {
      try {
        const result = await photomapIndexProgress(args.album_key);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_curate_sync",
    "Run PhotoMapAI Monte Carlo curation synchronously (FPS or kmeans) to pick a diverse training subset. " +
      "Returns selected_indices and selected_files. PhotoMapAI MIT — requires server on PHOTOMAP_URL.",
    {
      album: z.string().describe("PhotoMap album key"),
      target_count: z.number().int().positive().describe("How many images to select"),
      iterations: z.number().int().min(1).max(30).optional().describe("Monte Carlo iterations (default 3)"),
      method: z.enum(["fps", "kmeans"]).optional().describe("fps (default) or kmeans"),
      excluded_indices: z.array(z.number().int().nonnegative()).optional(),
    },
    async (args) => {
      try {
        const result = await photomapCurateSync(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_curate",
    "Start async PhotoMapAI curation; poll with photomap_curate_progress until completed.",
    {
      album: z.string(),
      target_count: z.number().int().positive(),
      iterations: z.number().int().min(1).max(30).optional(),
      method: z.enum(["fps", "kmeans"]).optional(),
      excluded_indices: z.array(z.number().int().nonnegative()).optional(),
    },
    async (args) => {
      try {
        const result = await photomapCurateAsync(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_curate_progress",
    "Poll async PhotoMapAI curation job status and result.",
    {
      job_id: z.string(),
    },
    async (args) => {
      try {
        const result = await photomapCurateProgress(args.job_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "photomap_export",
    "Export selected image file paths from a PhotoMap album into a folder (copies sidecar captions when present).",
    {
      album: z.string(),
      filenames: z.array(z.string()).describe("Absolute file paths from curation selected_files"),
      output_folder: z.string().describe("Destination directory (created if needed)"),
    },
    async (args) => {
      try {
        const result = await photomapExportDataset(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}