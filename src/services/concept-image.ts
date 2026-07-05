import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { ValidationError } from "../utils/errors.js";
import { uploadImageAuto } from "./image-management.js";
import {
  resolveGrokOAuthBearer,
  resolveGoogleImageAuth,
  type ConceptImageProvider,
} from "./concept-image-auth.js";

export type ConceptAspectRatio =
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "3:2"
  | "2:3"
  | "auto";

export interface FetchConceptImageArgs {
  provider: ConceptImageProvider;
  prompt: string;
  aspect_ratio?: ConceptAspectRatio;
  /** Local path to a reference image (for edit / style transfer providers). */
  reference_image_path?: string;
  output_dir?: string;
  /** When true, also upload to ComfyUI input/ via HTTP and return comfy_filename. */
  upload_to_comfyui?: boolean;
  model?: string;
}

export interface FetchConceptImageResult {
  provider: ConceptImageProvider;
  local_path: string;
  mime_type: string;
  prompt: string;
  comfy_filename?: string;
  source_url?: string;
}

export type ConceptImageDeps = {
  fetch?: typeof fetch;
  resolveGrokBearer?: typeof resolveGrokOAuthBearer;
  resolveGoogleAuth?: typeof resolveGoogleImageAuth;
  upload?: typeof uploadImageAuto;
  now?: () => number;
};

const DEFAULT_GROK_MODEL = "grok-imagine-image";
const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-image";

function defaultOutputDir(): string {
  return join(tmpdir(), "comfyui-concepts");
}

function randomBasename(ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = randomBytes(4).toString("hex");
  return `concept-${stamp}-${nonce}${ext}`;
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  return ".png";
}

