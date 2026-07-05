---
name: structure-map-concept
description: Cross-provider concept images — generate a structure map with Grok/Google, then refine in Qwen edit or Krea pipelines
globs:
  - "**/*.json"
---

# Structure map → Qwen / Krea pipeline

Use when the user wants a **layout / structure / wireframe concept** from an external image model, then a **high-fidelity ComfyUI pass** (Qwen image edit or Krea txt2img/json).

## When to use

- User asks for a "structure map", "layout concept", "wireframe render", or "blocking pass" before Qwen/Krea.
- User wants Grok Imagine or Google image gen as the **first stage**, ComfyUI as the **second stage**.
- User has a Qwen edit or Krea pack loaded and needs a reference image wired in.

## Pipeline (recommended)

1. **Generate concept** — `fetch_concept_image`
   - `provider: "grok"` — xAI Imagine (`XAI_API_KEY` or Grok CLI `~/.grok/auth.json`)
   - `provider: "google"` — Gemini image / Nano Banana (`GEMINI_API_KEY` or Gemini CLI OAuth)
   - Prompt: describe **layout only** (composition, camera, zones, silhouettes) — not final polish.
   - `upload_to_comfyui: true` (default) so you get `comfy_filename`.

2. **Wire reference** — `apply_reference_to_workflow`
   - Pass the workflow JSON (from `read_pack_workflow`, `panel_get_graph` API export, or `create_workflow`).
   - `image_filename`: value from step 1.
   - `role: "auto"` patches `LoadImage` or Qwen `vl_resize_image1` first.

3. **Refine in ComfyUI**
   - **Qwen image edit** (`qwen-image-edit` skill / pack): set edit prompt on the encoder; run with lightning LoRA if available.
   - **Krea JSON** (`krea2-txt2img-json` pack): use Ideogram-style JSON in `Ideogram4PromptBuilderKJ` for the final render; the concept image is optional style/layout ref if the graph has a LoadImage path.

4. **Queue** — `enqueue_workflow` or `panel_run` after validation.

## Prompt patterns

**Structure map (external gen):**

> Top-down architectural structure map of [subject]. Flat neutral lighting, clear zone boundaries, labeled areas as simple shapes, minimal texture, blueprint-like clarity, no photorealistic materials.

**Qwen edit (ComfyUI):**

> Preserve the layout and camera from the reference. Add [materials/lighting/detail]. Photorealistic finish.

**Krea JSON (ComfyUI):**

Build structured JSON via `Ideogram4PromptBuilderKJ` describing the same scene with full art direction — do not rely on the concept image alone for text in the frame.

## Panel vs headless

- **Panel connected:** `panel_get_graph` → `apply_reference_to_workflow` on exported API JSON → `panel_set_widget` for any remaining widgets → `panel_run`.
- **Headless:** `fetch_concept_image` → `apply_reference_to_workflow` → `validate_workflow` → `enqueue_workflow`.

## Gotchas

- Concept images are **SynthID / watermarked** on Google; treat as intermediate refs.
- Qwen **Advanced** encoder wants the source in `vl_resize_image1` — `apply_reference_to_workflow` handles this when no `LoadImage` is present.
- Krea turbo packs are **txt2img-first**; use the concept as a **visual brief** in the JSON prompt unless the graph includes img2img nodes.
- Always `upload_image` / `fetch_concept_image` before patching — never guess filesystem `input/` paths on remote ComfyUI.