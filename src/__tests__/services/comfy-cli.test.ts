import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertComfyCliOk,
  isSupportedComfyCliVersion,
  normalizeComfyCliResult,
  parseComfyCliEnvelope,
  resolveComfyCliExecutable,
  shouldUseComfyCli,
} from "../../services/comfy-cli.js";

const originalCliPath = process.env.COMFY_CLI_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalCliPath === undefined) delete process.env.COMFY_CLI_PATH;
  else process.env.COMFY_CLI_PATH = originalCliPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("comfy-cli adapter", () => {
  it("parses the final envelope after NDJSON events", () => {
    const envelope = parseComfyCliEnvelope<{ jobs: number }>(
      '{"schema":"event/1","type":"progress"}\n' +
        '{"schema":"envelope/1","type":"envelope","ok":true,"command":"jobs ls","version":"1.11.1","where":"local","data":{"jobs":2},"error":null}\n',
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.version).toBe("1.11.1");
    expect(envelope.data).toEqual({ jobs: 2 });
  });

  it("rejects non-envelope JSON", () => {
    expect(() => parseComfyCliEnvelope('{"ok":"yes"}')).toThrow(/envelope\/1/);
  });

  it("surfaces structured CLI errors", () => {
    const envelope = parseComfyCliEnvelope(
      '{"schema":"envelope/1","type":"envelope","ok":false,"command":"validate","version":"1.11.1","where":"local","data":null,"error":{"code":"workflow_invalid_json","message":"bad JSON","hint":"re-export"}}',
    );
    expect(() => assertComfyCliOk(envelope)).toThrow(/workflow_invalid_json: bad JSON \(re-export\)/);
  });

  it("honors COMFY_CLI_PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "comfy-cli-test-"));
    tempDirs.push(dir);
    const executable = join(dir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(executable, "");
    process.env.COMFY_CLI_PATH = executable;
    expect(resolveComfyCliExecutable()).toBe(executable);
  });

  it("normalizes successful legacy plain-text commands", () => {
    const result = normalizeComfyCliResult(
      ["stop"],
      { workspace: "/ws" },
      { stdout: "No ComfyUI is running in the background.\n", stderr: "", exitCode: 0 },
      "1.11.1",
    );
    expect(result).toMatchObject({
      schema: "envelope/1",
      type: "envelope",
      ok: true,
      command: "stop",
      version: "1.11.1",
      data: { stdout: "No ComfyUI is running in the background.", stderr: "" },
    });
  });

  it("normalizes failed legacy commands without losing stderr", () => {
    const result = normalizeComfyCliResult(
      ["model", "remove"],
      {},
      { stdout: "", stderr: "model not found", exitCode: 2 },
      "1.11.1",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "legacy_command_failed", message: "model not found" });
  });

  it("treats stopping an already-stopped background server as idempotent success", () => {
    const result = normalizeComfyCliResult(
      ["stop"],
      {},
      { stdout: "", stderr: "No ComfyUI is running in the background.", exitCode: 1 },
      "1.11.1",
    );
    expect(result).toMatchObject({ ok: true, data: { already_stopped: true } });
  });

  it("requires comfy-cli 1.11.1 or newer for automatic adoption", () => {
    expect(isSupportedComfyCliVersion("1.11.0")).toBe(false);
    expect(isSupportedComfyCliVersion("1.11.1")).toBe(true);
    expect(isSupportedComfyCliVersion("2.0.0")).toBe(true);
    expect(isSupportedComfyCliVersion(null)).toBe(false);
  });

  it("falls back to Manager HTTP unless a supported local CLI is available", () => {
    expect(shouldUseComfyCli(undefined, true, "/bin/comfy", "1.11.1")).toBe(true);
    expect(shouldUseComfyCli(undefined, true, null, null)).toBe(false);
    expect(shouldUseComfyCli(undefined, true, "/bin/comfy", "1.11.0")).toBe(false);
    expect(shouldUseComfyCli(undefined, false, "/bin/comfy", "1.11.1")).toBe(false);
    expect(shouldUseComfyCli(true, false, null, null)).toBe(true);
    expect(shouldUseComfyCli(false, true, "/bin/comfy", "1.11.1")).toBe(false);
  });

  it("rejects Windows command shims that execFile cannot launch directly", () => {
    if (process.platform !== "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "comfy-cli-test-"));
    tempDirs.push(dir);
    const executable = join(dir, "comfy.cmd");
    writeFileSync(executable, "@echo off\n");
    process.env.COMFY_CLI_PATH = executable;
    expect(resolveComfyCliExecutable()).toBeNull();
  });
});
