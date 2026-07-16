// Passive ComfyUI render watchdog for the panel orchestrator.
//
// The orchestrator never sees live render progress on its own: panel_run queues
// through the user's BROWSER, and the per-agent comfyui MCP only opens its WS for
// its own generate calls. So a render that wedges (a single sampler step running
// for minutes at high resolution) is invisible here — which is how a stalled job
// once let the agent stack three more behind it before anyone noticed.
//
// This service opens its OWN lightweight WebSocket to COMFYUI_URL. ComfyUI
// broadcasts `status`, `progress`, and `progress_state` to every connected
// client, so we receive the live stream for ANY job — including the
// browser-queued ones — without touching the panel or the agent subprocess.
// (The legacy execution_start / executing / execution_* events are sid-scoped
// to the QUEUING client on modern ComfyUI — verified live on 0.28 — so the
// handlers below also derive the run state from the broadcast-safe frames.)
// It holds the last-known run state and derives a stall/backlog report the
// orchestrator surfaces to the agent as a turn-start note (the same channel as
// the crash-dump injector).
//
// Everything here is BEST-EFFORT: if the socket can't open or drops, the report
// is simply "inactive" and nothing in the orchestrator changes. It must never
// throw into the main path.

import WebSocket from "ws";
import { logger } from "../utils/logger.js";

interface MonitorState {
  connected: boolean;
  runningPromptId: string | null;
  currentNode: string | null;
  progressValue: number | null;
  progressMax: number | null;
  // ComfyUI's status.exec_info.queue_remaining — the total tasks the server still
  // has (running + pending). Last-known value between status frames.
  queueRemaining: number;
  // Monotonic ms timestamp of the last FORWARD-progress signal (node advanced or
  // progress value ticked up) while a job runs. A stuck step re-emits the same
  // progress value, which must NOT refresh this — that's how we see the stall.
  lastActivityTs: number | null;
}

export interface StallReport {
  /** A job is running but its node + progress have not advanced for >= stallMs. */
  stalled: boolean;
  /** More than one task in flight (running + pending) — a backlog the agent may
   *  not realize it created by re-queuing behind a slow job. */
  backlog: boolean;
  runningPromptId: string | null;
  currentNode: string | null;
  /** running + pending, from ComfyUI's own queue_remaining. */
  queueDepth: number;
  /** ms the running job has been idle (0 when not stalled). */
  stalledForMs: number;
  /** e.g. "0/4" when a progress frame has been seen, else null. */
  progress: string | null;
}

export interface QueueSnapshot {
  connected: boolean;
  running: boolean;
  runningPromptId: string | null;
  queueDepth: number;
  /** The node id currently executing (ComfyUI graph node id), null when idle. */
  currentNode: string | null;
  /** Progress of the current node (sampler steps), null before the first tick. */
  progressValue: number | null;
  progressMax: number | null;
}

const RECONNECT_MS = 5000;

class QueueMonitorImpl {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Generation start/end transition hooks (for the Ollama VRAM pause). Fired on
  // the idle→running edge and the running→idle edge, best-effort (a throwing
  // handler must never break the monitor). `busy` is our own edge-tracking flag,
  // distinct from runningPromptId (which flips null between backlogged prompts).
  private busy = false;
  private onRunStart: (() => void) | null = null;
  private onRunEnd: (() => void) | null = null;
  private state: MonitorState = {
    connected: false,
    runningPromptId: null,
    currentNode: null,
    progressValue: null,
    progressMax: null,
    queueRemaining: 0,
    lastActivityTs: null,
  };

  /** Open the watchdog WS to ComfyUI. Idempotent per-URL; best-effort (never
   *  throws). A retarget (new URL) or a prior stop() must re-open the socket:
   *  the orchestrator calls stop()+start(newUrl) when ComfyUI is retargeted
   *  (e.g. 127.0.0.1→localhost from a panel hello), so a stale `this.url` must
   *  NOT early-return — that left the watchdog permanently disconnected. */
  start(comfyuiUrl: string): void {
    if (this.url === comfyuiUrl && !this.stopped) return; // already live on this URL
    this.stop(); // tear down any prior socket/reconnect timer (also on URL change)
    this.url = comfyuiUrl;
    this.stopped = false;
    this.connect();
  }

