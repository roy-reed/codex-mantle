import { type ProcessResult, type ProcessRunner, processSucceeded, runProcess } from "./process.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ParsedCodexVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export interface SupportedCodexSeries {
  major: number;
  minor: number;
}

/** Versions exercised by this release. Unlisted versions stay read-only. */
export const SUPPORTED_CODEX_SERIES: readonly SupportedCodexSeries[] = Object.freeze([
  { major: 0, minor: 147 },
]);

export interface CapabilityCheck {
  available: boolean;
  exitCode: number | null;
  timedOut: boolean;
  detail?: string;
}

export interface CodexCapabilityProbe {
  executable: string;
  version: ParsedCodexVersion | null;
  supportedVersion: boolean;
  capabilities: {
    command: boolean;
    appServer: boolean;
    schemaGeneration: boolean;
  };
  checks: {
    command: CapabilityCheck;
    version: CapabilityCheck;
    appServer: CapabilityCheck;
    schemaGeneration: CapabilityCheck;
  };
  readOnly: boolean;
  reasons: readonly string[];
}

export interface ProbeCodexOptions {
  codexPath?: string;
  timeoutMs?: number;
  runner?: ProcessRunner;
  supportedSeries?: readonly SupportedCodexSeries[];
}

function firstMeaningfulLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 300);
}

function checkFromResult(
  result: ProcessResult,
  expectedMarkers: readonly string[] = [],
): CapabilityCheck {
  const processAvailable = processSucceeded(result);
  const output = `${result.stdout}\n${result.stderr}`;
  const missingMarker = processAvailable
    ? expectedMarkers.find((marker) => !output.includes(marker))
    : undefined;
  const detail =
    result.spawnError ??
    firstMeaningfulLine(result.stderr) ??
    (missingMarker === undefined
      ? undefined
      : `Expected help marker was not found: ${missingMarker}`);
  return {
    available: processAvailable && missingMarker === undefined,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(detail === undefined ? {} : { detail }),
  };
}

export function parseCodexVersion(output: string): ParsedCodexVersion | null {
  const match = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\s|$)/u);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;

  return {
    raw: match[0].trim(),
    major,
    minor,
    patch,
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}

export async function probeCodex(options: ProbeCodexOptions = {}): Promise<CodexCapabilityProbe> {
  const codexPath = options.codexPath ?? "codex";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? runProcess;
  const supportedSeries = options.supportedSeries ?? SUPPORTED_CODEX_SERIES;

  const [commandResult, versionResult, appServerResult, schemaResult] = await Promise.all([
    runner(codexPath, ["--help"], { timeoutMs }),
    runner(codexPath, ["--version"], { timeoutMs }),
    runner(codexPath, ["app-server", "--help"], { timeoutMs }),
    runner(codexPath, ["app-server", "generate-json-schema", "--help"], { timeoutMs }),
  ]);

  const commandCheck = checkFromResult(commandResult, ["Usage: codex", "app-server"]);
  const versionCheck = checkFromResult(versionResult);
  const appServerCheck = checkFromResult(appServerResult, [
    "Usage: codex app-server",
    "generate-json-schema",
  ]);
  const schemaCheck = checkFromResult(schemaResult, [
    "Usage: codex app-server generate-json-schema",
    "--out <DIR>",
  ]);
  const version = versionCheck.available
    ? parseCodexVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
    : null;
  const supportedVersion =
    version !== null &&
    supportedSeries.some(
      (supported) => supported.major === version.major && supported.minor === version.minor,
    );

  const reasons: string[] = [];
  if (!commandCheck.available) reasons.push("Codex command could not be probed.");
  if (!versionCheck.available) reasons.push("Codex version command failed.");
  if (versionCheck.available && version === null) reasons.push("Codex version was not recognized.");
  if (version !== null && !supportedVersion) {
    reasons.push(`Codex ${version.raw} is outside the tested compatibility series.`);
  }
  if (!appServerCheck.available) reasons.push("Codex app-server command is unavailable.");
  if (!schemaCheck.available) reasons.push("Codex app-server schema generation is unavailable.");

  return {
    executable: codexPath,
    version,
    supportedVersion,
    capabilities: {
      command: commandCheck.available,
      appServer: appServerCheck.available,
      schemaGeneration: schemaCheck.available,
    },
    checks: {
      command: commandCheck,
      version: versionCheck,
      appServer: appServerCheck,
      schemaGeneration: schemaCheck,
    },
    readOnly:
      !commandCheck.available ||
      !supportedVersion ||
      !appServerCheck.available ||
      !schemaCheck.available,
    reasons,
  };
}
