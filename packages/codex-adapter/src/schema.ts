import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type ProcessRunner, processSucceeded, runProcess } from "./process.js";

export type SchemaGenerationErrorCode =
  | "invalid-output-directory"
  | "unsafe-output-directory"
  | "output-directory-not-empty"
  | "process-error"
  | "timeout"
  | "command-failed";

export type SchemaGenerationResult =
  | {
      ok: true;
      outputDir: string;
      generatedFiles: readonly string[];
    }
  | {
      ok: false;
      outputDir: string;
      code: SchemaGenerationErrorCode;
      message: string;
      exitCode?: number | null;
    };

export interface GenerateSchemaOptions {
  /** Must be an explicit, existing, empty absolute directory. */
  outputDir: string;
  codexPath?: string;
  includeExperimental?: boolean;
  timeoutMs?: number;
  runner?: ProcessRunner;
}

async function inspectOutputDirectory(outputDir: string): Promise<SchemaGenerationResult | null> {
  if (outputDir.length === 0 || !isAbsolute(outputDir)) {
    return {
      ok: false,
      outputDir,
      code: "invalid-output-directory",
      message: "outputDir must be an explicit absolute path.",
    };
  }

  try {
    const stats = await lstat(outputDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return {
        ok: false,
        outputDir,
        code: "unsafe-output-directory",
        message: "outputDir must be a real directory, not a file or symbolic link.",
      };
    }
    const entries = await readdir(outputDir);
    if (entries.length > 0) {
      return {
        ok: false,
        outputDir,
        code: "output-directory-not-empty",
        message: "outputDir must be empty to prevent accidental overwrite.",
      };
    }
  } catch {
    return {
      ok: false,
      outputDir,
      code: "invalid-output-directory",
      message: "outputDir must already exist and be accessible.",
    };
  }

  return null;
}

export async function generateAppServerSchema(
  options: GenerateSchemaOptions,
): Promise<SchemaGenerationResult> {
  const outputDir = resolve(options.outputDir);
  const directoryError = await inspectOutputDirectory(options.outputDir);
  if (directoryError) return directoryError;

  const args = ["app-server", "generate-json-schema", "--out", outputDir];
  if (options.includeExperimental === true) args.push("--experimental");

  const runner = options.runner ?? runProcess;
  const result = await runner(options.codexPath ?? "codex", args, {
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  if (!processSucceeded(result)) {
    const code: SchemaGenerationErrorCode = result.timedOut
      ? "timeout"
      : result.spawnError !== undefined
        ? "process-error"
        : "command-failed";
    const failure: SchemaGenerationResult = {
      ok: false,
      outputDir,
      code,
      message:
        code === "timeout"
          ? "Codex schema generation timed out."
          : code === "process-error"
            ? "Codex could not be started."
            : "Codex schema generation returned a non-zero exit code.",
    };
    if (result.exitCode !== undefined) failure.exitCode = result.exitCode;
    return failure;
  }

  const generatedFiles = (await readdir(outputDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();

  return { ok: true, outputDir, generatedFiles };
}
