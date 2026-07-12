import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runcomfyTrainerCreateDataset,
  runcomfyTrainerListDatasets,
  runcomfyTrainerSubmitJob,
} from "../../services/runcomfy-trainer.js";

describe("runcomfy-trainer service", () => {
  afterEach(() => {
    delete process.env.RUNCOMFY_API_KEY;
    delete process.env.RUNCOMFY_TRAINER_API_BASE;
  });

  it("create_dataset POSTs to trainer API", async () => {
    process.env.RUNCOMFY_API_KEY = "rc-test-key";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "ds-1", name: "loras", status: "CREATING" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runcomfyTrainerCreateDataset({ name: "loras" }, { fetch: fetchMock as typeof fetch });
    expect(result.id).toBe("ds-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("trainer-api.runcomfy.net/prod/v1/trainers/datasets");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer rc-test-key");
  });

  it("list_datasets normalizes array response", async () => {
    process.env.RUNCOMFY_API_KEY = "rc-test-key";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "a" }, { id: "b" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runcomfyTrainerListDatasets({ fetch: fetchMock as typeof fetch });
    expect(result.count).toBe(2);
    expect(result.datasets).toHaveLength(2);
  });

  it("submit_job sends YAML config", async () => {
    process.env.RUNCOMFY_API_KEY = "rc-test-key";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "job-9", status: "QUEUED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const yaml = "job: extension\nname: test_lora";
    const result = await runcomfyTrainerSubmitJob(
      { config_file: yaml, gpu_type: "ADA_80_PLUS" },
      { fetch: fetchMock as typeof fetch },
    );
    expect(result.id).toBe("job-9");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.config_file).toBe(yaml);
    expect(body.gpu_type).toBe("ADA_80_PLUS");
  });
});