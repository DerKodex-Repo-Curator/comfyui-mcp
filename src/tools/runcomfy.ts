import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  runcomfyListPods,
  runcomfyQueue,
  runcomfySyncWorkflow,
} from "../services/runcomfy-connector.js";
import { errorToToolResult } from "../utils/errors.js";

const serverTypeSchema = z
  .enum(["medium", "large", "extra-large", "2x-large", "2xl-turbo"])
  .optional();

export function registerRunComfyTools(server: McpServer): void {
  server.tool(
    "runcomfy_list_pods",
    "List dedicated RunComfy machines (pods) for your account via the Server API. " +
      "Returns server_id, current_status, main_service_url (ComfyUI backend when ready), " +
      "workflow_version_id, and server_type. " +
      "Env: RUNCOMFY_API_KEY (Bearer), RUNCOMFY_USER_ID, optional RUNCOMFY_API_BASE " +
      "(default https://beta-api.runcomfy.net).",
    {},
    async () => {
      try {
        const result = await runcomfyListPods();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_sync_workflow",
    "List cloud-saved RunComfy workflows and resolve workflow_version_id values for pod launch. " +
      "Optional workflow_name filter. Optional local_workflow_path compares the local JSON name " +
      "to cloud workflow names and returns matched_version_id when found. " +
      "Upload workflows in RunComfy UI first — this tool does not upload files.",
    {
      workflow_name: z
        .string()
        .optional()
        .describe("Substring filter on cloud workflow names"),
      local_workflow_path: z
        .string()
        .optional()
        .describe("Local workflow JSON path for name/hash match against cloud list"),
    },
    async (args) => {
      try {
        const result = await runcomfySyncWorkflow(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runcomfy_queue",
    "Queue a ComfyUI workflow on a RunComfy dedicated pod by POSTing to its main_service_url /prompt. " +
      "Target an existing pod with server_id or main_service_url, or launch a new pod with workflow_version_id " +
      "(from runcomfy_sync_workflow). Accepts API workflow JSON or UI workflow (converted via remote object_info). " +
      "workflow_path loads a local JSON file.",
    {
      server_id: z
        .string()
        .optional()
        .describe("Existing RunComfy server/pod id (uses its main_service_url when ready)"),
      main_service_url: z
        .string()
        .optional()
        .describe("Direct ComfyUI backend URL, e.g. https://{uuid}-comfyui.runcomfy.com"),
      workflow_version_id: z
        .string()
        .optional()
        .describe("Cloud workflow version id — launches a new pod when server_id/url omitted"),
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe("Workflow graph: API format (class_type) or UI format (nodes + links)"),
      workflow_path: z
        .string()
        .optional()
        .describe("Path to local workflow JSON (API or UI format)"),
      server_type: serverTypeSchema.describe("Pod size when launching (default medium)"),
      estimated_duration: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Requested pod runtime in seconds when launching (default 3600)"),
      launch_if_needed: z
        .boolean()
        .optional()
        .describe("When workflow_version_id set, launch pod if server_id/url not provided (default true)"),
      wait_ready_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max seconds to wait for launched pod ComfyUI API (default 180)"),
      extra_data: z
        .record(z.string(), z.any())
        .optional()
        .describe("extra_data forwarded to /prompt (e.g. comfy.org API node credentials)"),
      front: z
        .boolean()
        .optional()
        .describe("Enqueue at front of pod queue"),
    },
    async (args) => {
      try {
        const result = await runcomfyQueue(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}