# Declarative per-category safety gates + `capability_audit`

**Status:** draft (RFC — spec-only PR) · **Implementation branch:** `feat/safety-gates` · **Depended on by:** node-dev-tools (node-writes, git-writes), comfyui-settings-tools (settings-writes)

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) ships five env-var safety gates (`FL_MCP_ENABLE_*`, default **deny**) enforced by copy-pasted early returns in ~40 tool bodies, plus an `mcp_capability_audit` tool. We adopt the *idea* — env-controlled capability classes with structured, agent-self-correcting refusals — but invert the default (open, for back-compat) and enforce at a single registration-time choke point instead of per-tool guards.

## Motivation

Operators running an agent against a machine they care about (shared RunPod pods, CI, demo boxes, "my ComfyUI but don't touch my models") want to switch off destructive capability classes without forking the server. comfyui-mcp has ~120 tools and two registration paths (full mode and the compact `call_tool` router), so FL-MCP-style per-tool guards would be unmaintainable and unverifiable here. Everything already flows through one point: the `server.tool(name, description, schema, handler)` registration pass in `src/tools/index.ts` — `ToolCatalog.asRegistrar()` (`src/tools/catalog.ts:55-61`) already demonstrates that only `.tool()` is ever touched by tool groups.

Unlike FL-MCP we have existing users, so gates default **open** (byte-identical current behavior). Lockdown is opt-in via `COMFYUI_MCP_SAFE_MODE=1`.

## Gate taxonomy

Single source of truth in a new `src/tools/gates.ts`:

| Gate id | Env override | Covers (verified tool names) | Default | In SAFE_MODE |
|---|---|---|---|---|
| `workflow-writes` | `COMFYUI_MCP_ALLOW_WORKFLOW_WRITES` | `save_workflow`, `lock_workflow` | open | closed |
| `queue-mutations` | `COMFYUI_MCP_ALLOW_QUEUE_MUTATIONS` | `clear_queue`, `cancel_job`, `cancel_queued_job`, `edit_queued_job`, `move_queued_job`, `clear_vram` | open | closed |
| `model-downloads` | `COMFYUI_MCP_ALLOW_MODEL_DOWNLOADS` | `download_model`, `download_civitai_model`, `apply_manifest`, `install_workflow_dependencies` | open | closed |
| `model-deletes` | `COMFYUI_MCP_ALLOW_MODEL_DELETES` | `remove_model`, `add_extra_path`, `remove_extra_path` | open | closed |
| `node-writes` | `COMFYUI_MCP_ALLOW_NODE_WRITES` | `install_custom_node`, `update_custom_node`, `reinstall_custom_node`, `fix_custom_node`, `sync_node_dependencies`, `save_node_snapshot`, `restore_node_snapshot`, `bisect_start/good/bad/reset`, `scaffold_custom_node`, plus node-dev-tools' `write_node_file`, `apply_node_patch` | open | closed |
| `process-control` | `COMFYUI_MCP_ALLOW_PROCESS_CONTROL` | `start_comfyui`, `stop_comfyui`, `restart_comfyui`, `install_comfyui`, `update_comfyui`, `update_all`, `configure_manager` | open | closed |
| `self-update` | `COMFYUI_MCP_ALLOW_SELF_UPDATE` | `self_update`, `install_panel` | open | closed |
| `external-uploads` | `COMFYUI_MCP_ALLOW_EXTERNAL_UPLOADS` | `upload_output`, `publish_custom_node`, `report_issue` | open | closed |
| `settings-writes` | `COMFYUI_MCP_ALLOW_SETTINGS_WRITES` | comfyui-settings-tools' `set_comfyui_setting` | open | closed |
| `git-writes` | `COMFYUI_MCP_ALLOW_GIT_WRITES` | node-dev-tools' `node_pack_git` commit/push actions | **closed** | closed |
| `panel-writes` | `COMFYUI_MCP_ALLOW_PANEL_WRITES` | orchestrator live-canvas mutators: `panel_add_node`, `panel_remove_node`, `panel_clear`, `panel_load_workflow`, `panel_connect`, `panel_disconnect`, `panel_set_widget`, `panel_move_node`, `panel_run`, `panel_strip_workflow`, `panel_slice_workflow` (and `graph_*` aliases) | open | closed |

Notes:

- Read-only tools (`get_*`, `list_*`, `search_*`, `visualize_*`, `health_check`, `bisect_status`, git status/diff/log) are **never** gated.
- `enqueue_workflow` / `generate_*` are deliberately ungated — they are the product. SAFE_MODE still lets an agent generate images; it stops it from mutating the machine.
- `git-writes` defaults **closed** even outside SAFE_MODE: it is a brand-new capability (no back-compat concern) and push has off-machine effects.

