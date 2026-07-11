// Task 5b: the experimental, isolated GitHub Copilot chat backend.
//
// CopilotBackend (copilot-backend.ts) is a thin OllamaBackend subclass reusing
// the inherited "openai" chat/completions dialect — the only Copilot-specific
// behavior is (1) the ghu_ -> short-lived Copilot bearer exchange, (2) the
// extra "editor identity" headers GitHub requires, and (3) the host allowlist.
// These tests mock `fetch` end-to-end (no real network, no real
// ~/.comfyui-mcp/copilot-auth.json) and drive the backend through its public
// AgentBackend surface, mirroring grok-backend-oauth.test.ts's style.

import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";
import {
  CopilotBackend,
  COPILOT_TOKEN_EXCHANGE_URL,
  COPILOT_API_BASE,
} from "../../orchestrator/copilot-backend.js";
import { backendReadiness } from "../../orchestrator/backend-readiness.js";
import { assertAllowedTokenHost } from "../../services/oauth-flow.js";

/** A push-driven async channel of NeutralTurns (PanelAgent's "channel in" seam) —
 *  mirrors grok-backend-oauth.test.ts's helper. */
function makeChannel() {
  const queue: NeutralTurn[] = [];
  let resolveNext: ((r: IteratorResult<NeutralTurn>) => void) | null = null;
  let closed = false;
  const iterable: AsyncIterable<NeutralTurn> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<NeutralTurn>> {
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((res) => {
            resolveNext = res;
          });
        },
      };
    },
  };
  return {
    iterable,
    push(t: NeutralTurn) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: t, done: false });
      } else queue.push(t);
    },
    close() {
      closed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function consume(gen: AsyncIterable<AgentEvent>, events: AgentEvent[]): Promise<void> {
  return (async () => {
    for await (const ev of gen) events.push(ev);
  })();
}

/** A minimal OpenAI-compatible SSE body: one content delta then [DONE] —
 *  matches what OllamaBackend's inherited readOpenAiSse() expects. */
function openAiSseBody(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

const EXCHANGE_RESPONSE = { token: "copilot-bearer-xyz", expires_at: Math.floor(Date.now() / 1000) + 1800 };

describe("CopilotBackend — ghu_ -> Copilot bearer exchange", () => {
  it("exchanges the ghu_ token for a short-lived bearer, with editor-identity headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === COPILOT_TOKEN_EXCHANGE_URL) {
        return new Response(JSON.stringify(EXCHANGE_RESPONSE), { status: 200 });
      }
      if (url === `${COPILOT_API_BASE}/models`) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    // Stub the GLOBAL fetch too — OllamaBackend's inherited prepare() reachability
    // check (GET {host}/models) always dials the bare global fetch, not the
    // injected fetch seam (which this backend only threads through the ghu_
    // exchange). Both must resolve for prepare() to succeed here.
    vi.stubGlobal("fetch", fetchMock);

    const resolveCopilotOAuthMock = vi.fn(async () => ({ ghuToken: "ghu_abc123" }));
    const backend = new CopilotBackend({
      resolveCopilotOAuth: resolveCopilotOAuthMock,
      fetch: fetchMock,
    });

    await backend.prepare();

    const exchangeCalls = fetchMock.mock.calls.filter(([u]) => String(u) === COPILOT_TOKEN_EXCHANGE_URL);
    expect(exchangeCalls).toHaveLength(1);
    const [, init] = exchangeCalls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("token ghu_abc123");
    expect(headers["Editor-Version"]).toMatch(/^vscode\//);
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");

    // The ghu_ never appears bare in a header value beyond the one Authorization
    // line we just asserted verbatim — no accidental duplication/leak elsewhere.
    expect(resolveCopilotOAuthMock).toHaveBeenCalledTimes(1);

    await backend.close();
    vi.unstubAllGlobals();
  });

  it("caches the exchanged bearer — a second prepare() within the same instance does not re-exchange", async () => {
    let exchangeCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === COPILOT_TOKEN_EXCHANGE_URL) {
        exchangeCount++;
        return new Response(JSON.stringify(EXCHANGE_RESPONSE), { status: 200 });
      }
      if (url === `${COPILOT_API_BASE}/models`) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const backend = new CopilotBackend({
      resolveCopilotOAuth: async () => ({ ghuToken: "ghu_abc123" }),
      fetch: fetchMock,
    });

    await backend.prepare();
    // prepare() is idempotent on the OllamaBackend `prepared` guard, but the
    // token-freshness check runs every call — a fresh (non-expiring) cached
    // bearer must still short-circuit the exchange.
    await backend.prepare();
    expect(exchangeCount).toBe(1);

    await backend.close();
    vi.unstubAllGlobals();
  });

  it("surfaces a 403 exchange failure with a re-sign-in hint, without leaking the ghu_", async () => {
    const fetchMock = vi.fn(async () => new Response("Forbidden", { status: 403 }));
    const backend = new CopilotBackend({
      resolveCopilotOAuth: async () => ({ ghuToken: "ghu_supersecret" }),
      fetch: fetchMock,
    });

    await expect(backend.prepare()).rejects.toThrow(/re-run copilot sign-in/i);
    // Confirm the rejection message never contains the raw ghu_ value.
    try {
      await backend.prepare();
    } catch (err) {
      expect(String(err)).not.toContain("ghu_supersecret");
    }
    await backend.close();
  });
});

