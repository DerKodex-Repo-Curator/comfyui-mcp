import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runcomfyListPods,
  runcomfyQueue,
  runcomfySyncWorkflow,
  resolveRunComfyConfig,
} from "../../services/runcomfy-connector.js";

const USER_ID = "user-abc-123";
const API_BASE = "https://beta-api.runcomfy.net";

describe("runcomfy-connector", () => {
  const prevKey = process.env.RUNCOMFY_API_KEY;
  const prevUser = process.env.RUNCOMFY_USER_ID;
  const prevBase = process.env.RUNCOMFY_API_BASE;

  beforeEach(() => {
    process.env.RUNCOMFY_API_KEY = "test-api-key";
    process.env.RUNCOMFY_USER_ID = USER_ID;
    process.env.RUNCOMFY_API_BASE = API_BASE;
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.RUNCOMFY_API_KEY;
    else process.env.RUNCOMFY_API_KEY = prevKey;
    if (prevUser === undefined) delete process.env.RUNCOMFY_USER_ID;
    else process.env.RUNCOMFY_USER_ID = prevUser;
    if (prevBase === undefined) delete process.env.RUNCOMFY_API_BASE;
    else process.env.RUNCOMFY_API_BASE = prevBase;
  });

  it("resolves config from env", () => {
    const cfg = resolveRunComfyConfig();
    expect(cfg).toEqual({
      apiKey: "test-api-key",
      userId: USER_ID,
      apiBase: API_BASE,
    });
  });

  it("lists pods with bearer auth", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${API_BASE}/prod/api/users/${USER_ID}/servers`);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-api-key",
      );
      return new Response(
        JSON.stringify({
          servers: [
            {
              server_id: "srv-1",
              current_status: "running",
              main_service_url: "https://abc-comfyui.runcomfy.com",
              workflow_version_id: "ver-9",
              server_type: "medium",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await runcomfyListPods({ fetch: fetchMock as typeof fetch });
    expect(result.count).toBe(1);
    expect(result.servers[0]).toMatchObject({
      server_id: "srv-1",
      main_service_url: "https://abc-comfyui.runcomfy.com",
    });
  });

  it("syncs workflows and matches local file by name", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "runcomfy-wf-"));
    const wfPath = join(tmp, "my_portrait_workflow.json");
    await writeFile(
      wfPath,
      JSON.stringify({
        name: "My Portrait Workflow",
        "3": { class_type: "KSampler", inputs: {} },
      }),
    );

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${API_BASE}/prod/api/users/${USER_ID}/workflows`);
      return new Response(
        JSON.stringify([
          {
            workflow_id: "wf-1",
            name: "My Portrait Workflow",
            versions: [{ version_id: "ver-portrait-1" }],
            latest_version_id: "ver-portrait-1",
          },
          {
            workflow_id: "wf-2",
            name: "Landscape v2",
            versions: [{ version_id: "ver-land-1" }],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await runcomfySyncWorkflow(
      { local_workflow_path: wfPath },
      { fetch: fetchMock as typeof fetch },
    );

    expect(result.count).toBe(2);
    expect(result.local_match).toMatchObject({
      matched_workflow_id: "wf-1",
      matched_version_id: "ver-portrait-1",
      name_guess: "My Portrait Workflow",
    });
    await rm(tmp, { recursive: true, force: true });
  });

  it("queues API workflow on existing pod main_service_url", async () => {
    const serviceUrl = "https://pod-comfyui.runcomfy.com";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${API_BASE}/prod/api/users/${USER_ID}/servers/srv-42`) {
        return new Response(
          JSON.stringify({
            server_id: "srv-42",
            current_status: "running",
            main_service_url: serviceUrl,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${serviceUrl}/prompt` && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.prompt["1"].class_type).toBe("EmptyLatentImage");
        expect(body.client_id).toBe("comfyui-mcp-runcomfy");
        return new Response(
          JSON.stringify({ prompt_id: "prompt-xyz", number: 2 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    const result = await runcomfyQueue(
      {
        server_id: "srv-42",
        workflow: {
          "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
        },
      },
      { fetch: fetchMock as typeof fetch },
    );

    expect(result.prompt_id).toBe("prompt-xyz");
    expect(result.main_service_url).toBe(serviceUrl);
    expect(result.launched).toBe(false);
  });

  it("launches pod then queues when workflow_version_id provided", async () => {
    const serviceUrl = "https://new-pod.runcomfy.com";
    let systemStatsCalls = 0;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${API_BASE}/prod/api/users/${USER_ID}/servers` && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.workflow_version_id).toBe("ver-launch-1");
        expect(body.server_type).toBe("large");
        return new Response(
          JSON.stringify({
            server_id: "srv-new",
            current_status: "starting",
            main_service_url: serviceUrl,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${API_BASE}/prod/api/users/${USER_ID}/servers/srv-new`) {
        return new Response(
          JSON.stringify({
            server_id: "srv-new",
            current_status: "running",
            main_service_url: serviceUrl,
            service_ready_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${serviceUrl}/system_stats`) {
        systemStatsCalls += 1;
        return new Response(JSON.stringify({ system: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `${serviceUrl}/prompt` && init?.method === "POST") {
        return new Response(
          JSON.stringify({ prompt_id: "prompt-launched" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    const result = await runcomfyQueue(
      {
        workflow_version_id: "ver-launch-1",
        server_type: "large",
        wait_ready_seconds: 5,
        workflow: {
          "1": { class_type: "CLIPTextEncode", inputs: { text: "hello" } },
        },
      },
      { fetch: fetchMock as typeof fetch },
    );

    expect(result.launched).toBe(true);
    expect(result.server_id).toBe("srv-new");
    expect(result.prompt_id).toBe("prompt-launched");
    expect(systemStatsCalls).toBeGreaterThan(0);
  });
});