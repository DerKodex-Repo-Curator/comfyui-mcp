import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseProjectManifest,
  runWorkflowPipeline,
} from "../../services/workflow-pipeline.js";

const API_WF = {
  "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "hello", clip: ["3", 0] } },
};

describe("workflow-pipeline", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "wf-pipeline-"));
    await writeFile(
      join(projectDir, "stage1.json"),
      JSON.stringify(API_WF),
    );
    await writeFile(
      join(projectDir, "stage2.json"),
      JSON.stringify({
        "10": { class_type: "LoadImage", inputs: { image: "unset.png" } },
      }),
    );
    await mkdir(join(projectDir, "refs"), { recursive: true });
    await writeFile(join(projectDir, "refs", "ref.png"), "fake-png");
  });

  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("parses a valid project manifest", () => {
    const manifest = parseProjectManifest(`
name: test-project
assets:
  ref: refs/ref.png
stages:
  - id: a
    workflow: path:stage1.json
    pin: workflows/a.json
`);
    expect(manifest.name).toBe("test-project");
    expect(manifest.stages).toHaveLength(1);
    expect(manifest.stages[0].pin).toBe("workflows/a.json");
  });

  it("dry_run lists stages without enqueueing", async () => {
    const manifestPath = join(projectDir, "project.yaml");
    await writeFile(
      manifestPath,
      `name: dry
stages:
  - id: one
    workflow: path:${join(projectDir, "stage1.json")}
  - id: two
    workflow: path:${join(projectDir, "stage2.json")}
`,
    );

    const enqueue = vi.fn();
    const result = await runWorkflowPipeline(
      { project_path: manifestPath, dry_run: true },
      { enqueue },
    );

    expect(result.dry_run).toBe(true);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0].status).toBe("planned");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("runs stages sequentially and chains output", async () => {
    const manifestPath = join(projectDir, "chain.yaml");
    await writeFile(
      manifestPath,
      `name: chain
assets:
  ref: refs/ref.png
stages:
  - id: first
    workflow: path:${join(projectDir, "stage1.json")}
    inputs:
      text: "stage one"
    wait: true
    timeout_seconds: 30
    output_node_id: "1"
  - id: second
    workflow: path:${join(projectDir, "stage2.json")}
    chain_from: first
    chain_role: primary
`,
    );

    const enqueue = vi
      .fn()
      .mockResolvedValueOnce({ prompt_id: "p1" })
      .mockResolvedValueOnce({ prompt_id: "p2" });

    let statusCalls = 0;
    const getJobStatus = vi.fn(async (id: string) => {
      statusCalls += 1;
      return { running: false, pending: false, done: true };
    });

    const getHistory = vi.fn(async (id?: string) => {
      if (id === "p1") {
        return {
          p1: {
            outputs: {
              "1": {
                images: [{ filename: "hero_00001.png", subfolder: "", type: "output" }],
              },
            },
            status: { status_str: "success", completed: true },
          },
        };
      }
      return {};
    });

    const uploadAsset = vi.fn(async () => ({ filename: "ref_uploaded.png" }));
    const stageOutput = vi.fn(async () => ({
      filename: "hero_staged.png",
      subfolder: "",
      type: "input",
      kind: "image" as const,
    }));

    const readFile = async (path: string) => {
      const { readFile: rf } = await import("node:fs/promises");
      return rf(path, "utf-8");
    };

    const result = await runWorkflowPipeline(
      { project_path: manifestPath },
      {
        readFile,
        enqueue,
        getJobStatus,
        getHistory,
        uploadAsset,
        stageOutput,
        sleep: async () => {},
        getObjectInfo: vi.fn(),
        backfillObjectInfo: vi.fn(),
      },
    );

    expect(result.failed).toBe(0);
    expect(result.completed).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(uploadAsset).toHaveBeenCalledTimes(1);
    expect(stageOutput).toHaveBeenCalledWith({
      filename: "hero_00001.png",
      subfolder: "",
      type: "output",
    });
    expect(result.stages[1].status).toBe("completed");
    expect(getJobStatus).toHaveBeenCalled();
    expect(statusCalls).toBeGreaterThan(0);
  });

  it("stops pipeline on stage failure", async () => {
    const manifestPath = join(projectDir, "fail.yaml");
    await writeFile(
      manifestPath,
      `name: fail
stages:
  - id: bad
    workflow: path:${join(projectDir, "stage1.json")}
`,
    );

    const enqueue = vi.fn().mockResolvedValue({ prompt_id: "px" });
    const getJobStatus = vi.fn(async () => ({
      running: false,
      pending: false,
      done: true,
      error: { node_id: "2", node_type: "X", exception_message: "boom" },
    }));

    const readFile = async (path: string) => {
      const { readFile: rf } = await import("node:fs/promises");
      return rf(path, "utf-8");
    };

    const result = await runWorkflowPipeline(
      { project_path: manifestPath },
      {
        readFile,
        enqueue,
        getJobStatus,
        getHistory: vi.fn(async () => ({})),
        sleep: async () => {},
        getObjectInfo: vi.fn(),
        backfillObjectInfo: vi.fn(),
      },
    );

    expect(result.failed).toBe(1);
    expect(result.stages[0].status).toBe("failed");
    expect(result.stages[0].error).toContain("boom");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});