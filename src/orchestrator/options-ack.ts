// Shapes the `set_options` reply frames (the model/effort picker's acks).
//
// WHY THIS EXISTS: each `set_options` is handled in a detached async task
// (model discovery + manager.setOptions are awaited), so acks can complete —
// and arrive at the client — OUT OF ORDER, and the ack itself used to carry no
// request identity. A client with more than one attempt outstanding (e.g. a
// timed-out pick followed by a retry) could not tell which ack answered which
// request. Clients may now stamp the request with an opaque `rid`; we echo it
// verbatim on the ack, alongside `requested_model` (the id the client ASKED
// for, pre-resolution/pre-guard), so correlation is exact.
//
// Backward compatible in both directions:
//  • a request WITHOUT `rid` produces the exact ack shape shipped before
//    (no new fields except `requested_model` when a model was requested,
//    which old panels ignore);
//  • the error path keeps the legacy `say` frame for old clients, and ONLY
//    adds an ok:false options ack when the request carried a `rid` (so old
//    panels never see a failure ack they don't expect).

/** What `manager.setOptions` reports it actually applied. */
export interface AppliedOptions {
  model: string;
  effort?: string | null;
  restarted: boolean;
  deferred: boolean;
}

/** Correlation metadata lifted off the incoming `set_options` event. */
export interface OptionsRequestMeta {
  /** Opaque client correlation id — echoed verbatim when present. */
  rid?: string;
  /** The model id the client requested, BEFORE the unknown-model guard. */
  requestedModel?: string;
}

/** Read the optional correlation fields off a raw `set_options` event. */
export function optionsRequestMeta(event: {
  rid?: unknown;
  model?: unknown;
}): OptionsRequestMeta {
  return {
    ...(typeof event.rid === "string" && event.rid ? { rid: event.rid } : {}),
    ...(typeof event.model === "string" && event.model
      ? { requestedModel: event.model }
      : {}),
  };
}

/** The success ack: what was applied + exact request correlation. */
export function optionsAckFrame(
  applied: AppliedOptions,
  meta: OptionsRequestMeta,
): Record<string, unknown> {
  return {
    type: "ack",
    ok: true,
    kind: "options",
    model: applied.model,
    effort: applied.effort ?? null,
    restarted: applied.restarted,
    // Effort changed mid-turn → it takes effect once the current turn ends
    // (we never interrupt a live reply). The client can note this.
    deferred: applied.deferred,
    ...(meta.rid !== undefined ? { rid: meta.rid } : {}),
    ...(meta.requestedModel !== undefined
      ? { requested_model: meta.requestedModel }
      : {}),
  };
}

/**
 * The failure ack — ONLY for rid-stamped requests (returns null otherwise, so
 * legacy clients keep seeing just the `say` and never a failure ack shape they
 * don't handle). Lets a correlating client resolve the exact attempt that
 * failed instead of waiting out a timeout.
 */
export function optionsErrorAckFrame(
  message: string,
  meta: OptionsRequestMeta,
): Record<string, unknown> | null {
  if (meta.rid === undefined) return null;
  return {
    type: "ack",
    ok: false,
    kind: "options",
    message,
    rid: meta.rid,
    ...(meta.requestedModel !== undefined
      ? { requested_model: meta.requestedModel }
      : {}),
  };
}
