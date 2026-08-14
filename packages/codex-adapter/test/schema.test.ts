import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "../src/process.js";
import { generateAppServerSchema } from "../src/schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function successResult(args: readonly string[]): ProcessResult {
  return {
    command: "codex",
    args,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
  };
}

describe("generateAppServerSchema", () => {
  it("uses the explicit empty output directory and argument-array execution", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mantle-schema-"));
    temporaryDirectories.push(outputDir);
    let observedArgs: readonly string[] = [];
    const runner: ProcessRunner = async (_command, args) => {
      observedArgs = args;
      await writeFile(join(outputDir, "schema.json"), "{}", "utf8");
      return successResult(args);
    };

    const generated = await generateAppServerSchema({
      outputDir,
      includeExperimental: true,
      runner,
    });

    expect(generated.ok).toBe(true);
    expect(observedArgs).toEqual([
      "app-server",
      "generate-json-schema",
      "--out",
      outputDir,
      "--experimental",
    ]);
    if (generated.ok) expect(generated.generatedFiles).toEqual([join(outputDir, "schema.json")]);
  });

  it("rejects relative and non-empty output directories before execution", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mantle-schema-"));
    temporaryDirectories.push(outputDir);
    await writeFile(join(outputDir, "keep.txt"), "keep", "utf8");
    let calls = 0;
    const runner: ProcessRunner = async (_command, args) => {
      calls += 1;
      return successResult(args);
    };

    const relative = await generateAppServerSchema({ outputDir: "relative", runner });
    const nonEmpty = await generateAppServerSchema({ outputDir, runner });

    expect(relative).toMatchObject({ ok: false, code: "invalid-output-directory" });
    expect(nonEmpty).toMatchObject({ ok: false, code: "output-directory-not-empty" });
    expect(calls).toBe(0);
  });

  it("returns a structured failure without exposing process output", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mantle-schema-"));
    temporaryDirectories.push(outputDir);
    const runner: ProcessRunner = async (_command, args) => ({
      ...successResult(args),
      exitCode: 2,
      stderr: "secret-looking diagnostic that must not be returned",
    });

    const generated = await generateAppServerSchema({ outputDir, runner });

    expect(generated).toMatchObject({ ok: false, code: "command-failed", exitCode: 2 });
    expect(JSON.stringify(generated)).not.toContain("secret-looking");
  });
});
