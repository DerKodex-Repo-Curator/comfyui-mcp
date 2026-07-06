// Loopback HTTP console for MCP / orchestrator settings (control plane).
//
// The ComfyUI sidebar panel stays a canvas-focused client: provider, effort,
// context, storyboards. Service lifecycle, OAuth, MCP mappings, and advanced
// tool suites live here — opened from the panel's Advanced → "Open MCP Console".
//
// Bound to 127.0.0.1 only; never exposed off-host.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { allBackendReadiness } from "./backend-readiness.js";
import { logger } from "../utils/logger.js";

const KNOWN_BACKENDS = [
  "claude",
  "codex",
  "chatgpt",
  "gemini",
  "grok",
  "glm",
  "kimi",
  "ollama",
] as const;

export interface PanelConsoleHttpServer {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function consoleLandingHtml(opts: {
  bridgePort: number;
  consolePort: number;
  comfyuiUrl: string;
}): string {
  const { bridgePort, consolePort, comfyuiUrl } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ComfyUI MCP Console</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; line-height: 1.5; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.25rem; }
    .sub { color: #9aa0a6; font-size: 0.9rem; margin-bottom: 1.5rem; }
    section { background: #181b22; border: 1px solid #2a2f3a; border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
    h2 { font-size: 0.95rem; margin: 0 0 0.6rem; color: #c4c7ce; }
    ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
    li { margin: 0.25rem 0; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
    pre { background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 8px; padding: 0.75rem; overflow-x: auto; }
    .ok { color: #81c995; }
    .warn { color: #fdd663; }
    a { color: #8ab4f8; }
    #status { font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>ComfyUI MCP Console</h1>
    <p class="sub">Control plane for the panel orchestrator — MCP servers, OAuth, and service settings. The ComfyUI sidebar panel stays focused on chat, providers, and the live canvas.</p>

    <section>
      <h2>Connection</h2>
      <p>Bridge <code>ws://127.0.0.1:${bridgePort}</code> · ComfyUI <code>${escapeHtml(comfyuiUrl)}</code></p>
      <p id="status">Loading provider readiness…</p>
    </section>

    <section>
      <h2>Coming here (panel stays in ComfyUI)</h2>
      <ul>
        <li>Start / stop / restart orchestrator</li>
        <li>MCP server mappings &amp; inherited <code>~/.claude.json</code> tools</li>
        <li>OAuth &amp; API provider sign-in</li>
        <li>LoRA library, image collections, Photomap-style tooling</li>
        <li>A2UI-rich tool surfaces</li>
      </ul>
    </section>

    <section>
      <h2>Stays in the ComfyUI panel</h2>
      <ul>
        <li>Provider / model / effort pickers &amp; context window meter</li>
        <li>Video storyboards &amp; live graph edits</li>
        <li>Connect / Disconnect to this bridge</li>
      </ul>
    </section>

    <section>
      <h2>API</h2>
      <pre>GET /api/status</pre>
    </section>
  </main>
  <script>
    fetch('/api/status').then(r => r.json()).then(d => {
      const el = document.getElementById('status');
      const rows = (d.backends || []).map(b =>
        b.backend + ': ' + (b.ready ? 'ready' : (b.cli ? 'sign in' : 'install CLI'))
      ).join(' · ');
      el.innerHTML = '<span class="ok">Orchestrator running</span> — ' + (rows || 'no backends');
    }).catch(() => {
      document.getElementById('status').innerHTML = '<span class="warn">Could not load status</span>';
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function startPanelConsoleHttpServer(opts: {
  port: number;
  host?: string;
  bridgePort: number;
  comfyuiUrl: string;
}): Promise<PanelConsoleHttpServer> {
  const host = opts.host ?? "127.0.0.1";

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/api/status") {
      const { backends, any_ready } = allBackendReadiness(KNOWN_BACKENDS);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const liveUrl = `http://${host}:${boundPort}`;
      sendJson(res, 200, {
        ok: true,
        console_url: liveUrl,
        bridge_port: opts.bridgePort,
        bridge_url: `ws://${host}:${opts.bridgePort}`,
        comfyui_url: opts.comfyuiUrl,
        backends,
        any_ready,
      });
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/console")) {
      sendHtml(
        res,
        200,
        consoleLandingHtml({
          bridgePort: opts.bridgePort,
          consolePort: opts.port,
          comfyuiUrl: opts.comfyuiUrl,
        }),
      );
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const url = `http://${host}:${boundPort}`;
      logger.info(`[panel-console] MCP console listening on ${url} (loopback)`);
      resolve({
        port: boundPort,
        url,
        stop: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}