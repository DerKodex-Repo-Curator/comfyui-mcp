import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchConceptImage } from "../../services/concept-image.js";

const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("fetchConceptImage", () => {
  let outDir = "";

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "concept-test-"));
  });

  afterEach(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  it("fetches grok image via API and writes local file", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("images/generations")) {
        return new Response(
          JSON.stringify({ data: [{ b64_json: PNG_1X1_B64 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchConceptImage(
      {
        provider: "grok",
        prompt: "a red circle",
        output_dir: outDir,
        upload_to_comfyui: false,
      },
      {
        fetch: fetchMock as typeof fetch,
        resolveGrokBearer: async () => "test-oauth-bearer",
      },
    );

    expect(result.provider).toBe("grok");
    expect(result.local_path.startsWith(outDir)).toBe(true);
    const bytes = await readFile(result.local_path);
    expect(bytes.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-oauth-bearer");
  });

  it("fetches google image via interactions API", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_image: { data: PNG_1X1_B64, mime_type: "image/png" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchConceptImage(
      {
        provider: "google",
        prompt: "structure map blueprint",
        output_dir: outDir,
        upload_to_comfyui: false,
      },
      {
        fetch: fetchMock as typeof fetch,
        resolveGoogleAuth: async () => ({ kind: "api_key", token: "gem-key" }),
      },
    );

    expect(result.provider).toBe("google");
    expect(result.mime_type).toBe("image/png");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toContain("gemini");
    expect(body.input[0].text).toContain("structure map");
  });

  it("downloads grok url responses", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/img.png" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://cdn.example/img.png") {
        return new Response(Buffer.from(PNG_1X1_B64, "base64"), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      throw new Error(url);
    });

    const result = await fetchConceptImage(
      {
        provider: "grok",
        prompt: "test",
        output_dir: outDir,
        upload_to_comfyui: false,
      },
      {
        fetch: fetchMock as typeof fetch,
        resolveGrokBearer: async () => "k",
      },
    );

    expect(result.source_url).toBe("https://cdn.example/img.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});