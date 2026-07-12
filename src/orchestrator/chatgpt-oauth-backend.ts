// ChatGPT subscription via direct Codex OAuth (~/.codex/auth.json) — hits the
// Codex Responses endpoint the CLI uses, NOT api.openai.com or codex app-server.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import type { AgentEvent, BackendStartOptions, ModelChoice, NeutralTurn } from "./agent-backend.js";
import { CHATGPT_CAPABILITIES } from "./agent-backend.js";
import { resolveOpenAICodexOAuth } from "../services/code-provider-auth.js";
import { OllamaBackend, type OllamaBackendDeps } from "./ollama-backend.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_SYSTEM_PROMPT = [
  "You are the ComfyUI agent in a sidebar panel. Answer in Markdown.",
  "",
  "You have exactly six tools:",
  "- list_tools / describe_tool / call_tool — headless ComfyUI server.",
  "- panel_list_tools / panel_describe_tool / panel_call_tool — live canvas.",
  "",
  "Describe a tool before its first call. Finish tasks by running tools, not inventing results.",
].join("\n");

export const CHATGPT_DEFAULT_MODEL =
  process.env.COMFYUI_MCP_CHATGPT_MODEL?.trim() || "gpt-5.4-mini";

const MAX_TOOL_ROUNDS = 32;

type CodexInputItem = Record<string, unknown>;

type TurnMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  tool_call_id?: string;
};

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Codex model slugs (gpt-5.x, codex-*) — not Claude panel ids. */
export function isChatGptModel(id: string): boolean {
  const m = id.trim().toLowerCase();
  return /^gpt-5/.test(m) || m.startsWith("codex") || m.includes("codex");
}

function codexModelsCachePath(home = homedir()): string {
  const root = process.env.CODEX_HOME || join(home, ".codex");
  return join(root, "models_cache.json");
}

async function loadCodexModelIds(home = homedir()): Promise<string[]> {
  const path = codexModelsCachePath(home);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      models?: Array<{ id?: string; slug?: string; name?: string }>;
      data?: Array<{ id?: string }>;
    };
    const fromModels = (raw.models ?? []).map((m) => m.id ?? m.slug ?? m.name).filter(Boolean);
    const fromData = (raw.data ?? []).map((m) => m.id).filter(Boolean);
    return [...new Set([...fromModels, ...fromData].filter((x): x is string => !!x))];
  } catch {
    return [];
  }
}

function toResponsesTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn = (t.function ?? t) as { name?: string; description?: string; parameters?: unknown };
    return {
      type: "function",
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    };
  });
}

function historyToCodexInput(messages: TurnMessage[]): CodexInputItem[] {
  const items: CodexInputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.content }],
      });
      continue;
    }
    if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          items.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments || "{}",
          });
        }
      }
      if (m.content.trim()) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      continue;
    }
    if (m.role === "tool" && m.tool_call_id) {
      items.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content,
      });
    }
  }
  return items;
}

/** ChatGPT direct OAuth backend — Codex Responses SSE + shared 6-tool router. */
export class ChatGptOAuthBackend extends OllamaBackend {
  readonly id = "chatgpt" as const;
  readonly capabilities = CHATGPT_CAPABILITIES;

  private accessToken = "";
  private accountId = "";
  private turnHistory: TurnMessage[] = [];
  private chatgptSessionId: string | null = null;

  constructor(deps: Omit<OllamaBackendDeps, "api" | "host" | "apiKey" | "backendId"> = {}) {
    super({
      ...deps,
      backendId: "ollama",
      api: "openai",
      host: "https://unused",
      model: deps.model ?? CHATGPT_DEFAULT_MODEL,
    });
    this.model = deps.model ?? CHATGPT_DEFAULT_MODEL;
  }

  override async prepare(): Promise<void> {
    if (this.disposed) throw new Error("chatgpt backend is closed.");
    if (this.prepared) return;
    const creds = await resolveOpenAICodexOAuth();
    this.accessToken = creds.accessToken;
    this.accountId = creds.accountId;
    await this.connectTools();
    this.prepared = true;
    logger.info(
      `[chatgpt-oauth-backend] ready (Codex Responses, model ${this.model}, ${this.comfyTools.length} comfyui meta-tools, ${this.panelTools.length} panel tools behind the router)`,
    );
  }

