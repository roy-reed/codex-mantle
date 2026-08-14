import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export interface RunProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  command: string;
  args: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  spawnError?: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<ProcessResult>;

function assertSafeProcessInput(command: string, args: readonly string[]): void {
  if (command.length === 0 || command.includes("\0")) {
    throw new TypeError("command must be a non-empty string without NUL bytes");
  }

  for (const argument of args) {
    if (argument.includes("\0")) {
      throw new TypeError("process arguments must not contain NUL bytes");
    }
  }
}

function appendChunk(
  chunks: Buffer[],
  chunk: Buffer,
  retainedBytes: number,
  byteLimit: number,
): { retainedBytes: number; truncated: boolean } {
  const remaining = byteLimit - retainedBytes;
  if (remaining <= 0) {
    return { retainedBytes, truncated: true };
  }

  if (chunk.byteLength <= remaining) {
    chunks.push(chunk);
    return { retainedBytes: retainedBytes + chunk.byteLength, truncated: false };
  }

  chunks.push(chunk.subarray(0, remaining));
  return { retainedBytes: byteLimit, truncated: true };
}

/**
 * Executes one program directly. Arguments are always passed as an array and a
 * shell is never started, so shell metacharacters remain ordinary arguments.
 */
export const runProcess: ProcessRunner = async (command, args, options = {}) => {
  assertSafeProcessInput(command, args);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("maxOutputBytes must be a positive safe integer");
  }

  return await new Promise<ProcessResult>((resolve) => {
    const startedAt = performance.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const appended = appendChunk(stdoutChunks, chunk, stdoutBytes, maxOutputBytes);
      stdoutBytes = appended.retainedBytes;
      truncated ||= appended.truncated;
    });

    child.stderr.on("data", (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const appended = appendChunk(stderrChunks, chunk, stderrBytes, maxOutputBytes);
      stderrBytes = appended.retainedBytes;
      truncated ||= appended.truncated;
    });

    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: string,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      const result: ProcessResult = {
        command,
        args: [...args],
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        truncated,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (spawnError !== undefined) result.spawnError = spawnError;
      resolve(result);
    };

    child.once("error", (error) => finish(null, null, error.message));
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
};

export function processSucceeded(result: ProcessResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError === undefined;
}