## Configuration

Naming follows the existing `COMFYUI_MCP_*` boolean convention (`"1"`/`"true"`; cf. `COMFYUI_MCP_FORCE_REMOTE` in `src/config.ts:337`, `COMFYUI_MCP_ALLOW_UNAUTH` in `src/transport/cli.ts`).

- `COMFYUI_MCP_SAFE_MODE=1` — flip every gate's default to closed.
- `COMFYUI_MCP_ALLOW_<GATE>=1|0` — per-gate override in either direction (explicit `=1` opens a gate even under SAFE_MODE; `=0` closes one gate without SAFE_MODE).
- CLI flags in `src/transport/cli.ts` (`parseCliArgs`, same `--flag value` / `--flag=value` idiom): `--safe-mode`, `--allow <csv>`, `--deny <csv>` (gate ids, e.g. `--allow node-writes,git-writes`).
- Config file: a `permissions` block in the file DefaultsManager already owns (`$XDG_CONFIG_HOME/comfyui-mcp/config.json`, `src/services/defaults-manager.ts:21-25`):

  ```json
  { "permissions": { "safe_mode": true, "allow": ["queue-mutations"], "deny": [] } }
  ```

  `gates.ts` reads this key itself (one small sync read at startup) rather than routing through the `COMFYUI_DEFAULT_`-oriented DefaultsManager API.
- Precedence: **CLI > env > config file > built-in default** (same order documented at `cli.ts:61`).

## Refusal shape

