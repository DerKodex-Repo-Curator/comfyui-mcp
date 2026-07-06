import { afterEach, describe, expect, it, vi } from "vitest";
import {
  photomapHealth,
  photomapImagePath,
  photomapListAlbums,
  photomapSearch,
} from "../../services/photomap.js";

describe("photomap service", () => {
  afterEach(() => {
    delete process.env.PHOTOMAP_URL;
    delete process.env.PHOTOMAP_BASE_URL;
  });

  it("list_albums GETs /available_albums/", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ key: "comfy", name: "Comfy outputs" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await photomapListAlbums({ fetch: fetchMock as typeof fetch });
    expect(result.count).toBe(1);
    expect(result.albums[0]?.key).toBe("comfy");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:8050/available_albums/");
  });

  it("health returns album count", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ key: "a" }, { key: "b" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await photomapHealth({ fetch: fetchMock as typeof fetch });
    expect(result.ok).toBe(true);
    expect(result.albumCount).toBe(2);
  });

  it("search POSTs query body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ index: 3, score: 0.91 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await photomapSearch(
      { album_key: "comfy", positive_query: "sunset beach", top_k: 5 },
      { fetch: fetchMock as typeof fetch },
    );
    expect(result.count).toBe(1);
    expect(result.hits[0]?.index).toBe(3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/search_with_text_and_image/comfy");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.positive_query).toBe("sunset beach");
    expect(body.top_k).toBe(5);
  });

  it("image_path returns plain text path", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("/Users/me/photos/img001.png", { status: 200 }),
    );

    const result = await photomapImagePath("comfy", 12, { fetch: fetchMock as typeof fetch });
    expect(result.path).toBe("/Users/me/photos/img001.png");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:8050/image_path/comfy/12");
  });

  it("respects PHOTOMAP_URL", async () => {
    process.env.PHOTOMAP_URL = "http://nas.local:8050";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    );

    const result = await photomapListAlbums({ fetch: fetchMock as typeof fetch });
    expect(result.baseUrl).toBe("http://nas.local:8050");
  });
});