  private codexAuthHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      "chatgpt-account-id": this.accountId,
    };
  }

  private async *codexResponsesStream(
    instructions: string,
    input: CodexInputItem[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncGenerator<
    AgentEvent,
    {
      content: string;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
      usage?: Record<string, number>;
      streamId: string | null;
    }
  > {
    const keepalive = onActivity ? setInterval(onActivity, 5000) : null;
    let res: Response;
    try {
      res = await fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...this.codexAuthHeaders(),
        },
        body: JSON.stringify({
          model: this.model,
          instructions,
          input,
          tools: toResponsesTools(tools),
          stream: true,
          store: false,
        }),
        signal,
      });
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
    if (!res.ok || !res.body) {
      throw new Error(
        `Codex Responses http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`,
      );
    }

    let content = "";
    const partial = new Map<string, { id: string; name: string; args: string }>();
    let usage: Record<string, number> | undefined;
    let streamOpen = false;
    const streamId = randomUUID();
    let buffer = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventType = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || data === "[DONE]") continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = eventType || String(payload.type ?? "");
        if (type === "response.output_text.delta") {
          const delta = String(payload.delta ?? "");
          if (delta) {
            if (!streamOpen) {
              streamOpen = true;
              yield { type: "stream_start", id: streamId };
            }
            content += delta;
            yield { type: "assistant_delta", text: delta };
          }
        }

        if (type === "response.function_call_arguments.delta") {
          const itemId = String(payload.item_id ?? payload.call_id ?? "call");
          const slot = partial.get(itemId) ?? { id: itemId, name: "", args: "" };
          if (payload.name) slot.name = String(payload.name);
          if (payload.arguments) slot.args += String(payload.arguments);
          partial.set(itemId, slot);
        }

        if (type === "response.output_item.done") {
          const item = (payload.item ?? payload) as Record<string, unknown>;
          if (item.type === "function_call") {
            const id = String(item.call_id ?? item.id ?? randomUUID());
            partial.set(id, {
              id,
              name: String(item.name ?? ""),
              args: String(item.arguments ?? "{}"),
            });
          }
        }

        if (type === "response.completed") {
          const u =
            (payload.response as { usage?: Record<string, number> } | undefined)?.usage ??
            (payload.usage as Record<string, number> | undefined);
          if (u) {
            usage = {
              input_tokens: Number(u.input_tokens ?? 0),
              output_tokens: Number(u.output_tokens ?? 0),
            };
          }
        }
      }
    }

    if (streamOpen) yield { type: "stream_end" };
    const toolCalls = [...partial.values()]
      .filter((t) => t.name)
      .map((t) => ({ id: t.id, name: t.name, arguments: t.args || "{}" }));
    return { content, toolCalls, usage, streamId: streamOpen ? streamId : null };
  }

  override async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    await this.prepare();
    if (opts.model && isChatGptModel(opts.model)) this.model = opts.model;

    const fresh = !this.chatgptSessionId || (opts.resume && opts.resume !== this.chatgptSessionId);
    this.chatgptSessionId = opts.resume ?? this.chatgptSessionId ?? `chatgpt-${randomUUID()}`;
    if (fresh) this.turnHistory = [];
    yield { type: "session", sessionId: this.chatgptSessionId, model: this.model };

    const instructions = [CHATGPT_SYSTEM_PROMPT, this.deps.systemAppend].filter(Boolean).join("\n\n");

    for await (const turn of opts.channel) {
      yield* this.runCodexTurn(turn, instructions, opts);
    }
  }

  private async *runCodexTurn(
    turn: NeutralTurn,
    instructions: string,
    opts: BackendStartOptions,
  ): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.turnAbort = abort;
    const tools = this.buildModelTools();
    this.turnHistory.push({ role: "user", content: turn.text });

    let resultEmitted = false;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stream = this.codexResponsesStream(
          instructions,
          historyToCodexInput(this.turnHistory),
          tools,
          abort.signal,
          opts.onActivity,
        );
        let content = "";
        let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let usage: Record<string, number> | undefined;
        let streamId: string | null = null;
        for (;;) {
          const r = await stream.next();
          if (r.done) {
            ({ content, toolCalls, usage, streamId } = r.value);
            break;
          }
          yield r.value;
        }

        if (!toolCalls.length) {
          this.turnHistory.push({ role: "assistant", content });
          yield { type: "assistant", text: content, id: streamId ?? undefined, usage };
          yield { type: "result", ok: true, usage };
          resultEmitted = true;
          return;
        }

        this.turnHistory.push({ role: "assistant", content, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          if (abort.signal.aborted) throw new Error("interrupted");
          yield { type: "tool_call", name: tc.name, phase: "start", detail: tc.arguments };
          const { text, isError } = await this.dispatch(tc.name, tc.arguments);
          opts.onActivity?.();
          yield { type: "tool_call", name: tc.name, phase: "end", detail: { isError } };
          this.turnHistory.push({
            role: "tool",
            tool_call_id: tc.id,
            content: text.slice(0, 16000),
          });
        }
      }
      yield {
        type: "assistant",
        text: "(stopped: too many tool rounds in one turn — ask me to continue)",
      };
      yield { type: "result", ok: false, subtype: "max_tool_rounds" };
      resultEmitted = true;
    } catch (err) {
      const interrupted = abort.signal.aborted;
      if (!interrupted) {
        logger.warn(`[chatgpt-oauth-backend] turn failed: ${msgOf(err)}`);
        yield { type: "error", message: `chatgpt backend: ${msgOf(err)}` };
        yield {
          type: "assistant",
          text: `⚠️ The model request failed: ${msgOf(err).slice(0, 400)}`,
        };
      }
      if (!resultEmitted) {
        yield { type: "result", ok: false, subtype: interrupted ? "interrupted" : "error" };
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
  }

  override async setModel(model: string): Promise<void> {
    if (isChatGptModel(model)) this.model = model;
  }

  override async listModels(): Promise<ModelChoice[]> {
    const cached = await loadCodexModelIds();
    const ids = cached.length
      ? cached
      : [CHATGPT_DEFAULT_MODEL, "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"];
    const rest = ids.filter((id) => id !== this.model).slice(0, 40);
    return [this.model, ...rest].map((id) => ({ id, label: id }));
  }
}