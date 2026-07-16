// Live queue-status fan-out for panel/mobile tabs.
//
// The QueueMonitor watchdog (queue-monitor.ts) already tracks ComfyUI's live
// execution state — for EVERY job, including browser-queued ones — but until
// now that state never left the orchestrator process. This module turns its
// snapshot into a `queue_status` bridge frame so a connected tab (the mobile
// app's live queue monitor) can show queue depth + render progress in real
// time.
//
// Throttle contract: the orchestrator ticks the broadcaster on a 1-second
// interval, and `tick()` pushes ONLY when the frame differs from the last one
// sent. An idle rig therefore broadcasts nothing at all, and a running render
// costs at most one frame per second.

import type { QueueSnapshot } from "./queue-monitor.js";

/** The wire shape of one live queue-status broadcast. */
export interface QueueStatusFrame extends Record<string, unknown> {
  type: "queue_status";
  /** The watchdog WS to ComfyUI is up (false → the rest is last-known/empty). */
  connected: boolean;
  /** A prompt is executing right now. */
  running: boolean;
  /** running + pending, from ComfyUI's own queue_remaining. */
  queue_depth: number;
  /** prompt_id of the running job (null when idle). */
  prompt_id: string | null;
  /** The node id currently executing (ComfyUI graph node id, null when idle). */
  node: string | null;
  /** Sampler-step progress of the current node (null before the first tick). */
  progress_value: number | null;
  progress_max: number | null;
}

/** Build the broadcast frame for one monitor snapshot. */
export function buildQueueStatusFrame(s: QueueSnapshot): QueueStatusFrame {
  return {
    type: "queue_status",
    connected: s.connected,
    running: s.running,
    queue_depth: s.queueDepth,
    prompt_id: s.runningPromptId,
    node: s.currentNode,
    progress_value: s.progressValue,
    progress_max: s.progressMax,
  };
}

export interface QueueStatusBroadcaster {
  /** Poll the snapshot and push a frame IF (and only if) it changed. */
  tick(): void;
  /** The current frame (for a targeted push to a tab that just connected). */
  current(): QueueStatusFrame;
}

/**
 * Wire a snapshot source to a push sink with change-only semantics. The sink
 * is the bridge's broadcast push; it must never throw into the timer (the
 * bridge's own push already guarantees that, see ui-bridge.ts).
 */
export function createQueueStatusBroadcaster(
  snapshot: () => QueueSnapshot,
  push: (frame: QueueStatusFrame) => void,
): QueueStatusBroadcaster {
  let last = "";
  return {
    tick(): void {
      const frame = buildQueueStatusFrame(snapshot());
      const key = JSON.stringify(frame);
      if (key === last) return;
      last = key;
      push(frame);
    },
    current(): QueueStatusFrame {
      return buildQueueStatusFrame(snapshot());
    },
  };
}
