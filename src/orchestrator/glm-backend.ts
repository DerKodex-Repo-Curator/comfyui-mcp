import { GLM_CAPABILITIES } from "./agent-backend.js";
import { OllamaBackend, type OllamaBackendDeps } from "./ollama-backend.js";
import { resolveGlmCodeCredentials } from "../services/code-provider-auth.js";

export const GLM_DEFAULT_MODEL = process.env.COMFYUI_MCP_GLM_MODEL?.trim() || "glm-4.7";

/** Z.AI GLM Coding Plan — OpenAI-compatible chat/completions + 6-tool router. */
export class GlmBackend extends OllamaBackend {
  readonly capabilities = GLM_CAPABILITIES;

  constructor(deps: Omit<OllamaBackendDeps, "api" | "host" | "apiKey" | "backendId"> = {}) {
    const creds = resolveGlmCodeCredentials();
    super({
      ...deps,
      backendId: "glm",
      api: "openai",
      host: creds.baseUrl,
      apiKey: creds.apiKey,
      model: deps.model ?? GLM_DEFAULT_MODEL,
    });
  }
}