async function downloadUrl(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ValidationError(
      `Failed to download generated image (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const ab = await res.arrayBuffer();
  return { bytes: Buffer.from(ab), mimeType };
}

async function fetchGrokConceptImage(
  args: FetchConceptImageArgs,
  deps: ConceptImageDeps,
): Promise<{ bytes: Buffer; mimeType: string; sourceUrl?: string }> {
  const fetchFn = deps.fetch ?? fetch;
  const bearer = await (deps.resolveGrokBearer ?? resolveGrokOAuthBearer)();
  const model = args.model ?? process.env.COMFYUI_MCP_GROK_IMAGE_MODEL ?? DEFAULT_GROK_MODEL;

  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt,
    n: 1,
  };
  if (args.aspect_ratio && args.aspect_ratio !== "auto") {
    body.aspect_ratio = args.aspect_ratio;
  }

  const endpoint = args.reference_image_path
    ? "https://api.x.ai/v1/images/edits"
    : "https://api.x.ai/v1/images/generations";

  if (args.reference_image_path) {
    const { readFile } = await import("node:fs/promises");
    const refBytes = await readFile(args.reference_image_path);
    const b64 = refBytes.toString("base64");
    const ext = args.reference_image_path.toLowerCase().endsWith(".png") ? "png" : "jpeg";
    body.image = {
      url: `data:image/${ext};base64,${b64}`,
      type: "image_url",
    };
  }

  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new ValidationError(
      `Grok Imagine API error (${res.status}): ${text.slice(0, 400)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError(`Grok Imagine API returned non-JSON: ${text.slice(0, 200)}`);
  }

  const data = (parsed as { data?: Array<{ url?: string; b64_json?: string }> }).data;
  const first = data?.[0];
  if (!first) throw new ValidationError("Grok Imagine API returned no image data.");

  if (first.b64_json) {
    return { bytes: Buffer.from(first.b64_json, "base64"), mimeType: "image/png" };
  }
  if (first.url) {
    const dl = await downloadUrl(first.url, fetchFn);
    return { bytes: dl.bytes, mimeType: dl.mimeType, sourceUrl: first.url };
  }
  throw new ValidationError("Grok Imagine API response missing url and b64_json.");
}

function googleAuthHeaders(
  auth: Awaited<ReturnType<typeof resolveGoogleImageAuth>>,
): Record<string, string> {
  if (auth.kind === "api_key") {
    return { "x-goog-api-key": auth.token };
  }
  return { Authorization: `Bearer ${auth.accessToken}` };
}

async function fetchGoogleConceptImage(
  args: FetchConceptImageArgs,
  deps: ConceptImageDeps,
): Promise<{ bytes: Buffer; mimeType: string; sourceUrl?: string }> {
  const fetchFn = deps.fetch ?? fetch;
  const auth = await (deps.resolveGoogleAuth ?? resolveGoogleImageAuth)();
  const model = args.model ?? process.env.COMFYUI_MCP_GOOGLE_IMAGE_MODEL ?? DEFAULT_GOOGLE_MODEL;

  const input: Array<Record<string, string>> = [{ type: "text", text: args.prompt }];
  if (args.reference_image_path) {
    const { readFile } = await import("node:fs/promises");
    const refBytes = await readFile(args.reference_image_path);
    const mime =
      args.reference_image_path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    input.push({
      type: "image",
      mime_type: mime,
      data: refBytes.toString("base64"),
    });
  }

  const payload: Record<string, unknown> = { model, input };
  if (args.aspect_ratio && args.aspect_ratio !== "auto") {
    payload.response_format = {
      type: "image",
      aspect_ratio: args.aspect_ratio,
    };
  }

  const res = await fetchFn("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      ...googleAuthHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new ValidationError(
      `Google image API error (${res.status}): ${text.slice(0, 400)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ValidationError(`Google image API returned non-JSON: ${text.slice(0, 200)}`);
  }

  const outputImage = parsed.output_image as { data?: string; mime_type?: string } | undefined;
  if (outputImage?.data) {
    return {
      bytes: Buffer.from(outputImage.data, "base64"),
      mimeType: outputImage.mime_type || "image/png",
    };
  }

  // Walk interaction steps for an image block.
  const outputs = parsed.outputs as Array<{ type?: string; data?: string; mime_type?: string }> | undefined;
  if (Array.isArray(outputs)) {
    for (let i = outputs.length - 1; i >= 0; i--) {
      const block = outputs[i];
      if (block?.type === "image" && block.data) {
        return {
          bytes: Buffer.from(block.data, "base64"),
          mimeType: block.mime_type || "image/png",
        };
      }
    }
  }

  // generateContent-style fallback (some keys/models).
  const candidates = (parsed as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> })
    .candidates;
  const inline = candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (inline?.data) {
    return {
      bytes: Buffer.from(inline.data, "base64"),
      mimeType: inline.mimeType || "image/png",
    };
  }

  throw new ValidationError("Google image API response contained no image block.");
}

export async function fetchConceptImage(
  args: FetchConceptImageArgs,
  deps: ConceptImageDeps = {},
): Promise<FetchConceptImageResult> {
  const prompt = args.prompt?.trim();
  if (!prompt) throw new ValidationError("prompt is required.");

  const generated =
    args.provider === "grok"
      ? await fetchGrokConceptImage(args, deps)
      : await fetchGoogleConceptImage(args, deps);

  const outDir = args.output_dir ?? defaultOutputDir();
  await mkdir(outDir, { recursive: true });
  const ext = mimeToExt(generated.mimeType);
  const localPath = join(outDir, randomBasename(ext));
  await writeFile(localPath, generated.bytes);

  let comfyFilename: string | undefined;
  if (args.upload_to_comfyui) {
    const uploaded = await (deps.upload ?? uploadImageAuto)(localPath);
    comfyFilename = uploaded.filename;
  }

  return {
    provider: args.provider,
    local_path: localPath,
    mime_type: generated.mimeType,
    prompt,
    comfy_filename: comfyFilename,
    source_url: generated.sourceUrl,
  };
}