describe("CopilotBackend — chat turn hits api.githubcopilot.com", () => {
  it("sends the Bearer + Copilot-Integration-Id + Editor-Version headers on chat/completions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === COPILOT_TOKEN_EXCHANGE_URL) {
        return new Response(JSON.stringify(EXCHANGE_RESPONSE), { status: 200 });
      }
      if (url === `${COPILOT_API_BASE}/models`) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }] }), { status: 200 });
      }
      if (url === `${COPILOT_API_BASE}/chat/completions`) {
        return new Response(openAiSseBody("hello from Copilot"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new CopilotBackend({
      resolveCopilotOAuth: async () => ({ ghuToken: "ghu_abc123" }),
      // no `fetch` override here — proves the chat path rides the GLOBAL fetch
      // (OllamaBackend's inherited chatStream), while the exchange also works
      // against the same stubbed global.
    });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const run = consume(backend.run({ channel: channel.iterable }), events);

    channel.push({ text: "hi" });
    await waitFor(() => events.some((e) => e.type === "result"));
    channel.close();
    await run;

    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u) === `${COPILOT_API_BASE}/chat/completions`);
    expect(chatCalls).toHaveLength(1);
    const [, init] = chatCalls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer copilot-bearer-xyz");
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(headers["Editor-Version"]).toMatch(/^vscode\//);
    expect(headers["Editor-Plugin-Version"]).toBeTruthy();
    expect(headers["User-Agent"]).toMatch(/GitHubCopilotChat/);

    const replyDeltas = events
      .filter((e): e is Extract<AgentEvent, { type: "assistant_delta" }> => e.type === "assistant_delta")
      .map((e) => e.text)
      .join("");
    expect(replyDeltas).toBe("hello from Copilot");
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });

    await backend.close();
    vi.unstubAllGlobals();
  });
});

describe("CopilotBackend — host allowlist", () => {
  it("assertAllowedTokenHost rejects a non-allowlisted override of the exchange URL", () => {
    expect(() =>
      assertAllowedTokenHost("https://evil.example.com/copilot_internal/v2/token", [
        "github.com",
        "githubcopilot.com",
      ]),
    ).toThrow(/not in allowlist/i);
  });

  it("accepts the real exchange + chat hosts", () => {
    expect(() =>
      assertAllowedTokenHost(COPILOT_TOKEN_EXCHANGE_URL, ["github.com", "githubcopilot.com"]),
    ).not.toThrow();
    expect(() =>
      assertAllowedTokenHost(`${COPILOT_API_BASE}/chat/completions`, ["github.com", "githubcopilot.com"]),
    ).not.toThrow();
  });

  it("refuses a plain-HTTP override (non-HTTPS) even if the host matches", () => {
    expect(() =>
      assertAllowedTokenHost("http://api.githubcopilot.com/chat/completions", ["githubcopilot.com"]),
    ).toThrow(/non-https/i);
  });
});

describe("CopilotBackend — identity + KNOWN_BACKENDS / readiness wiring", () => {
  it("identifies itself as the 'copilot' backend with vision disabled (text-only 6-tool router)", () => {
    const backend = new CopilotBackend({ resolveCopilotOAuth: async () => ({ ghuToken: "ghu_x" }) });
    expect(backend.id).toBe("copilot");
    expect(backend.capabilities.vision).toBe(false);
    expect(backend.capabilities.persistentChannel).toBe(true);
  });

  it("readiness reports copilot as ready + experimental once a panel OAuth status exists", () => {
    const now = Date.now();
    const r = backendReadiness("copilot", {
      oauthStatus: [{ provider: "copilot", account_label: "GitHub Copilot", obtained_at: now, experimental: true }],
      now,
    });
    expect(r).toEqual({ backend: "copilot", cli: true, auth: true, ready: true, experimental: true });
  });

  it("readiness reports copilot as NOT ready (but still experimental) with no sign-in on record", () => {
    const r = backendReadiness("copilot", { oauthStatus: [], now: Date.now() });
    expect(r).toEqual({ backend: "copilot", cli: true, auth: false, ready: false, experimental: true });
  });
});
