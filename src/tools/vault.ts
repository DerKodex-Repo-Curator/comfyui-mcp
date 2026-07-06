import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createTrainingPackFromPhotomap,
  getTrainingPack,
  listTrainingPackImagePaths,
  listTrainingPacks,
} from "../services/training-pack.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerVaultTools(server: McpServer): void {
  server.tool(
    "vault_create_training_pack",
    "Curate a diverse image subset from a PhotoMapAI album (FPS/kmeans Monte Carlo), export to the local vault, " +
      "and write a training-pack manifest for RunComfy or local LoRA training. Requires PhotoMapAI on PHOTOMAP_URL.",
    {
      name: z.string().describe("Human-readable pack name (used in vault id)"),
      album: z.string().describe("PhotoMap album key"),
      target_count: z.number().int().positive().describe("Number of training images to select"),
      iterations: z.number().int().min(1).max(30).optional().describe("Monte Carlo iterations (default 3)"),
      method: z.enum(["fps", "kmeans"]).optional(),
      excluded_indices: z.array(z.number().int().nonnegative()).optional(),
      subject: z.string().optional().describe("Person/subject label for this LoRA pack"),
      notes: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await createTrainingPackFromPhotomap(args);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  manifest: result.manifest,
                  curation_summary: {
                    status: result.curation.status,
                    count: result.curation.count,
                    target_count: result.curation.target_count,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "vault_list_training_packs",
    "List training packs in the local vault (PhotoMap-curated image sets for LoRA training).",
    {},
    async () => {
      try {
        const packs = listTrainingPacks();
        return { content: [{ type: "text" as const, text: JSON.stringify(packs, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "vault_get_training_pack",
    "Get full manifest for one vault training pack by id.",
    {
      pack_id: z.string(),
    },
    async (args) => {
      try {
        const pack = getTrainingPack(args.pack_id);
        if (!pack) {
          return {
            content: [{ type: "text", text: `No training pack "${args.pack_id}".` }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(pack, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "vault_list_training_pack_images",
    "List absolute image paths inside a vault training pack (for runcomfy_trainer_upload_dataset_file).",
    {
      pack_id: z.string(),
    },
    async (args) => {
      try {
        const paths = listTrainingPackImagePaths(args.pack_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(paths, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}