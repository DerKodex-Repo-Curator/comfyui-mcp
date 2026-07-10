# Previz-to-video — 3D-blocked reference scenes for motion-controlled AI video (vision doc)

**Status:** draft (RFC PR #187) · **Implementation branch:** `spec/previz-to-video`

> Living doc. Casual "run it by a smart friend" framing at the top; concrete
> architecture + phases below. Draft — shaping it before building.

---

## The pitch

Prompting alone can't direct a shot. You can get *a* beautiful video out of Wan
or Seedance, but you can't get **the** shot — this character crosses frame left
while the camera dollies past that prop, beat lands on frame 40. The most
reliable control signal we have today isn't words, it's **a pre-animated 3D
scene**: block the shot in Blender with rigged characters and a keyframed
camera, render a cheap untextured preview, and hand that to a video model as a
motion/camera reference. The model keeps the body movement, timing, camera
motion and pacing — and repaints everything else from reference images. Swap
the reference images, keep the animation: infinite restyles of one shot.

ComfyUI's own demo of exactly this recipe:
[Seedance 2.0 restyling a Blender/Mixamo previz](https://www.youtube.com/watch?v=3r6qzGGNK8s)
— Mixamo characters + a generated bus + keyframed camera, rendered rough, then
"follow the exact same body movement, timing, camera motion and pacing from the
reference video; change the appearance to match the reference images."

The reason this belongs in comfyui-mcp: **every step of that pipeline is
agent-drivable now.** Blender ships an official MCP (5.1+). Meshy 6 partner
nodes live in ComfyUI core for text/image→3D assets. Wan 2.2 Animate runs the
free local path; Seedance 2.0 Reference-to-Video is the paid API path. Our
agent already does story→scenes→frames→clips (the `director` skill). What's
missing is the **cinematography department**: a skill + pack that teaches the
agent to previz a scene in Blender and cash it out through ComfyUI. You'd tell
the panel "two characters argue on a rooftop, camera circles them, then one
walks off a ledge — make it look like a 90s anime" and the agent blocks it,
renders the reference, and restyles it — asking before it spends credits.

The panel's job, first and foremost, is **natural motion between characters
you created inside ComfyUI** (Discord feedback, verbatim intent): ComfyUI is
the character shop, Mixamo auto-rigs what it produces, and Claude — with full
visibility into the Blender scene — directs the performance from the user's
natural language.

## Evidence this works today

- [ComfyUI (official): style-swapping one Blender animation](https://www.youtube.com/watch?v=3r6qzGGNK8s)
  — the core recipe end-to-end: Mixamo + Tripo asset + camera keyframes →
  rough render → Seedance 2.0 R2V with character/environment ref images.
  Confirms: no textures/lighting needed in the previz; camera motion survives.
- [PixelArtistry: Claude took over ComfyUI + Blender](https://www.youtube.com/watch?v=KdYv_TT-ZnQ)
  — Claude driving Blender MCP + a ComfyUI MCP together: batch asset kits
  (image model → img2mesh → import to Blender), retopo/bake cleanup, and
  text-to-animation (Kinetix) retargeted onto rigged characters. Confirms: the
  dual-MCP orchestration pattern holds up for real multi-step 3D work.
- [Stefan 3D AI: official Blender MCP setup](https://www.youtube.com/watch?v=wSY1kHXSap0)
  — the official 5.1 add-on is drag-drop + auto-start, Claude connector is
  one-click; agent-built materials, geometry nodes, baking, LODs all in single
  prompts. Confirms: setup friction is low enough to put in a skill.
- [PixelArtistry: 3D AI news #13](https://www.youtube.com/watch?v=N15zYcv0Snk)
  — the surrounding ecosystem (retopo, splats, markerless mocap) is compounding
  fast; spatial reasoning in current Claude models is measurably better.
- **Community, on Discord**: a member (seanmcmagic) built a fully-local
  **character shop** *with the Agent Panel's help* and shared the workflow —
  SDXL (WAI-Illustrious) hero image → Qwen-Image-Edit 2511 + multiple-angles
  LoRA batch-generating consistent views → **Hunyuan3D v2 multi-view** → GLB.
  Preserved at
  [`previz-assets/master-3d-model-maker.community.json`](./previz-assets/master-3d-model-maker.community.json)
  (Discord CDN links expire). Confirms: the free asset path is real today, and
  people are already using the panel to build this pipeline's front half. The
  same thread asked for **3D-modeling and audio skill files** — H1 answers the
  3D half.

## The pieces on the board

| Piece | What it gives us | Status / cost |
| --- | --- | --- |
| **Blender MCP (official)** | Scene assembly, import, retarget, camera keyframes, viewport render — via `execute_python` + scene-summary tools; add-on + TCP server (localhost:9876, auto-start), Blender 5.1+ | Free; separate MCP server ([projects.blender.org/lab/blender_mcp](https://projects.blender.org/lab/blender_mcp)) |
| **Mixamo** | **Auto-rigging for ComfyUI-authored characters** (upload FBX/GLB → skeleton-bound FBX) + huge free library of humanoid clips | Free w/ Adobe account, **no API** — website hop is manual; curated local FBX library + Blender retarget add-ons |
| **Meshy 6 partner nodes** | text→3D / image→3D / multi-image→3D in ComfyUI core (Templates → 3D); GLB/FBX into `output/` | **Paid** (Comfy credits, ~211/$1) |
| **Local 3D gen** | Trellis 2 / Hunyuan3D / TripoSplat custom nodes as the free asset path; community-proven character-shop graph (SDXL → Qwen-Edit multi-angle → Hunyuan3D v2 MV → GLB, see Evidence) | Free, local GPU |
| **Wan 2.2 Animate** | Reference video + character image → animated character (DWPose-driven); animate & replace modes; native Comfy template | Free, local (14B fp8; width/height multiples of 16) |
| **Seedance 2.0 R2V** | Up to 3 reference videos + 6 reference images, `@Video1`/`@Image1` prompt refs; follows choreography + camera | **Paid** API node (ByteDance partner); later Seedance versions as they land in Comfy |
| **Already in this repo** | `director` skill (story→scenes→clips), packs system, `upload_video`/`stage_output_as_input` I/O, `list_api_nodes`/`generate_with_api_node`, `check_workflow_runtime` ask-before-spend | Shipped |

## Architecture — who talks to whom

**comfyui-mcp does not wrap Blender.** The agent (Claude) holds *two* MCP
connections — comfyui-mcp for generation/canvas, Blender MCP for scene work —
and a skill teaches it the choreography. That keeps us out of the business of
proxying bpy, and it's exactly the pattern proven in the videos.

Handoff points (all already representable):

1. **ComfyUI → Blender**: Meshy/Trellis writes GLB/FBX into ComfyUI `output/`;
   the agent imports it via Blender MCP `execute_python`
   (`bpy.ops.import_scene.gltf`) — **directly from the output folder**, the
   same file awareness the panel already has on the drive
   (`list_output_images`, workspace paths). No copy step, no asking the user
   where the file went.
2. **ComfyUI → Mixamo (auto-rig)**: a ComfyUI-authored character mesh from
   `output/` goes to mixamo.com for auto-rigging (or a Mixamo-family Blender
   add-on) and comes back as a skeleton-bound FBX. See the character loop below.
3. **Mixamo → Blender**: user-curated local FBX clip library (see below);
   import + retarget onto the character rig via add-on or bpy.
4. **Blender → ComfyUI**: viewport/OpenGL render (solid shading, no lights, no
   materials — it's a motion reference) to mp4 or frame sequence →
   `upload_video` → reference input of the Wan Animate graph or Seedance node.
5. **Reference stills**: character/environment look-images from any local
   image pack (Z-Image, Krea2, …) or provided by the user.

**The character loop (Discord feedback)**: characters are **authored in
ComfyUI first** — image model → img2mesh → FBX/GLB in `output/` — then
**auto-rigged through Mixamo**, and only then animated and directed in
Blender. The agent fully automates the Blender side; the Mixamo *website* hop
is the one manual step (no API), so the skill runs it as a guided handoff:
stage the exact file, tell the user precisely what to upload and click, then
pick the rigged FBX back up from the download folder and continue without
being re-prompted. Direction stays verifiable: the agent inspects the scene
graph and screenshots the viewport, so it *sees* every scene it's directing —
the same trust model as the canvas, where it reads the graph it mutates.

**Mixamo reality check**: there is no official API and scraping is a ToS
minefield, so the skill treats Mixamo's clip library as a **one-time shopping
trip** — a documented starter list (idle/walk/run/turn/sit/fight/dance/death…)
the user downloads once into a conventional folder (e.g.
`~/.comfyui-mcp/previz/clips/`), which the agent then reuses forever.
Auto-rigging is per-character but follows the same stage → guide → pick-up
pattern. Text-to-animation add-ons (Kinetix-style) and markerless mocap slot
into the same folder convention later.

**Orchestrator gap (the one real feature ask)**: the panel agent currently
speaks only to comfyui-mcp. Claude Desktop / Claude Code users can add the
Blender MCP alongside today, but the *panel* needs **companion MCP server
support** — a config that passes extra MCP servers into the spawned agent
session. That's the only code change in this roadmap that isn't a skill, pack,
or doc.

## Deliverables

- **`previz-director` skill** (`plugin/skills/previz-director/SKILL.md`) — the
  whole recipe as knowledge: Blender MCP setup + port sanity check; scene
  blocking conventions (real-world scale, 30 fps, camera rig patterns:
  dolly/orbit/crane as reusable bpy snippets); Mixamo library convention +
  retarget procedure; viewport render settings (workbench solid, flat lighting,
  silhouette-readable for DWPose); the handoff commands; prompt templates for
  Seedance R2V ("follow the exact same body movement, timing, camera motion
  and pacing from @Video1 …") and Wan Animate mode selection (animate vs
  replace); style-sweep pattern (one previz, N reference-image sets).
- **`wan-animate` pack** (`packs/wan-animate/`) — the free path, installable:
  Wan 2.2 Animate 14B fp8 + controlnet_aux (DWPose) + SAM2 nodes, template
  workflow wired for reference-video input. Follows the existing manifest
  conventions; `pack.yaml` links the skill.
- **`character-shop` pack (community seed)** — productize the shared
  Master 3D Model Maker graph (SDXL hero → Qwen-Edit 2511 multi-angle LoRA →
  Hunyuan3D v2 MV → GLB) as the free character-authoring pack, with credit to
  its author. It's the ComfyUI half of the character loop, already
  panel-built.
- **Meshy + Seedance guidance** — no pack needed (they're core API nodes);
  the skill documents the built-in templates and wraps both in the
  `check_workflow_runtime` / ask-before-spending convention. Free alternates
  (Trellis/Hunyuan3D for assets, Wan Animate for video) are always named
  first.
- **3D-asset file awareness** — extend the existing output-folder awareness
  (`list_output_images` already tags `kind: "video"`) to **3D assets**
  (`kind: "model"` for GLB/FBX/OBJ in `output/`), so "import the character I
  just generated into Blender" and "stage this mesh for Mixamo auto-rigging"
  resolve to exact paths without the user hunting for files. Small, and it's
  the glue the whole character loop stands on.
- **Companion MCP servers for the panel orchestrator** — config +
  session-spawn plumbing so the panel agent can reach Blender MCP. Specced
  separately when we get there (it's generic, not Blender-specific).
- **`director` integration** — a previz mode for the existing story pipeline:
  scene list → one Blender previz per shot → batch restyle. Character
  consistency comes free (same 3D characters every shot); the director skill's
  hero-frame/ref-image machinery supplies the style side.

## Phases

| Phase | Goal | Contents |
| --- | --- | --- |
| **H0 — spike (manual)** | Prove the recipe on this rig, end-to-end, once | Meshy (or Trellis) asset → Mixamo character + clip → Blender blocking + camera → viewport render → Wan Animate local AND Seedance R2V; write down every snag |
| **H1 — skill** | `previz-director` SKILL.md from H0's notes | Knowledge only, zero code; usable immediately from Claude Desktop/Code with both MCPs configured |
| **H2 — pack + glue** | `wan-animate` pack; 3D-asset file awareness | Free path installable via `apply_manifest`; `kind: "model"` in output listing; H1 skill references both |
| **H3 — panel parity** | Companion MCP servers in the orchestrator | Panel agent gets Blender MCP; pairing-level UX ("Connect Blender" hint in panel) |
| **H4 — storytelling** | Director × previz | Shot lists drive previz scenes; multi-shot continuity (same cast/set across shots); style sweeps as a first-class op |

H0/H1 ship value with **no code at all** — that's the point of leading with a
skill. H2 is manifest-writing. Only H3 touches the orchestrator.

## Costs & safety

Two of the pieces are paid (Meshy, Seedance — Comfy credits billed to the
user's Comfy account). Existing convention applies unchanged: the agent calls
`check_workflow_runtime`, treats `api`/`mixed` as possibly-paid, and **asks
before spending credits — never silently**. Every paid step has a named free
alternative (local img2mesh; Wan Animate), and the skill presents the free
path as the default. Blender MCP is local and free; its `execute_python` is
arbitrary code execution *inside the user's Blender* — the skill should say so
plainly and keep generated bpy scripts inspectable in chat, same spirit as our
graph mutations being undoable.

## Where I actually want a gut-check

- **How early does the panel need Blender?** Discord feedback says the *side
  panel* controlling motion is the headline feature — which pulls H3
  (companion MCP servers) forward. Counter-pressure: H0–H2 already work from
  Claude Desktop/Code and prove the recipe before we touch the orchestrator.
  Current lean: keep H3 third, but spec it in parallel with H1 so panel parity
  lands fast once the skill is validated.
- **Bundle a tiny CC0 previz kit?** A mannequin character + 3–5 CC0 motion
  clips shipped in the pack would make H0-style demos work without the Mixamo
  shopping trip (and without leaning on Adobe's ToS). Leaning yes.
- **Headless Blender?** The official MCP can execute in a background Blender
  process — a render-farm-ish mode for batch shots. Interactive-first feels
  right (the user watches the blocking happen, same as the canvas), headless
  later.
- **DWPose readability as a skill rule** — Wan Animate needs human silhouettes
  it can pose-track; stylized/non-humanoid previz should route to Seedance
  (which follows raw motion, not skeletons). Is that split stable enough to
  encode as guidance?
- **Where does the clip library live** — `~/.comfyui-mcp/previz/` vs the
  ComfyUI workspace vs a pack `templates/` dir. Orchestrator config already
  has a home dir; leaning `~/.comfyui-mcp/previz/`.
- **Seedance "5.0"** — versions beyond 2.0 will land as new partner nodes;
  the skill should name capabilities ("reference-to-video with @Video refs"),
  not pin node class names, so it survives version bumps.
