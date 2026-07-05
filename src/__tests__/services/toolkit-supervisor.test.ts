import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  toolkitListModels,
  toolkitRunJob,
  toolkitStatus,
  __toolkitSupervisorTestHooks,
} from "../../services/toolkit-supervisor.js";

describe("toolkit-supervisor", () => {
  let toolkitRoot = "";
  const prevRoot = process.env.AI_TOOLKIT_ROOT;
  const prevAuth = process.env.AI_TOOLKIT_AUTH;
  const prevUrl = process.env.AI_TOOLKIT_URL;

  beforeEach(async () => {
    __toolkitSupervisorTestHooks.reset();
    toolkitRoot = await mkdtemp(join(tmpdir(), "toolkit-test-"));
    await mkdir(join(toolkitRoot, "ui"), { recursive: true });
    await writeFile(join(toolkitRoot, "run.py"), "# stub\n");
    await writeFile(
      join(toolkitRoot, "ui", "package.json"),
      JSON.stringify({ name: "ai-toolkit-ui" }),
    );
    await mkdir(join(toolkitRoot, "config", "examples"), { recursive: true });
    await writeFile(
      join(toolkitRoot, "config", "examples", "train_lora_wan22_14b_24gb.yaml"),
      `---
job: extension
config:
  name: wan22_example
  process:
    - type: sd_trainer
      model:
        name_or_path: ai-toolkit/Wan2.2-T2V-A14B-Diffusers-bf16
        arch: wan22_14b
`,
    );
    process.env.AI_TOOLKIT_ROOT = toolkitRoot;
    process.env.AI_TOOLKIT_URL = "http://127.0.0.1:8675";
    delete process.env.AI_TOOLKIT_AUTH;
  });

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.AI_TOOLKIT_ROOT;
    else process.env.AI_TOOLKIT_ROOT = prevRoot;
    if (prevAuth === undefined) delete process.env.AI_TOOLKIT_AUTH;
    else process.env.AI_TOOLKIT_AUTH = prevAuth;
    if (prevUrl === undefined) delete process.env.AI_TOOLKIT_URL;
    else process.env.AI_TOOLKIT_URL = prevUrl;
    if (toolkitRoot) await rm(toolkitRoot, { recursive: true, force: true });
  });

  it("lists example model configs from install root", async () => {
    const result = await toolkitListModels();
    expect(result.root).toBe(toolkitRoot);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      file: "train_lora_wan22_14b_24gb.yaml",
      arch: "wan22_14b",
      model_name_or_path: "ai-toolkit/Wan2.2-T2V-A14B-Diffusers-bf16",
      name: "wan22_example",
      job_type: "extension",
    });
  });

  it("probes status when process is not running", async () => {
    const result = await toolkitStatus(
      { action: "probe" },
      { findPidByPort: () => null },
    );
    expect(result.running).toBe(false);
    expect(result.api_reachable).toBe(false);
    expect(result.root).toBe(toolkitRoot);
  });

  it("probes API when process appears running", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/gpu")) {
        return new Response(JSON.stringify({ devices: [{ id: 0 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/jobs")) {
        return new Response(JSON.stringify({ jobs: [{ id: "j1", name: "test", status: "queued" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/queue")) {
        return new Response(JSON.stringify({ queues: [{ gpu_ids: "0", is_running: true }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const result = await toolkitStatus(
      { action: "probe" },
      { findPidByPort: () => 4242, fetch: fetchMock as typeof fetch },
    );

    expect(result.running).toBe(true);
    expect(result.pid).toBe(4242);
    expect(result.api_reachable).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.queues).toHaveLength(1);
  });

  it("creates, starts job, and starts queue via API", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/jobs") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.name).toBe("my_lora_job");
        expect(body.gpu_ids).toBe("0");
        expect(body.job_config.config.name).toBe("wan22_example");
        return new Response(
          JSON.stringify({ id: "job-abc", name: body.name, gpu_ids: "0" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/jobs/job-abc/start")) {
        return new Response(JSON.stringify({ id: "job-abc", status: "queued" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/queue/0/start")) {
        return new Response(JSON.stringify({ gpu_ids: "0", is_running: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const result = await toolkitRunJob(
      {
        name: "my_lora_job",
        config_path: "config/examples/train_lora_wan22_14b_24gb.yaml",
        gpu_ids: "0",
      },
      { fetch: fetchMock as typeof fetch },
    );

    expect(result.job_id).toBe("job-abc");
    expect(result.queue_started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends bearer auth when AI_TOOLKIT_AUTH is set", async () => {
    process.env.AI_TOOLKIT_AUTH = "secret-token";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/jobs") && init?.method === "POST") {
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer secret-token");
        return new Response(
          JSON.stringify({ id: "job-1", name: "x", gpu_ids: "0" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/start")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(url);
    });

    await toolkitRunJob(
      { name: "x", job_config: { config: { name: "x", process: [] } } },
      { fetch: fetchMock as typeof fetch },
    );
  });
});