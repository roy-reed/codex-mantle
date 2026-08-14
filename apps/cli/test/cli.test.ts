import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { formatProfilePlanHuman, formatSnapshotInspectHuman, main, parsePort } from "../src/cli.js";

interface CapturedMain {
  exitCode: typeof process.exitCode;
  stderr: string;
  stdout: string;
}

async function captureMain(args: readonly string[]): Promise<CapturedMain> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  try {
    await main(["node", "codex-mantle", ...args]);
    return {
      exitCode: process.exitCode,
      stderr: stderr.join(""),
      stdout: stdout.join(""),
    };
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.exitCode = previousExitCode;
  }
}

describe.sequential("CLI regressions", () => {
  it("rejects snapshot create without --file before creating the state directory", async () => {
    const testRoot = fileURLToPath(new URL(".", import.meta.url));
    const temporaryRoot = await mkdtemp(join(testRoot, ".tmp-cli-"));
    const stateDir = join(temporaryRoot, "must-not-exist");
    try {
      const captured = await captureMain(["--json", "snapshot", "create", "--state-dir", stateDir]);

      expect(captured.exitCode).toBe(1);
      expect(captured.stdout).toBe("");
      expect(JSON.parse(captured.stderr)).toMatchObject({
        error: {
          code: "commander.missingMandatoryOptionValue",
          message: expect.stringContaining("--file"),
        },
      });
      await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps help and version as ordinary stdout exits", async () => {
    const help = await captureMain(["--help"]);
    const version = await captureMain(["--version"]);

    expect(help.stdout).toContain("Usage: codex-mantle");
    expect(help.stderr).toBe("");
    expect(help.exitCode).toBeUndefined();
    expect(version.stdout.trim()).toBe("0.1.0-alpha.1");
    expect(version.stderr).toBe("");
    expect(version.exitCode).toBeUndefined();
  });

  it("emits one JSON error document for strict port parse failures", async () => {
    const captured = await captureMain(["--json", "serve", "--port", "80oops"]);
    const document = JSON.parse(captured.stderr) as {
      error: { code: string; message: string };
    };

    expect(captured.exitCode).toBe(1);
    expect(captured.stdout).toBe("");
    expect(document.error.code).toBe("commander.invalidArgument");
    expect(document.error.message).toContain("decimal integer from 1 to 65535");
    expect(
      captured.stderr
        .trim()
        .split("\n")
        .filter((line) => line.trim() === "{"),
    ).toHaveLength(1);
  });

  it("accepts only decimal ports in the valid TCP range", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65_535);
    for (const invalid of ["0", "65536", "1.5", "0x50", "+80", "80oops"]) {
      expect(() => parsePort(invalid)).toThrow("decimal integer from 1 to 65535");
    }
  });

  it("prints each profile target with complete before and after hashes", () => {
    const beforeHash = "a".repeat(64);
    const afterHash = "b".repeat(64);
    const target = "C:\\workspace\\AGENTS.md";

    expect(
      formatProfilePlanHuman(
        {
          operations: [
            {
              afterHash,
              beforeHash,
              contentBase64: "",
              mode: 0o644,
              path: "AGENTS.md",
              strategy: "managed-block",
              target,
              targetRoot: "workspace",
            },
          ],
        },
        "C:\\state\\plan.json",
        "apply:approval",
      ),
    ).toContain(`- UPDATE\n  target: ${target}\n  before: ${beforeHash}\n  after: ${afterHash}`);
  });

  it("prints each snapshot target with complete current and snapshot hashes", () => {
    const currentHash = "c".repeat(64);
    const snapshotHash = "d".repeat(64);
    const target = "C:\\workspace\\AGENTS.md";

    expect(
      formatSnapshotInspectHuman(
        {
          id: "snapshot-20260815T010203456Z-abcdef123456",
          entries: [
            {
              exists: true,
              mode: 0o644,
              payload: "files/0000.bin",
              sha256: snapshotHash,
              size: 42,
              target,
            },
          ],
        },
        { [target]: currentHash },
        "restore:approval",
        "e".repeat(64),
      ),
    ).toContain(`- target: ${target}\n  current: ${currentHash}\n  snapshot: ${snapshotHash}`);
  });

  it("validates the shipped plugin example through the CLI", async () => {
    const manifest = fileURLToPath(
      new URL("../../../examples/plugins/evidence-first/codex-mantle.plugin.json", import.meta.url),
    );
    const captured = await captureMain(["--json", "plugin", "validate", manifest]);

    expect(captured.exitCode).toBeUndefined();
    expect(captured.stderr).toBe("");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      valid: true,
      manifest: { id: "evidence-first", compatibility: { mantle: "^0.1.0" } },
    });
  });
});
