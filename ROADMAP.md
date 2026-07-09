# ComfyUI MCP — Roadmap

**Vision:** an agent can author, run, *fix*, and *ship* ComfyUI — from a prompt, to a working
workflow, to an in-UI assistant that edits the graph live, to a published custom node. comfyui-mcp
is the backend tool surface; the pieces below extend it up into the ComfyUI frontend and out to the
Comfy Registry.

> Tracking: themes map to beads **epics**; items map to issues. Run `bd ready` for what's actionable.
> This file is the human-readable map; beads is the source of truth for status.

---

## Status — 2026-05-26

- **Released:** `0.7.0` on npm — Theme E stability/hardening (E1–E4, E7, E2-auth), custom-node
  authoring tools, experimental agent-panel backend, hosted docs.
- **Complete (on main, unreleased → queued for `0.8.0`):** Theme E additive (E5 `apply_manifest`,
  E6/E2b cloud storage, E8 `convert_image`), Theme C (C3 `verify_custom_node`, C5 scaffold CI),
  Theme D (D1 `comfy-researcher` + skill cache). **Epics A, C, D, E are closed.**
- **Pending release:** cut **`0.8.0`** for the unreleased surface above — `comfyui-mcp-yrp` (see beads).
- **Blocked:** **Theme B** (embedded agent panel UI, B3–B6) is gated on the upstream
  **`@comfyorg/extension-api`** package being published to npm (PRs #12142–#12145 still open). The
  panel *backend* POC (B1/B2) already shipped. Tracked by a watch bead under Epic B; resume the
  codex build loop on B once the package lands.

---

## ✅ Shipped (0.6.x)
- comfy-cli capability port (custom-node mgmt, snapshots, bisect, workflow deps, install/update,
  models, workspace/env, API nodes, manager config) — tools surface ~70+.
- `upload_video` / `upload_audio`.
- Mintlify docs site (schema-generated tool reference) at comfyui-mcp.artokun.io/docs.
- Glama listing + TDQS A-grade pass; blog post (TDQS case study).

---

## Theme A — Frontend extension authoring (enabler)
The new ComfyUI frontend extension API (`@comfyorg/extension-api`, v2; replaces
`app.registerExtension`) is brand-new and absent from model training data. Teach it so we (and any
user) can write correct frontend extensions — the substrate for Theme B.

- **A1 — Skill: author v2 extensions.** `defineNode`/`defineExtension`/`defineWidget`,
  `defineSidebarTab`, `NodeHandle`/`WidgetHandle`, event namespaces (`execution`/`graph`/`server`/
  `workbench`), `DisposableHandle` contract, identity helpers, the event+getter/setter idiom.
- **A2 — Skill: migrate v1 → v2.** Map legacy `app.registerExtension` / prototype-patching patterns
  to the v2 API (the ecosystem dashboard's api-diff/patterns are the source). DrJKL collaboration hook.
  > Source: `Comfy-Org/ComfyUI_frontend` PRs #12142–#12145; `src/extension-api/`. Package not yet on npm.

## Theme B — Embedded agent panel (north star)
A ComfyUI **sidebar tab** (AI icon) hosting an [AI SDK](https://sdk.vercel.ai) chat window. You chat
with Claude Code / Codex / Gemini and it reads + **fixes the live workflow in the UI**. Connection
to the agent "app" is via a **cloudflared tunnel** (Ungate-style). Full design:
[`design/embedded-agent-panel.md`](./design/embedded-agent-panel.md).

- **B1 — Tunnel helper.** Port Ungate's `tunnel-manager` (the `cloudflared` npm lib:
  `Tunnel.quick(localUrl) → public https URL`) into our server as `startQuickTunnel(port)`, behind a flag.
- **B2 — AI SDK chat endpoint.** `POST /api/chat` → `streamText(...).toUIMessageStreamResponse()`,
  provider registry (Anthropic/OpenAI/Google), one real server-side tool end-to-end.
- **B3 — Sidebar panel.** `defineSidebarTab` + AI SDK `useChat` pointed at the tunnel; render stream.
- **B4 — Live graph edits.** Graph-mutation tools (`set_widget_value`, `add_node`, `connect`, …) as
  AI SDK **client-side tools** resolved in the panel via extension-api (`NodeHandle`/`WidgetHandle`).
  *This is the magic — "fix it in the UI."*
- **B5 — Wire comfyui-mcp** as the server-side tool surface via AI SDK MCP client.
- **B6 — Provider switch + connection/key UX + ship** as a node pack.

## Theme C — Custom-node authoring lifecycle (NEW)
Create a Python custom node from a template, install + restart to test, then publish to the
[Comfy Registry](https://docs.comfy.org/registry/overview). The full "agent builds & ships a node" loop.

- **C1 — Skill: ComfyUI Registry + custom-node authoring.** Minimal node structure
  (`__init__.py`, `NODE_CLASS_MAPPINGS`/`NODE_DISPLAY_NAME_MAPPINGS`, `INPUT_TYPES`/`RETURN_TYPES`/
  `FUNCTION`/`CATEGORY`, optional `WEB_DIRECTORY`), `pyproject.toml` (`[project]` + `[tool.comfy]`:
  `PublisherId`/`DisplayName`/`Icon`), publisher + API key flow, `comfy node init`/`publish`, the
  `Comfy-Org/publish-node-action` CI workflow + `REGISTRY_ACCESS_TOKEN`.
- **C2 — MCP `scaffold_custom_node`.** Generate a node pack into `custom_nodes/<name>/` from a
  template (prefer `comfy node init`; fall back to our own template). Local-only.
- **C3 — Test loop.** Install → `restart_comfyui` (have it) → verify the new `class_type` appears in
  `/object_info` → enqueue a smoke-test workflow using it.
- **C4 — MCP `publish_custom_node`.** `comfy node publish` with token; validate `pyproject.toml`
  metadata first. Token via env (never in URLs/logs), like the CivitAI pattern.
- **C5 — Template + CI scaffold.** A spawnable starter (Python node + optional v2 frontend +
  `publish_action.yml`) so `create → restart → test → publish` is one smooth path.

## Theme D — Discovery (from prior notes)
- **D1 — `comfy-researcher` agent + skill cache.** Problem→packs research over the Registry +
  HF + community, with a cached skill layer. (Folded in from `TODO.md`.)

## Theme E — Production hardening & I/O (from [Salad's comfyui-api](https://github.com/SaladTechnologies/comfyui-api), MIT)
Harden existing tools and add production I/O, adapting patterns from comfyui-api. We are an
agent-facing MCP, not a horizontally-scaled web service — so we cherry-pick and skip the
stateless-server / Salad-specific bits (replicas, deletion-cost, k8s proxy).

**Harden existing tools**
- **E1 — Download cache + dedup.** Content-address downloads (SHA-256 of URL → cache dir + sidecar
  `.meta`, symlink to target), reuse on hit, coalesce concurrent same-URL fetches, optional LRU
  eviction. Hardens `download_model`/`download_civitai_model`. (`remote-storage-manager.ts`, `utils.hashUrlBase64`)
- **E2 — Download auth + storage backends.** Per-URL credential resolution (bearer/basic/header/
  query/s3) and `s3://` / huggingface / azure-blob / http(s) sources for gated/private models.
  (`credential-resolver.ts`, `storage-providers/*`)
- **E3 — ComfyUI supervision.** Auto-restart-on-crash + bounded startup readiness checks
  (interval/max-tries) + a real readiness signal. Hardens `start/stop/restart_comfyui`. (`comfy.ts`)
- **E4 — Rich errors + execution stats.** Surface ComfyUI `execution_error` (exception_type,
  traceback, current_inputs — e.g. OOM) and per-node timing in job results. Hardens
  `get_job_status`/completion reporting. (`event-emitters.ts`)
- **E7 — Custom-node ref-pinning.** Install a node pack pinned to a commit/branch/tag across
  GitHub/GitLab/Bitbucket URL formats. Hardens `install_custom_node` (reproducibility). (`git-url-parser.ts`)
- **E11 — Unique output filenames.** Prefix a request id to output filenames to avoid collisions.

**Additive capabilities**
- **E5 — Declarative environment manifest.** `apply_manifest` (yaml/json): apt/pip/custom_nodes/
  models (before/after start), idempotent — reproducible setups. Pairs with Theme C + workspace.
- **E6 — Output upload to cloud storage.** Push generated outputs to S3 / Azure / HF / HTTP and
  return URLs. (`remote-storage-manager.ts`, `storage-providers/*`)
- **E8 — Server-side image conversion.** `sharp` PNG↔JPEG↔WebP + quality options for compact outputs. (`image-tools.ts`)
- **E9 — Dynamic model loading.** URL in a model-loading node → auto-download + cache before exec. (`comfy-node-preprocessors.ts`)
- **E10 — Warmup.** Run a warmup workflow after `start_comfyui` to preload models. (`comfy.warmupComfyUI`)
- **E12 — Outbound webhooks (later).** Signed Standard Webhooks on completion/progress + retries —
  mainly for the headless/bridge path, not the interactive plugin. (`event-emitters.ts`)

> License: comfyui-api is MIT (deps MIT/Apache-2.0; ComfyUI itself GPL-3.0). Patterns/code are safe
> to adapt with attribution. Clone for reference: `~/code/salad-comfyui-api`.

## Theme F — Agentic mobile / remote client (teased, not yet building)
A purely **agent-driven** way to make things from your phone, backed by an agent that runs on your
own machine. Most people should never see a node graph — you chat, the agent builds it; the canvas
still exists under the hood, it just isn't the interface. Full vision:
[`design/mobile-agent-client.md`](./design/mobile-agent-client.md). Gated on the core (Themes B/E)
hardening first; this is the "shape it with users before building" track.

- **F1 — Desktop agent host (runs like Ollama).** A quiet always-on daemon that owns the agent loop,
  talks to local ComfyUI, and uses the user's LLM (local or logged-in Claude/ChatGPT/Gemini). The
  product surface; the phone is a thin remote into it.
- **F2 — Secure tunnel out + "Remote control" pairing.** Tailscale/cloudflared-style encrypted
  tunnel (reuse B1 `startQuickTunnel`) + a **Remote control button in the Agent Panel** that mints a
  pairing token/QR (Claude `/remote-control`-style). **Token-based, no account required** — stays
  inside the user's network.
- **F3 — Two UIs, one spec.** Panel and mobile both generate + consume the *same* workflow spec, so a
  piece built in one opens cleanly in the other (couch→desk handoff). The spec is the contract.
- **F4 — Depth on demand (Apps → blocks → dials → graph).** Adopt ComfyUI's **Apps** feature as the
  shallow end (form over a workflow, nodes hidden); expand a block to all its widgets via the
  **widget-promotion** path; drop to full manual/agentic node editing. Same spec at every zoom level.
- **F5 — Subgraphs as blocks + a stocked library.** Ship **base subgraphs** (txt2img/img2img/upscale/
  video) so a fresh install is useful day one, plus **utility subgraphs** (smart resolution, prompt
  scaffolding, save+preview tail, model-swap adapters).
- **F6 — CivitAI, first-class.** Browse/search/copy-prompts + an **Amazon-style cart** (queue N
  resources, one tap, land on the rig via the aria2 path) + agent self-heal on missing models. Reuse
  the decoded CivitAI API / login / account-management internals from `~/code/slutter` (Flutter).
- **F7 — Flutter client (Android + iOS).** One codebase for the block / flow / Lego-snap-port
  interactions; desktop/web later, which plays nicely with F3.
- **F8 — Later: RunPod / cloud GPUs.** SSH tunnel + helper scripts for the annoying parts (logging
  into Claude/Gemini/Codex on the pod, or standing up Ollama there). **Not** in the first release —
  local-GPU-to-start keeps the surface small.

> Scope: **v1 = local GPU only.** Reference client internals: `~/code/slutter` (CivitAI Video
> Scroller, Flutter — decoded CivitAI API, OAuth login, account management).

---

## "Roadmap to the roadmap" — sequencing

| Phase | Goal | Items |
| --- | --- | --- |
| **0 — now (parallel)** | Enablers + node lifecycle + panel backend POC | A1, A2, C1, C2, C4, B1, B2 |
| **1 — prove the loop** | Live in-UI editing works | B3, B4, C3, C5, E5, E6 |
| **2 — productionize** | Full agent panel + discovery + I/O | B5, B6, D1, E8, E9, E10, E12 |
| **Hardening — continuous** | Reliability + I/O from comfyui-api | E1, E2, E3, E4, E7, E11 |
| **3 — mobile / remote (teased)** | Agent-driven phone client on your own rig | F1, F2, F3, F4, F5, F6, F7 (F8 later) |

Phase 0 ships value immediately (skills + node tooling) and de-risks the panel (tunnel + streaming)
before any frontend work. Phase 1 needs the v2 package closer to publish for the panel UI.

## Google Antigravity Setup

Google Antigravity support is integrated via the `.agents` and `.gemini` setup.
Run `npm run sync-agents` to transpile Claude Code plugins into Google Antigravity compatible skills, commands, and hooks.
See [GEMINI.md](./GEMINI.md) for development notes.
