import { type CodexCapabilityProbe, probeCodex } from "./capabilities.js";
import { type ProcessResult, type ProcessRunner, processSucceeded, runProcess } from "./process.js";

export type DoctorToolName = "node" | "git" | "powershell7" | "gh" | "codex";
export type DoctorStatus = "ok" | "warning" | "error";

export interface DoctorToolResult {
  name: DoctorToolName;
  command: string;
  required: boolean;
  status: DoctorStatus;
  version?: string;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  readOnly: boolean;
  tools: readonly DoctorToolResult[];
  codex: CodexCapabilityProbe;
}

export interface DoctorOptions {
  commands?: Partial<Record<DoctorToolName, string>>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: ProcessRunner;
}

interface ToolDefinition {
  name: Exclude<DoctorToolName, "codex">;
  defaultCommand: string;
  args: readonly string[];
  required: boolean;
  validate?: (version: string) => boolean;
  requirement?: string;
}

function toolDefinitions(platform: NodeJS.Platform): readonly ToolDefinition[] {
  return [
    {
      name: "node",
      defaultCommand: process.execPath,
      args: ["--version"],
      required: true,
      validate: (version) => Number(version.match(/v?(\d+)/u)?.[1]) >= 22,
      requirement: "Node.js 22 or newer is required.",
    },
    { name: "git", defaultCommand: "git", args: ["--version"], required: true },
    {
      name: "powershell7",
      defaultCommand: "pwsh",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.ToString()",
      ],
      required: platform === "win32",
      validate: (version) => Number(version.match(/(\d+)/u)?.[1]) >= 7,
      requirement: "PowerShell 7 or newer is required on Windows.",
    },
    { name: "gh", defaultCommand: "gh", args: ["--version"], required: false },
  ];
}

function firstMeaningfulLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 300);
}

function toolResult(
  definition: ToolDefinition,
  command: string,
  result: ProcessResult,
): DoctorToolResult {
  const version = firstMeaningfulLine(result.stdout) ?? firstMeaningfulLine(result.stderr);
  if (!processSucceeded(result)) {
    return {
      name: definition.name,
      command,
      required: definition.required,
      status: definition.required ? "error" : "warning",
      message: result.timedOut ? "Version check timed out." : "Command is unavailable.",
    };
  }

  if (version === undefined || (definition.validate && !definition.validate(version))) {
    return {
      name: definition.name,
      command,
      required: definition.required,
      status: definition.required ? "error" : "warning",
      ...(version === undefined ? {} : { version }),
      message: definition.requirement ?? "The reported version is unsupported.",
    };
  }

  return {
    name: definition.name,
    command,
    required: definition.required,
    status: "ok",
    version,
    message: "Available.",
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const runner = options.runner ?? runProcess;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const toolChecks = toolDefinitions(options.platform ?? process.platform).map(
    async (definition) => {
      const command = options.commands?.[definition.name] ?? definition.defaultCommand;
      const result = await runner(command, definition.args, { timeoutMs });
      return toolResult(definition, command, result);
    },
  );

  const codexCommand = options.commands?.codex ?? "codex";
  const [toolsWithoutCodex, codex] = await Promise.all([
    Promise.all(toolChecks),
    probeCodex({ codexPath: codexCommand, timeoutMs, runner }),
  ]);
  const codexTool: DoctorToolResult = {
    name: "codex",
    command: codexCommand,
    required: true,
    status: codex.capabilities.command ? (codex.readOnly ? "warning" : "ok") : "error",
    ...(codex.version === null ? {} : { version: codex.version.raw }),
    message: codex.capabilities.command
      ? codex.readOnly
        ? "Available in read-only compatibility mode."
        : "Available and compatible."
      : "Command is unavailable.",
  };
  const tools = [...toolsWithoutCodex, codexTool];

  return {
    ok: tools.every((tool) => !tool.required || tool.status !== "error"),
    readOnly: codex.readOnly,
    tools,
    codex,
  };
}
