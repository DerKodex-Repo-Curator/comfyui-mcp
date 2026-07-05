// Headless MOCK PANEL for unattended testing of the orchestrator agent.
//
// Connects to the bridge like the real panel, implements the graph executors
// in-memory, and RECORDS every command the agent issues — so we can drive the
// agent end-to-end and assert behavior (e.g. that "new workflow" does NOT call
// graph_clear) without a browser or a live ComfyUI.
//
// Env:
//   BRIDGE_URL    ws url (default ws://127.0.0.1:9111 — a TEST orchestrator)
//   TASK          the user message to send
//   SEED_NODES    pre-populate N fake nodes (simulate an existing workflow)
//   DURATION_MS   how long to listen (default 60000)
import { WebSocket } from "ws";

const url = process.env.BRIDGE_URL || "ws://127.0.0.1:9111";
const task = process.env.TASK || "Read my current graph and tell me what nodes are on it.";
const seed = Number(process.env.SEED_NODES || 0);
const duration = Number(process.env.DURATION_MS || 60000);

const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// --- in-memory workflows (multi-tab) ---
let seq = 0;
const workflows = new Map(); // path -> { nodes, title }
let activePath = "workflows/current.json";
function ensureWorkflow(path) {
  if (!workflows.has(path)) {
    workflows.set(path, { title: path.replace(/.*\//, ""), nodes: new Map() });
  }
  return workflows.get(path);
}
function wfFor(args) {
  return ensureWorkflow(args.workflow_path || activePath);
}
function addNode(wf, type, title) {
  const id = ++seq;
  wf.nodes.set(id, {
    id,
    type,
    title: title || type,
    widgets: { value: 0, text: "" },
    inputs: [
      { name: "in0", type: "*", link: null },
      { name: "model", type: "MODEL", link: null },
    ],
    outputs: [
      { name: "out0", type: "*", links: [] },
      { name: "MODEL", type: "MODEL", links: [] },
    ],
  });
  return wf.nodes.get(id);
}
const current = ensureWorkflow(activePath);
for (let i = 0; i < seed; i++) addNode(current, `SeedNode${i}`, `Existing node ${i}`);
const blueprints = new Map();
let clipboard = [];
let selection = [];

const commands = []; // { cmd, args }
const says = [];

function summarize(n) {
  return { id: n.id, type: n.type, title: n.title, is_subgraph: !!n.is_subgraph, widgets: n.widgets, inputs: n.inputs, outputs: n.outputs };
}

const EXEC = {
  graph_get_state: (args) => {
    const wf = wfFor(args);
    return {
      viewing: { scope: "root" },
      workflow_path: args.workflow_path || activePath,
      node_count: wf.nodes.size,
      truncated: false,
      nodes: [...wf.nodes.values()].map(summarize),
    };
  },
  graph_add_node: (args) => {
    const wf = wfFor(args);
    if (!args.class_type) throw new Error("class_type required");
    return { added: summarize(addNode(wf, args.class_type, args.title)), workflow_path: args.workflow_path || activePath };
  },
  graph_remove_node: (args) => {
    const wf = wfFor(args);
    const n = wf.nodes.get(Number(args.node_id));
    if (!n) throw new Error(`no node ${args.node_id}`);
    wf.nodes.delete(Number(args.node_id));
    return { removed: summarize(n) };
  },
  graph_clear: (args) => {
    const wf = wfFor(args);
    const c = wf.nodes.size;
    wf.nodes.clear();
    return { cleared: c, workflow_path: args.workflow_path || activePath };
  },
  graph_connect: ({ from_node_id, to_node_id }) => ({
    connected: { from: { node_id: from_node_id }, to: { node_id: to_node_id } },
  }),
  graph_disconnect: ({ node_id }) => ({ disconnected: { node_id } }),
  graph_set_widget: (args) => {
    const wf = wfFor(args);
    const n = wf.nodes.get(Number(args.node_id));
    if (!n) throw new Error(`no node ${args.node_id}`);
    const prev = n.widgets[args.widget];
    n.widgets[args.widget] = args.value;
    return { set: { node_id: args.node_id, widget: args.widget, previous: prev, value: args.value } };
  },
  graph_move_node: ({ node_id, pos }) => ({ moved: { node_id, to: pos } }),
  graph_canvas: ({ action }) => ({ canvas: { action } }),
  graph_run: ({ batch_count }) => ({ queued: true, batch_count: batch_count ?? 1 }),
  graph_get_errors: () => ({ last_execution_error: null, node_errors: null, note: "no errors" }),
  workflow_save: () => ({ saved: true, workflow: "mock" }),
  workflow_save_as: ({ name }) => ({ saved_as: `workflows/${name}.json` }),
  // New-workflow opens a NEW TAB — in the mock it must NOT wipe the seeded graph.
  workflow_new: () => ({ created: true, active: "Untitled (new tab)" }),
  workflow_list: () => ({
    active: { path: activePath, filename: activePath.replace(/.*\//, ""), key: "current" },
    open: [...workflows.entries()].map(([path, wf]) => ({
      path,
      filename: wf.title,
      key: path,
      active: path === activePath,
      modified: true,
      persisted: true,
    })),
  }),
  workflow_open: ({ path }) => {
    ensureWorkflow(path);
    activePath = path;
    return { opened: { path, filename: path } };
  },
  workflow_rename: ({ name }) => ({ renamed: { to: `${name}.json` } }),
  workflow_close: ({ path }) => ({ closed: { path } }),
  graph_select_nodes: ({ node_ids }) => { selection = (node_ids || []).map(Number); return { selected: node_ids }; },
  graph_create_subgraph: (args) => {
    const wf = wfFor(args);
    const id = ++seq;
    wf.nodes.set(id, { id, type: "Subgraph", title: "Subgraph", is_subgraph: true, widgets: {}, inputs: [], outputs: [] });
    selection = [id];
    return { subgraph: { node_id: id, name: "Subgraph", from_nodes: args.node_ids } };
  },
  graph_copy_nodes: (args) => {
    const wf = wfFor(args);
    const ids = (Array.isArray(args.node_ids) && args.node_ids.length ? args.node_ids.map(Number) : selection);
    const src = ids.map((id) => wf.nodes.get(Number(id))).filter(Boolean);
    if (!src.length) throw new Error("nothing selected to copy");
    clipboard = src.map((n) => ({ type: n.type, title: n.title, widgets: { ...n.widgets } }));
    return { copied: clipboard.length };
  },
  graph_paste_nodes: (args) => {
    const wf = wfFor(args);
    if (!clipboard.length) throw new Error("clipboard empty");
    const pasted = clipboard.map((c) => addNode(wf, c.type, c.title));
    return { pasted_count: pasted.length, pasted_node_ids: pasted.map((n) => n.id), pasted: pasted.map(summarize) };
  },
  graph_save_subgraph: (args) => {
    const wf = wfFor(args);
    const id = args.node_id != null ? Number(args.node_id) : selection[0];
    const n = id != null ? wf.nodes.get(id) : null;
    if (!n || !n.is_subgraph) throw new Error("select a subgraph node first");
    const finalName = (typeof args.name === "string" && args.name.trim()) ? args.name.trim() : (n.title || "Subgraph");
    blueprints.set(finalName, { name: finalName, type: `SubgraphBlueprint.${finalName}` });
    return { saved: { name: finalName, from_node_id: id, type: `SubgraphBlueprint.${finalName}` } };
  },
  graph_list_subgraphs: () => ({ count: blueprints.size, blueprints: [...blueprints.values()].map((b) => ({ ...b, display_name: b.name, description: null, is_global: false })) }),
  graph_add_subgraph: (args) => {
    const wf = wfFor(args);
    const key = String(args.name).replace(/^SubgraphBlueprint\./, "");
    if (!blueprints.has(key)) throw new Error(`No blueprint "${args.name}"`);
    const id = ++seq;
    wf.nodes.set(id, { id, type: `SubgraphBlueprint.${key}`, title: key, is_subgraph: true, widgets: {}, inputs: [], outputs: [] });
    return { added: summarize(wf.nodes.get(id)), from_blueprint: `SubgraphBlueprint.${key}` };
  },
};

const sock = new WebSocket(url);
let gotReply = false;

sock.on("open", () => {
  console.log(ms(), "connected", url, `(seed=${seed} nodes)`);
  sock.send(JSON.stringify({ type: "hello", tab_id: "mock-panel-0001", title: "mock" }));
  setTimeout(() => {
    console.log(ms(), `-> TASK: ${task}`);
    sock.send(JSON.stringify({ type: "user_message", text: task }));
  }, 1500);
});

sock.on("message", (buf) => {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }

  if (typeof m.rid === "string" && typeof m.cmd === "string") {
    commands.push({ cmd: m.cmd, args: m });
    let reply;
    try {
      const fn = EXEC[m.cmd];
      if (!fn) throw new Error(`unknown cmd ${m.cmd}`);
      reply = { rid: m.rid, ok: true, result: fn(m) };
    } catch (err) {
      reply = { rid: m.rid, ok: false, error: err.message };
    }
    console.log(ms(), `   <cmd ${m.cmd}>`, JSON.stringify(m).slice(0, 90));
    try { sock.send(JSON.stringify(reply)); } catch {}
    return;
  }
  if (m.type === "say") { gotReply = true; says.push(m.text); console.log(ms(), `<< say: ${String(m.text).slice(0, 110)}`); }
  else if (m.type === "models") console.log(ms(), `<< models(${m.models.length})`);
  else if (m.type === "agent_status") console.log(ms(), `<< status ctx=${m.context_pct}`);
  else console.log(ms(), `<< ${m.type}${m.kind ? "/" + m.kind : ""}`);
});

sock.on("error", (e) => console.error(ms(), "ERR", e.message));

setTimeout(() => {
  const counts = {};
  for (const c of commands) counts[c.cmd] = (counts[c.cmd] || 0) + 1;
  console.log("\n===== SUMMARY =====");
  console.log("reply:", gotReply ? "yes" : "NO");
  console.log("commands:", JSON.stringify(counts));
  console.log("graph_clear called:", counts.graph_clear ? `YES x${counts.graph_clear} (DESTRUCTIVE!)` : "no");
  console.log("workflow_new called:", counts.workflow_new ? `yes x${counts.workflow_new} (correct for new workflow)` : "no");
  console.log("final node count (active):", current.nodes.size, `(seeded ${seed})`);
  console.log("workflows:", [...workflows.keys()].join(", "));
  console.log("say count:", says.length);
  sock.close();
  process.exit(0);
}, duration);
