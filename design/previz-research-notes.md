# Previz-to-video — field research notes (round 2)

**Companion to:** [`previz-to-video.md`](./previz-to-video.md) (RFC PR #187) ·
**Researched:** 2026-07-09, web-sourced, citations inline. UNVERIFIED items flagged.

How creators actually run "block in 3D → render motion reference → AI restyle"
pipelines today, plus operational facts for the two model legs and the official
Blender MCP. This is the evidence base for the H1 skill's concrete numbers.

---

## 1. Named prior art (processes worth stealing from)

### Doug Hogan — "Seedance Playblast2Render" (closest analog to our Seedance leg)
[comfy.org workflow](https://comfy.org/workflows/ef543bd4a773-ef543bd4a773/) ·
[YouTube](https://www.youtube.com/watch?v=5DfpOf6VPR4)

Raw CG **playblast** (blockout, no materials) → final shot. Five groups:
`VHS_LoadVideo` + `VHS_VideoInfo` **extract fps/duration from the playblast
itself** and compute output frame counts (sidesteps fps mismatch entirely) →
optional hero-frame picks for style exploration → **Nano Banana Pro generates
multi-angle reference boards** from those hero frames → a Gemini node builds a
"shot-aware prompt" → `ByteDance2ReferenceNode` gets playblast + reference
board to "lock in motion, silhouette, and camera." Troubleshooting: raise
reference influence for style, **simplify the prompt when drift appears, fix
seeds for repeatable iteration**.

### Mickmumpitz — AI Renderer 2.0 + 3D Movie Pipeline (the control-pass school)
[Guide](https://mickmumpitz.ai/guides/ai-powered-3d-animation-rendering) ·
[RunComfy mirror](https://www.runcomfy.com/comfyui-workflows/blender-to-comfyui-ai-renderer-2-0-workflow-cinematic-video-output) ·
[3D Movie Pipeline post](https://mickmumpitz.ai/posts/new-video-free-161509029?synced=1)

Fully local (Wan 2.1 VACE + SkyReels merge; newer pipeline FLUX.2 + LTX-2.3).
Renders **explicit control passes** from Blender rather than one clay video:
- **Layout/outline**: Workbench engine, MatCap shading, Cavity + Outlines on
  (feeds Canny-style control). Older recipe: Freestyle white-line pass.
- **Depth**: Z pass → compositor Invert + Map Range (near=white, normalized).
  Native Blender depth beats monocular estimation of the render.
- **Color-ID masks**: flat emission shader per object, record hex codes →
  regional prompting per object/character (the standard multi-character answer).
- **Mouth mask** (dialogue): white = locked to 3D, black = AI freedom; + a
  dialogue MP3 → LTX lip sync.
Rules: **fps + aspect identical between Blender and workflow**; resolution
divisible by 64 (LTX); ≤3 reference frames (LTX); character held by a
"consistency LoRA" at ~0.7; Wan VACE window **121 frames, 4n+1 rule**, iterative
batch-splitting beyond that. Multiple style refs override the start frame.

### Evolink / community — "Awesome Blender + Seedance Workflow Usecases" (28 cases)
[github.com/Evolink-AI/…](https://github.com/Evolink-AI/Awesome-Blender-Seedance-Workflow-Usecases)
(mirror: cheercheung/…)

The canonical loop, several cases **agent-built via Blender MCP** ("Codex/Claude
builds the blockout in 2–3 minutes, exports MP4"). Renders are **gray-box /
clay viewport previews, no materials** — "purely motion/camera guidance."
Layered control: the reference *video* carries camera + character positioning;
still *images* carry environment/style. Three camera patterns: Blender-only
camera; hybrid (Blender camera + external start frame); position-only
(reference controls placement, prompt recovers dynamism). Recorded failures:
**foot sliding** (fix with prompt reinforcement, not stricter imitation), cloth
physics, **character proportions must match beyond height**, multi-cut
reference videos get "averaged."

### Corridor Digital — "Anime Rock, Paper, Scissors" (the archetype, 2023)
[Kotaku coverage](https://kotaku.com/anime-rock-paper-scissors-corridor-digital-ai-animation-1850186624)

Live-action → Dreambooth-trained SD (style-locked on the target film) →
per-frame img2img → deflicker. Lessons that still hold: strongest character
consistency comes from **training on the target style/character** (today: a
LoRA), and **backgrounds stay 3D and get restyled separately** from performers.

### Adjacent
- **Pallaidium** ([tin2tin/Pallaidium](https://github.com/tin2tin/Pallaidium)) —
  gen-AI studio inside Blender's VSE; already wraps Seedance 2.0 R2V (≤9 image
  refs) — the whole loop without leaving Blender.
- **Banodoco / Steerable Motion** ([repo](https://github.com/banodoco/Steerable-Motion)) —
  keyframe-batch alternative: render N hero stills from the previz and travel
  between them (Wan VACE anchors).

## 2. Seedance 2.0 in ComfyUI — operational facts

- Nodes in ComfyUI core (`comfy_api_nodes/nodes_bytedance.py`, category
  `partner/video/ByteDance`): `ByteDance2TextToVideoNode`,
  **`ByteDance2ReferenceNode`** (R2V), `ByteDance2FirstLastFrameNode`, plus
  Create Image/Video Asset (one-time liveness check for real-person portraits;
  AI faces skip it). Templates: `api_seedance2_0_{t2v,r2v,flf2v}`,
  `api_seedance2_0_mini_{t2v,r2v}`.
  [docs.comfy.org](https://docs.comfy.org/tutorials/partner-nodes/bytedance/seedance-2-0)
- **Reference limits**: ≤9 images, ≤3 videos (each ≥1.8s, total ≤15.1s,
  480p–1080p, 24–60 fps, ≤50MB), ≤3 audio. Output: **4–15s discrete**
  (default 7), 480p→4K (Fast/Mini: ≤720p), seed + watermark + audio toggles.
- **Prompt syntax**: `@Image1…@Video1…@Audio1` with explicit roles — "Keep the
  motion of @Video1, replace subject with @Image1", "Follow the camera path
  from @Video1", "apply the slow right-to-left dolly from @video1 starting at
  the 3-second mark". Omitting roles causes morphing. Motion = video refs;
  aesthetics = text.
- **Cost** ([pricing](https://docs.comfy.org/tutorials/partner-nodes/pricing),
  211 credits = $1, tokens = dur × w × h × fps ÷ 1024): with a video ref a 5s
  720p R2V ≈ **$0.66** (Mini ≈ $0.32); video-ref generations bill at a *lower*
  per-token rate than pure T2V. Content-policy rejections still consume credits.
- **Community sweet spot: 6–8s per shot**; 12s+ brings drift/color shift —
  "3 shots and stitch." Greybox reference videos are a proven input; known
  weak spots: foot contact, cloth, stiffness under pure imitation (reinforce
  with prompt language).
- **Versions**: Seedance 2.0 / 2.0 Fast / 2.0 Mini are what exist in ComfyUI
  today. **"Seedance 5.0" does not exist** — that's **Seedream 5.0**, the
  *image* model. Latest video model is **Seedance 2.5** (native 30s single
  segment, up to 50 refs, region-local editing) with **no ComfyUI partner
  nodes yet** as of 2026-07-09.

## 3. Wan 2.2 Animate — operational facts

- Native template `video_wan2_2_14B_animate` (core node `WanAnimateToVideo`) or
  **Kijai WanVideoWrapper** for the power path (block swap, context windows,
  fp8 scaled). [docs.comfy.org](https://docs.comfy.org/tutorials/video/wan/wan2-2-animate)
- **16 fps native, 77-frame windows (~4.8s)**; extend by chaining 77-frame
  segments (native) or `WanVideoContextOptions` sliding windows (wrapper —
  "doesn't degrade over time," VRAM-capped regardless of length). Resolution
  multiples of 16.
- Quant tiers: fp8 scaled ~19GB (24GB cards standard fit); GGUF Q4_K_M 11.5GB →
  Q8 18.7GB for 16GB cards; optional lightx2v 4-step LoRA; relight LoRA for
  replacement-mode lighting harmonization.
- Chain: **DWPose Estimator** extracts pose+face from the driving video (feed
  normal RGB — no pre-baked skeleton needed); Points Editor + **SAM2** mask for
  **mix/replace** mode; **move/animate** mode (our previz case) = disconnect
  `background_video`/`character_mask`.
- **Driving-video requirement**: DWPose needs a **readable humanoid** —
  silhouette, face, hands. A greybox humanoid rig should track (UNVERIFIED for
  literal flat-grey mannequins — H0 must test this); non-humanoid or extreme
  proportions won't. Community guidance: **calm camera, fixed lens** when
  identity matters — aggressive moves mutate faces.

**Routing rule this implies (confirmed by both research threads):** camera
language and staging live in the **Seedance** reference video; **Wan Animate**
is the character-performance transfer with a stable camera. The RFC's gut-check
on this split is resolved — encode it as skill guidance.

## 4. Mixamo mechanics

- **Auto-rig upload**: FBX (embed media for textures) / OBJ / ZIP, **≤300MB**;
  T-pose or A-pose, clean humanoid, no extra scene objects (cameras/empties
  break the rigger), no wings/tails/props, no existing rig. Marker placement
  (chin/wrists/elbows/knees/groin) → server-side skeleton + weights.
  [Adobe help](https://helpx.adobe.com/creative-cloud/help/mixamo-rigging-animation.html)
- **Download for Blender**: FBX Binary, 30 or 60 fps, **no keyframe
  reduction**; first clip *With Skin*, subsequent clips *Without Skin*.
  **"In Place"** strips forward translation — usually wanted, so the Blender
  scene owns world-space travel and the reference video stays readable.
- **Retargeting (2026 state)**: free **"Retarget" extension** on
  extensions.blender.org (Blender 5+, Mixamo preset) is the default;
  **Auto-Rig Pro** (paid, Remap + Mixamo preset, hips-as-root so translation
  retargets) is the quality pick; Rokoko plugin free but lags releases.
  Mixamo skeletons root at the **hips** — the free "Import Mixamo - Root
  Motion" extension bakes hip translation to a generated root bone when engines
  need it.

## 5. Official Blender MCP — what the agent actually gets

> Distinguish **official** (`projects.blender.org/lab/blender_mcp`, Gitea) from
> the community `ahujasid/blender-mcp` (PyPI) several tutorials use. The
> official one: Blender add-on (TCP, auto-start) + stdio MCP server; tools
> auto-discovered from `mcp/blmcp/tools/`; ships `prompts.yml` + bpy API docs +
> manual excerpts as context. (Lab pages 403 automated fetchers; tool
> identifiers below are from official descriptions, not confirmed verbatim.)

- Tools: execute Python **in the connected instance** or **in a background
  headless Blender** (sandbox that can't wreck the open file); blend-file
  summary; bpy API docs lookup; **screenshot of an area/window**; render to
  path with current settings.
- **Fast previz render recipe** (via execute_python, for the H1 skill):
  `bpy.ops.render.opengl(animation=True, view_context=True)` captures the
  viewport shading — orders of magnitude faster than EEVEE/Cycles. Headless:
  `view_context=False` + `scene.render.engine = 'BLENDER_WORKBENCH'`. Knobs:
  `scene.display.shading.light = 'MATCAP'|'STUDIO'|'FLAT'`,
  `.color_type = 'SINGLE'|'RANDOM'|'MATERIAL'`, `.show_object_outline`.
  Direct-to-mp4: `file_format='FFMPEG'`, `ffmpeg.format='MPEG4'`,
  `ffmpeg.codec='H264'`, set `fps`/`frame_start`/`frame_end`/`filepath`.

## 6. Numeric anchors for the H1 skill (cheat sheet)

| Thing | Number |
| --- | --- |
| Seedance refs | ≤9 images, ≤3 videos (≤15.1s total), ≤3 audio |
| Seedance output | 4–15s discrete; aim **6–8s/shot**; 1080p@24 typical |
| Seedance R2V cost | ~$0.66 / 5s @ 720p (Mini ~$0.32); rejections still bill |
| Wan Animate | 16 fps, 77-frame (~4.8s) windows, chained; res %16 |
| Wan VRAM | fp8 ~19GB (24GB cards); GGUF Q4_K_M 11.5GB (16GB cards) |
| Wan VACE (control-pass leg) | 121-frame window, 4n+1 rule |
| Blender render | fps/aspect must equal workflow; Hogan pattern: read fps from the playblast |
| Mixamo upload | ≤300MB FBX/OBJ/ZIP, T/A-pose, no extra objects |
| Mixamo download | FBX Binary 30/60fps, no keyframe reduction, In Place for locomotion |
