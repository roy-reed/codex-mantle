import { describe, expect, it } from "vitest";
import { parseCodexVersion, probeCodex } from "../src/capabilities.js";
import type { ProcessResult, ProcessRunner } from "../src/process.js";

function result(stdout = "", exitCode: number | null = 0): ProcessResult {
  return {
    command: "codex",
    args: [],
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
  };
}

function fakeCodex(versionOutput: string, schemaWorks = true): ProcessRunner {
  return async (_command, args) => {
    if (args[0] === "--version") return result(versionOutput);
    if (args.includes("generate-json-schema")) {
      return result(
        "Usage: codex app-server generate-json-schema [OPTIONS] --out <DIR>\n-o, --out <DIR>",
        schemaWorks ? 0 : 2,
      );
    }
    if (args[0] === "app-server") {
      return result("Usage: codex app-server [OPTIONS] [COMMAND]\ngenerate-json-schema");
    }
    return result("Codex CLI\nUsage: codex [OPTIONS]\napp-server");
  };
}

describe("Codex capability probing", () => {
  it("parses prerelease Codex versions", () => {
    expect(parseCodexVersion("codex-cli 0.147.0-alpha.1.2")).toEqual({
      raw: "0.147.0-alpha.1.2",
      major: 0,
      minor: 147,
      patch: 0,
      prerelease: "alpha.1.2",
    });
  });

  it("allows mutations only for a fully probed, tested series", async () => {
    const probe = await probeCodex({ runner: fakeCodex("codex-cli 0.147.0-alpha.1.2") });

    expect(probe.supportedVersion).toBe(true);
    expect(probe.readOnly).toBe(false);
    expect(probe.capabilities.schemaGeneration).toBe(true);
  });

  it("keeps unknown versions read-only", async () => {
    const unrecognized = await probeCodex({ runner: fakeCodex("development build") });
    const untested = await probeCodex({ runner: fakeCodex("codex-cli 0.999.0") });

    expect(unrecognized.readOnly).toBe(true);
    expect(unrecognized.version).toBeNull();
    expect(untested.readOnly).toBe(true);
    expect(untested.supportedVersion).toBe(false);
  });

  it("keeps a supported version read-only when schema probing fails", async () => {
    const probe = await probeCodex({
      runner: fakeCodex("codex-cli 0.147.0-alpha.1.2", false),
    });

    expect(probe.readOnly).toBe(true);
    expect(probe.capabilities.schemaGeneration).toBe(false);
  });

  it("does not trust a zero exit code when help output lacks the capability contract", async () => {
    const runner: ProcessRunner = async (_command, args) => {
      if (args[0] === "--version") return result("codex-cli 0.147.0-alpha.1.2");
      return result("generic success");
    };
    const probe = await probeCodex({ runner });

    expect(probe.readOnly).toBe(true);
    expect(probe.capabilities.command).toBe(false);
    expect(probe.checks.command.detail).toContain("Expected help marker");
  });
});
