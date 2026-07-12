import { KIMI_CAPABILITIES } from "./agent-backend.js";
import { OllamaBackend, type OllamaBackendDeps } from "./ollama-backend.js";
import {
  KIMI_CODE_DEFAULT_BASE,
  resolveKimiCodeOAuth,
} from "../services/code-provider-auth.js";

export const KIMI_DEFAULT_MODEL =
  process.env.COMFYUI_MCP_KIMI_MODEL?.trim() || "kimi-for-coding";

/** Kimi Code subscription OAuth (or KIMI_API_KEY) — OpenAI-compatible coding API. */
export class KimiBackend extends OllamaBackend {
  readonly capabilities = KIMI_CAPABILITIES;

  constructor(deps: Omit<OllamaBackendDeps, "api" | "host" | "apiKey" | "backendId"> = {}) {
    const apiKey = process.env.KIMI_API_KEY?.trim() || "pending-oauth";
    super({
      ...deps,
      backendId: "kimi",
      api: "openai",
      host:
        process.env.COMFYUI_MCP_KIMI_BASE_URL?.trim().replace(/\/$/, "") ||
        KIMI_CODE_DEFAULT_BASE,
      apiKey,
      model: deps.model ?? KIMI_DEFAULT_MODEL,
    });
  }

  override async prepare(): Promise<void> {
    const creds = await resolveKimiCodeOAuth();
    this.setOpenAiAuth(creds.baseUrl, creds.accessToken);
    return super.prepare();
  }
}