  /** Register generation-transition handlers (idempotent overwrite). Called by
   *  the orchestrator to unload/warm the local Ollama model around renders. */
  setTransitionHandlers(h: { onRunStart?: () => void; onRunEnd?: () => void }): void {
    this.onRunStart = h.onRunStart ?? null;
    this.onRunEnd = h.onRunEnd ?? null;
  }

  private emitStart(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      this.onRunStart?.();
    } catch (err) {
      logger.debug(`[queue-monitor] onRunStart threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private emitEndIfIdle(): void {
    // Only truly idle when nothing is running AND the queue is drained — between
    // backlogged prompts runningPromptId briefly clears but queueRemaining stays
    // positive, and we must NOT warm the model just to unload it again.
    if (!this.busy) return;
    if (this.state.runningPromptId !== null) return;
    if (this.state.queueRemaining > 0) return;
    this.busy = false;
    try {
      this.onRunEnd?.();
    } catch (err) {
      logger.debug(`[queue-monitor] onRunEnd threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Is a generation currently in flight (edge-tracked)? */
  isBusy(): boolean {
    return this.busy;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    // Clear the flag here rather than relying on the old socket's `close`: once
    // we null `this.ws`, that socket's now-superseded close handler early-returns
    // (this.ws !== ws) and would otherwise leave `connected` stuck true — through
    // a retarget's stop()+start() gap, or indefinitely if the reconnect fails.
    this.state.connected = false;
  }

  private wsUrl(): string {
    // http(s)://host:port  →  ws(s)://host:port/ws?clientId=...
    const base = (this.url ?? "http://127.0.0.1:8188").replace(/^http/, "ws").replace(/\/+$/, "");
    return `${base}/ws?clientId=comfyui-mcp-watchdog`;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch (err) {
      logger.debug(`[queue-monitor] WS construct failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Guard every handler against a superseded socket: on retarget, stop()+start()
    // opens a new socket while the old one is still async-closing. Without the
    // `this.ws !== ws` check the old socket's late `close` would null out the NEW
    // socket and schedule a spurious reconnect.
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.state.connected = true;
      logger.debug("[queue-monitor] watchdog WS connected");
    });
    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (this.ws !== ws) return;
      if (isBinary) return; // preview image frames — ignore
      this.onMessage(raw.toString());
    });
    ws.on("close", () => {
      if (this.ws !== ws) return; // a superseded socket closing — ignore
      this.state.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      logger.debug(`[queue-monitor] WS error: ${err.message}`);
      try {
        ws.close();
      } catch {
        /* close handler schedules the reconnect */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
    // Don't keep the process alive solely for the watchdog reconnect.
    this.reconnectTimer.unref?.();
  }

  private touchActivity(): void {
    this.state.lastActivityTs = Date.now();
  }

  /** Adopt [promptId] as the running prompt when it's new — the broadcast-safe
   *  substitute for the sid-scoped execution_start this client never receives
   *  on modern ComfyUI. Fires the start transition exactly once per run. */
  private adoptRunningPrompt(promptId: unknown): void {
    if (typeof promptId !== "string" || promptId === this.state.runningPromptId) return;
    this.state.runningPromptId = promptId;
    this.touchActivity();
    this.emitStart();
  }

  private clearRunning(): void {
    this.state.runningPromptId = null;
    this.state.currentNode = null;
    this.state.progressValue = null;
    this.state.progressMax = null;
    this.state.lastActivityTs = null;
  }

  private onMessage(text: string): void {
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const data = (msg.data ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case "status": {
        const status = data.status as Record<string, unknown> | undefined;
        const execInfo = status?.exec_info as Record<string, unknown> | undefined;
        const qr = execInfo?.queue_remaining;
        if (typeof qr === "number") {
          this.state.queueRemaining = qr;
          // A status frame with an empty queue is ComfyUI's authoritative
          // "fully idle" signal. On modern ComfyUI (0.2x) the sid-scoped
          // executing/execution_success events never reach this passive
          // watchdog (see the progress_state case), so a run learned from
          // progress frames would otherwise never clear — drain it here.
          if (qr === 0) {
            if (this.state.runningPromptId !== null) this.clearRunning();
            this.emitEndIfIdle();
          }
        }
        break;
      }
      case "execution_start": {
        this.state.runningPromptId = typeof data.prompt_id === "string" ? data.prompt_id : null;
        this.state.currentNode = null;
        this.state.progressValue = null;
        this.state.progressMax = null;
        this.touchActivity();
        this.emitStart();
        break;
      }
      case "executing": {
        const node = data.node;
        if (node === null || node === undefined) {
          // ComfyUI sends node:null at the end of a prompt's execution.
          this.clearRunning();
          this.emitEndIfIdle();
        } else {
          const n = String(node);
          if (n !== this.state.currentNode) this.touchActivity(); // a new node = real progress
          this.state.currentNode = n;
          if (typeof data.prompt_id === "string") this.state.runningPromptId = data.prompt_id;
        }
        break;
      }
      case "progress": {
        const value = typeof data.value === "number" ? data.value : null;
        const max = typeof data.max === "number" ? data.max : null;
        // ONLY treat an advancing value as activity — a wedged step re-emits the
        // same value, and that must keep the stall clock running.
        if (value !== null && value !== this.state.progressValue) this.touchActivity();
        this.state.progressValue = value;
        this.state.progressMax = max;
        if (typeof data.node === "string") this.state.currentNode = data.node;
        // progress IS broadcast to every client and carries the prompt_id —
        // adopt it, since the sid-scoped execution_start may never have arrived
        // (see the progress_state case below).
        this.adoptRunningPrompt(data.prompt_id);
        break;
      }
      case "progress_state": {
        // Modern ComfyUI (verified live on 0.28): execution_start / executing /
        // execution_success are sent ONLY to the client that queued the prompt,
        // so this passive watchdog never sees them — but progress_state IS
        // broadcast, fires from the first node on, and names the running
        // prompt + node. Derive the run state from it so browser-/agent-queued
        // renders stay visible here (running flag, prompt_id, current node).
        this.adoptRunningPrompt(data.prompt_id);
        const nodes = data.nodes;
        if (nodes && typeof nodes === "object") {
          for (const entry of Object.values(nodes as Record<string, unknown>)) {
            if (!entry || typeof entry !== "object") continue;
            const n = entry as { state?: unknown; node_id?: unknown };
            if (n.state === "running" && typeof n.node_id === "string") {
              if (n.node_id !== this.state.currentNode) this.touchActivity(); // node advanced
              this.state.currentNode = n.node_id;
            }
          }
        }
        break;
      }
      case "execution_success":
      case "execution_error":
      case "execution_interrupted": {
        this.clearRunning();
        this.emitEndIfIdle();
        break;
      }
      default:
        break;
    }
  }

  /** Cheap snapshot for backpressure (panel_run) and the live `queue_status`
   *  broadcast (queue-status-broadcast.ts): is anything in flight, and where? */
  snapshot(): QueueSnapshot {
    return {
      connected: this.state.connected,
      running: this.state.runningPromptId !== null,
      runningPromptId: this.state.runningPromptId,
      queueDepth: Math.max(0, this.state.queueRemaining),
      currentNode: this.state.currentNode,
      progressValue: this.state.progressValue,
      progressMax: this.state.progressMax,
    };
  }

  /** Stall/backlog report for the turn-start injector. */
  report(stallMs: number): StallReport {
    const running = this.state.runningPromptId !== null;
    const queueDepth = Math.max(running ? 1 : 0, this.state.queueRemaining);
    const idleFor = running && this.state.lastActivityTs ? Date.now() - this.state.lastActivityTs : 0;
    const stalled = running && idleFor >= stallMs;
    const progress =
      this.state.progressValue !== null && this.state.progressMax !== null
        ? `${this.state.progressValue}/${this.state.progressMax}`
        : null;
    return {
      stalled,
      backlog: queueDepth > 1,
      runningPromptId: this.state.runningPromptId,
      currentNode: this.state.currentNode,
      queueDepth,
      stalledForMs: stalled ? idleFor : 0,
      progress,
    };
  }
}

/** Process-wide singleton (one ComfyUI per orchestrator). */
export const QueueMonitor = new QueueMonitorImpl();
