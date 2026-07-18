import { MOONSHOT_CAPABILITIES } from "./agent-backend.js";
import { OllamaBackend, type OllamaBackendDeps } from "./ollama-backend.js";
import { resolveMoonshotCredentials } from "../services/code-provider-auth.js";

export const MOONSHOT_DEFAULT_MODEL =
  process.env.COMFYUI_MCP_MOONSHOT_MODEL?.trim() || "kimi-k3";

/** Moonshot platform API (Kimi K3) — OpenAI-compatible chat/completions + 6-tool
 *  router. A general pay-per-token platform key (MOONSHOT_API_KEY, api.moonshot.ai),
 *  distinct from the `kimi` backend's Kimi Code coding subscription. */
export class MoonshotBackend extends OllamaBackend {
  readonly capabilities = MOONSHOT_CAPABILITIES;

  constructor(deps: Omit<OllamaBackendDeps, "api" | "host" | "apiKey" | "backendId"> = {}) {
    const creds = resolveMoonshotCredentials();
    super({
      ...deps,
      backendId: "moonshot",
      api: "openai",
      host: creds.baseUrl,
      apiKey: creds.apiKey,
      model: deps.model ?? MOONSHOT_DEFAULT_MODEL,
    });
  }
}
