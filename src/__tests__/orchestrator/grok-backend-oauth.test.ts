// Task 6: direct-token vs ACP/CLI selection for the Grok backend.
//
// GrokBackend (grok-backend.ts) decides ONCE, per instance, whether a direct
// xAI OAuth token is usable (via the injected `resolveGrokOAuth` test seam) and
// either delegates every AgentBackend call to an internal GrokDirectBackend (hits
// `https://api.x.ai/v1/responses`) or falls through to its own unchanged
// ACP/CLI body (spawns `grok agent ... stdio`). These tests drive that decision
// from both sides without touching the real filesystem: `node:child_process` is
// mocked (so the ACP fallback never needs a real `grok` binary) and `fetch` is
// mocked (so the direct path never dials the real network).

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentEvent, NeutralTurn, BackendStartOptions } from "../../orchestrator/agent-backend.js";

// ---- node:child_process mock: a minimal fake ACP server, just enough to prove
// the ACP path is actually reachable (handshake → session/new → one completed
// turn) when the fallback engages. Mirrors grok-backend.test.ts's fake server,
// trimmed to the single "complete immediately" behavior this file needs. ----
const hoisted = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  function makeFakeProc() {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    proc.pid = 4242;
    proc.exitCode = null;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    proc.stdin = stdin;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = () => {
      if (proc.exitCode === null) {
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
      }
      return true;
    };
    stdin.on("finish", () => {
      if (proc.exitCode === null) {
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
      }
    });

    const write = (obj: unknown) => stdout.write(`${JSON.stringify(obj)}\n`);
    const SESSION_ID = "sess-acp-fallback";

    let buf = "";
    stdin.on("data", (chunk: Buffer) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const method = msg.method as string | undefined;
        const id = msg.id as number | string | undefined;
        if (method === "initialize" && id !== undefined) {
          write({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "grok" }, authMethods: [] },
          });
        } else if (method === "session/new" && id !== undefined) {
          write({ jsonrpc: "2.0", id, result: { sessionId: SESSION_ID } });
        } else if (method === "session/prompt" && id !== undefined) {
          const sessionId = (msg.params as { sessionId: string }).sessionId;
          setImmediate(() => {
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hi from ACP" } },
              },
            });
            write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          });
        }
      }
    });

    return proc;
  }

  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      hoisted.spawnCalls.push({ cmd, args: Array.isArray(args) ? args : [] });
      return makeFakeProc();
    },
    spawnSync: () => ({ status: 0, pid: 1, stdout: "", stderr: "", signal: null, output: [] }),
  };
});

let GrokBackend: typeof import("../../orchestrator/grok-backend.js").GrokBackend;

beforeEach(async () => {
  hoisted.spawnCalls.length = 0;
  vi.resetModules();
  ({ GrokBackend } = await import("../../orchestrator/grok-backend.js"));
});

/** A push-driven async channel of NeutralTurns (PanelAgent's "channel in" seam). */
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

/** A minimal SSE body for the xAI Responses endpoint: one text delta then completed. */
function sseResponsesBody(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

describe("GrokBackend — direct-token vs ACP/CLI selection", () => {
  it("prefers the direct xAI OAuth path when resolveGrokOAuth resolves a token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.x.ai/v1/responses") {
        return new Response(sseResponsesBody("hello from xAI"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolveGrokOAuthMock = vi.fn(async () => ({ accessToken: "xai-token-abc" }));
    const backend = new GrokBackend({ resolveGrokOAuth: resolveGrokOAuthMock });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const run = consume(backend.run({ channel: channel.iterable }), events);

    channel.push({ text: "hi" });
    await waitFor(() => events.some((e) => e.type === "result"));
    channel.close();
    await run;

    // The OAuth resolver was probed EXACTLY ONCE on the success path (the mode
    // decision resolves the creds and threads them into the direct backend's
    // prepare(), which must NOT re-resolve), and NO grok CLI process was spawned.
    expect(resolveGrokOAuthMock).toHaveBeenCalledTimes(1);
    expect(hoisted.spawnCalls).toHaveLength(0);

    // Direct mode must NOT advertise vision:true — the xAI vision contract is
    // unverified and the 6-tool-router path would silently drop images.
    expect(backend.capabilities.vision).toBe(false);

    // The direct path hit the xAI Responses endpoint with a Bearer token — and
    // the token never leaked into a header/body a naive log line would echo.
    const responsesCalls = fetchMock.mock.calls.filter(([u]) => String(u) === "https://api.x.ai/v1/responses");
    expect(responsesCalls).toHaveLength(1);
    const init = responsesCalls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xai-token-abc");

    // The turn completed normally through the direct-token path.
    const replyDeltas = events
      .filter((e): e is Extract<AgentEvent, { type: "assistant_delta" }> => e.type === "assistant_delta")
      .map((e) => e.text)
      .join("");
    expect(replyDeltas).toBe("hello from xAI");
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });

    await backend.close();
    vi.unstubAllGlobals();
  });

  it("falls back to the ACP/CLI path when resolveGrokOAuth rejects (no ~/.grok/auth.json)", async () => {
    const fetchMock = vi.fn(async () => new Response("should not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const resolveGrokOAuthMock = vi.fn(async () => {
      throw new Error("Grok OAuth requires signing in via the panel's Connections tab first.");
    });
    const backend = new GrokBackend({ cwd: process.cwd(), resolveGrokOAuth: resolveGrokOAuthMock });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const run = consume(backend.run({ channel: channel.iterable }), events);

    channel.push({ text: "hi" });
    await waitFor(() => events.some((e) => e.type === "result"));
    channel.close();
    await run;

    // The OAuth resolver was consulted and rejected, so the ACP/CLI path engaged:
    // the fake `grok agent ... stdio` process was spawned, and xAI's HTTP
    // endpoint was never dialed.
    expect(resolveGrokOAuthMock).toHaveBeenCalled();
    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(hoisted.spawnCalls[0]!.args).toContain("agent");
    expect(hoisted.spawnCalls[0]!.args).toContain("stdio");
    expect(fetchMock).not.toHaveBeenCalled();

    // The ACP session/turn completed normally — no behavior change on this path.
    expect(events[0]).toMatchObject({ type: "session", sessionId: "sess-acp-fallback" });
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, subtype: "end_turn" });

    // Once ACP mode is resolved, the facade reports the full ACP capabilities —
    // vision:true is honest here (the ACP path DOES forward inline image blocks).
    expect(backend.capabilities.vision).toBe(true);

    await backend.close();
    vi.unstubAllGlobals();
  });

  it("memoizes the mode decision — resolveGrokOAuth is consulted only once per instance", async () => {
    const resolveGrokOAuthMock = vi.fn(async () => {
      throw new Error("no token file");
    });
    const backend = new GrokBackend({ cwd: process.cwd(), resolveGrokOAuth: resolveGrokOAuthMock });

    await backend.listModels();
    await backend.setModel("grok-build");
    await backend.interrupt(); // no-op (idle), still goes through the same memoized decision

    expect(resolveGrokOAuthMock).toHaveBeenCalledTimes(1);
    await backend.close();
  });
});
