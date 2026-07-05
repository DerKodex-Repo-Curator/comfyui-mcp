# Per-workflow agent targeting

## Problem

Each ComfyUI browser tab connects to the orchestrator with a `tab_id`, but ComfyUI can have **multiple workflow tabs** open inside that browser tab. Graph tools (`graph_get_state`, `graph_add_node`, …) default to whichever workflow the user is **currently viewing**. If the user switches workflow tabs while the agent is working, edits land on the wrong graph.

## Solution

The orchestrator keeps a per-`tab_id` **workflow target**:

| mode | behavior |
|------|----------|
| `current` | Graph tools follow the user's active workflow tab (default) |
| `pinned` | Graph tools include `workflow_path` on scoped commands |

### Orchestrator API

- **MCP tools:** `panel_get_workflow_target`, `panel_set_workflow_target`
- **Bridge event (panel → orchestrator):** `{ type: "set_workflow_target", tab_id, mode, path?, filename? }`
- **Bridge push (orchestrator → panel):** `{ type: "workflow_target", target }`
- **Ack:** `{ type: "ack", ok, kind: "workflow_target", target? }`

### Command injection

When pinned, the orchestrator adds `workflow_path` to:

- All `graph_*` commands
- `workflow_save`, `workflow_save_as`, `workflow_rename`, `workflow_close` when `path` is omitted

Never injected on: `workflow_list`, `workflow_new`, `workflow_open`.

### Panel implementation (comfyui-mcp-panel)

Each graph executor should:

1. Read optional `workflow_path` on the incoming `{ rid, cmd, … }` frame.
2. Resolve the workflow document for that path (not only the active tab).
3. Apply the mutation on that document's graph store.
4. Optionally refresh UI if that workflow is visible; **do not** switch the user's active tab unless `workflow_open` is called.

Background edits on a non-active workflow should still persist and mark that tab modified.

## Files

- `src/services/workflow-target-store.ts` — store + injection helper
- `src/orchestrator/panel-tools.ts` — MCP tools + `makePanelToolCtx` injection
- `src/orchestrator/index.ts` — bridge handler + hello sync