Gated calls return a normal `CallToolResult` with `isError: true` and a JSON text body matching the `ComfyUIError.toToolResult()` style (`src/utils/errors.ts:13-27`), extended with self-correction fields (FL-MCP's `disabled_by_config` contract, made agent-legible):

```json
{
  "error": "DISABLED_BY_CONFIG",
  "message": "Tool 'remove_model' is disabled: safety gate 'model-deletes' is closed (COMFYUI_MCP_SAFE_MODE=1).",
  "disabled_by_config": true,
  "gate": "model-deletes",
  "required_flag": "COMFYUI_MCP_ALLOW_MODEL_DELETES=1",
  "how_to_enable": [
    "Restart the MCP server with COMFYUI_MCP_ALLOW_MODEL_DELETES=1, or",
    "pass --allow model-deletes, or",
    "add it to permissions.allow in ~/.config/comfyui-mcp/config.json",
    "Run capability_audit to see all gate states."
  ]
}
```

Implemented as `class GateClosedError extends ComfyUIError` (code `DISABLED_BY_CONFIG`) plus a `gateRefusal(gate, toolName): CallToolResult` helper so panel-tools can produce the identical shape from its own process.

## Enforcement mechanism

New `src/tools/gates.ts`:

```ts
export type GateId = "workflow-writes" | /* ... */;
export const TOOL_GATES: Readonly<Record<string, GateId>>;           // tool name -> gate
export function resolveGateStates(env, argv, configJson): GateStates; // memoized at startup
export function isGateOpen(gate: GateId): boolean;
export function gateRefusal(gate: GateId, tool: string): CallToolResult;
export function withGates(server: McpServer): McpServer;              // duck-typed wrapping registrar
```

`withGates()` mirrors `ToolCatalog.asRegistrar()`: it returns `{ tool: (...args) => ... }` which, when `TOOL_GATES` has the tool name, replaces the trailing handler with a guard that returns `gateRefusal()` when closed and delegates otherwise, then forwards to the real `server.tool`. The guard runs **per call**, so gate state can later become runtime-mutable; v1 resolves state once at startup.

Wiring — two one-line changes in `src/tools/index.ts`:

- `registerAllTools`: `for (const [, register] of TOOL_GROUPS) register(withGates(server));`
- `collectToolCatalog`: `register(withGates(registrar))` — the catalog then captures already-wrapped handlers, so compact mode's `call_tool` (`compact.ts:191`) enforces gates with zero extra code.

Panel path: `registerPanelTools` / `buildPanelToolDefs` in `src/orchestrator/panel-tools.ts` import `isGateOpen("panel-writes")` / `gateRefusal` directly (the orchestrator registers its own tools in a separate process; the choke-point wrapper doesn't reach it, but the same module does).

Interplay with modes: gates are orthogonal to and evaluated **before** the existing cloud/remote guards (`isCloudMode`/`isRemoteMode`, `config.ts:429-439`) — a closed gate refuses even where the tool would anyway throw `RemoteModeError`.

One sanctioned exception to "no in-handler gate checks": action-enum tools whose actions span gates (e.g. `node_pack_git` — status/diff/log are reads, commit/push are `git-writes`) call `isGateOpen`/`gateRefusal` inside the handler, documented in `gates.ts`.

## `capability_audit` tool

`health_check` (`src/tools/health-check.ts`) is a **ComfyUI-instance** diagnostic (GPU/VRAM/queue/models/logs). `capability_audit` answers a different question — "what is this MCP server allowed and able to do right now" — so it is a new tool, not an extension; the two descriptions cross-link.

- Name `capability_audit`; category `diagnostics`; files `src/tools/capability-audit.ts` + `src/services/capability-audit.ts`; registered by appending to `TOOL_GROUPS` (registration order is observable per `index.ts:53-57` — append-only).
- Zero params. Result (JSON text):

```json
{
  "version": "0.28.0",
  "mode": "local | remote | cloud",
  "safe_mode": false,
  "gates": [
    { "gate": "model-deletes", "state": "open", "source": "default",
      "env": "COMFYUI_MCP_ALLOW_MODEL_DELETES", "tools": ["remove_model", "..."] }
  ],
  "comfyui": { "reachable": true, "url": "http://127.0.0.1:8188", "version": "0.3.x", "latency_ms": 12 },
  "manager": { "available": true, "generation": "v4" },
  "panel_bridge": { "configured_port": 9180, "listening": false,
                    "note": "bridge is owned by the panel orchestrator process" },
  "workspace": { "comfyui_path": "D:/ComfyUI", "custom_nodes_path": "D:/ComfyUI/custom_nodes", "writable": true },
  "tool_mode": "full | compact"
}
```

- Reuse: `getComfyUIBaseUrl`/`isCloudMode`/`isRemoteMode`/`config.comfyuiPath` (`src/config.ts`); the manager-generation probe and timeout-bounded `/system_stats` fetch pattern from `src/services/env-capabilities.ts` (`withTimeout`). Bridge check is a best-effort TCP connect to `COMFYUI_MCP_BRIDGE_PORT ?? 9180`. Every probe is timeout-bounded — the audit must never hang.

## Implementation plan

1. `src/tools/gates.ts` — gate ids, `TOOL_GATES`, state resolution (env + argv + config `permissions`), `withGates`, `gateRefusal`, `GateClosedError` (colocated or in `src/utils/errors.ts`).
2. `src/transport/cli.ts` — `safeMode: boolean`, `allowGates: string[]`, `denyGates: string[]` on `CliOptions` + parsing; `src/index.ts` feeds them into `resolveGateStates` before tool registration (both branches at `index.ts:113-125`).
3. `src/tools/index.ts` — wrap the registrar in `registerAllTools` and `collectToolCatalog`.
4. `src/services/capability-audit.ts` + `src/tools/capability-audit.ts`; append `["diagnostics", registerCapabilityAuditTools]` to `TOOL_GROUPS`.
5. `src/orchestrator/panel-tools.ts` — guard mutating panel tools with `isGateOpen("panel-writes")`.
6. Docs: README safety section + docs page; gated tool descriptions mention that refusals carry `required_flag`.

## Test plan (vitest)

- `src/__tests__/gates.test.ts` — state matrix: default open; SAFE_MODE closes all; `ALLOW_X=1` re-opens under SAFE_MODE; `ALLOW_X=0` closes individually; CLI `--allow/--deny` beats env; config-file `permissions` beats default, loses to env (fake `env`/`argv` per `config.test.ts` pattern).
- Registrar wrap: fake `server.tool` capture (same trick as `ToolCatalog`); gated tool returns the exact refusal JSON when closed and delegates when open; ungated handlers pass through with **reference equality** (zero overhead for reads).
- Compact mode: `collectToolCatalog()` under SAFE_MODE, `call_tool` a gated tool, assert refusal.
- `TOOL_GATES` hygiene: every key exists in the collected catalog (catches renames); snapshot gated-tool list per gate.
- capability-audit unit test with mocked fetch: reachable/unreachable, gate rendering, never throws.

## Rollout / compat

- Default behavior byte-identical for existing users (gates open; ungated tools untouched; tool order unchanged; one new tool appended).
- SAFE_MODE documented as the "untrusted agent / shared box" recommendation; RunPod images can bake `COMFYUI_MCP_SAFE_MODE=1`.
- `git-writes` ships closed — CHANGELOG callout (new capability, not a regression).
- Follow-ups (out of scope): runtime gate toggling via a confirmed admin tool; per-client gates in the HTTP transport.
