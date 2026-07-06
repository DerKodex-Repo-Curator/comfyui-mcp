# Third-Party Notices

## ComfyUI LoRA Manager

- **Project:** [willmiao/ComfyUI-Lora-Manager](https://github.com/willmiao/ComfyUI-Lora-Manager)
- **License:** See upstream repository
- **Use in comfyui-mcp:** Reads `.metadata.json` sidecar files (documented schema) to import Civitai trigger words, usage tips, and previews into the comfyui-mcp LoRA catalog. Does not bundle or fork LoRA Manager; interoperates when the user has it installed in ComfyUI `custom_nodes`.

## PhotoMapAI

- **Project:** [lstein/PhotoMapAI](https://github.com/lstein/PhotoMapAI)
- **License:** MIT
- **Use in comfyui-mcp:** HTTP client for album search, indexing, Monte Carlo FPS/kmeans curation (`/curate`, `/curate_sync`, `/export`), and vault training-pack export. We call a running PhotoMapAI server rather than vendoring its Python runtime.