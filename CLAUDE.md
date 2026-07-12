# Development Notes

## Local Testing with npm link

The developer uses `npm link` so that `npx comfyui-mcp` resolves to the local build at `C:\Users\klutt\code\comfyui-mcp\dist\`.

**DO NOT modify `plugin/.mcp.json`** to point to a local path. It must stay as:
```json
{
  "comfyui": {
    "command": "npx",
    "args": ["-y", "comfyui-mcp"]
  }
}
```
This works for both:
- **Public users**: `npx` downloads from npm
- **Developer**: `npm link` makes `npx` resolve to the local build

After code changes: `npm run build` then `/mcp` reconnect in Claude Code.

## Official comfy-cli Integration

`comfyui-mcp` integrates with official `comfy-cli` 1.11.1 or newer. Resolve the executable in this order: `COMFY_CLI_PATH`, the selected ComfyUI workspace's `.venv`/`venv`, then `PATH`.

- Prefer the `comfy_cli_*` MCP tools for CLI-owned behavior: environment/workspace discovery, managed server lifecycle, jobs, loaded-node search, workflow validation/execution, upload/download, model discovery/download/removal, and official agent skills.
- Local custom-node install/update/reinstall/fix operations prefer `comfy node` when a supported CLI is available. Fall back to ComfyUI-Manager HTTP when the CLI is missing or too old. Remote custom-node operations use Manager HTTP because the MCP host cannot manage the remote filesystem.
- Always invoke comfy-cli non-interactively with global `--json --skip-prompt`. Newer commands emit `envelope/1`; legacy `stop`, `node`, and singular `model` commands may still print plain text in v1.11.1, so the adapter normalizes their exit status/stdout/stderr into the same envelope contract.
- Treat `comfy stop` reporting that no background ComfyUI is running as idempotent success, so restart can continue to launch.
- Project-scoped `comfy skills` operations require an explicit project working directory. Do not let them inherit the MCP package directory.
- Do not reintroduce ComfyUI-Manager's removed `cm-cli.py` subprocess path.

See the **Official comfy-cli** section in `README.md` and `COMFY_CLI_PATH` in `.env.example` for the user-facing contract.

## Plugin File Sync

The plugin runs from cached copies, not the source tree. After changing files in `plugin/`:
- Cache: `~/.claude/plugins/cache/comfyui-mcp/comfy/0.1.0/`
- Marketplace: `~/.claude/plugins/marketplaces/comfyui-mcp/plugin/`

Copy changed files to both locations, then restart Claude Code for hooks or `/mcp` for MCP tools.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
