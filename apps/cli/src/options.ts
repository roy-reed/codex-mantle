import { isAbsolute, resolve } from "node:path";
import { resolveCodexHome } from "@codex-mantle/core";
import { type Command, InvalidArgumentError } from "commander";

// 命令行参数解析与校验
export interface CommonCodexOptions {
  codex?: string;
}

export interface RootOptions {
  codexHome?: string;
  root?: string[];
  workspace?: string;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function absolutePath(value: string, label: string): string {
  const path = resolve(value);
  if (!isAbsolute(path)) {
    throw new Error(`${label} must resolve to an absolute path.`);
  }
  return path;
}

export function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError("port must be a decimal integer from 1 to 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError("port must be a decimal integer from 1 to 65535");
  }
  return port;
}

export function codexOptions(options: CommonCodexOptions): { codexPath?: string } {
  return options.codex === undefined ? {} : { codexPath: options.codex };
}

export function doctorCommands(options: CommonCodexOptions): { codex: string } | undefined {
  return options.codex === undefined ? undefined : { codex: options.codex };
}

export function resolveAllowedRoots(options: RootOptions): string[] {
  const roots = new Set<string>();
  roots.add(absolutePath(options.codexHome ?? resolveCodexHome(), "Codex home"));
  if (options.workspace !== undefined) {
    roots.add(absolutePath(options.workspace, "Workspace root"));
  }
  for (const root of options.root ?? []) {
    roots.add(absolutePath(root, "Allowed root"));
  }
  return [...roots];
}

export function addRootOptions(command: Command): Command {
  return command
    .option("--codex-home <path>", "Codex home root (defaults to CODEX_HOME or ~/.codex)")
    .option("--workspace <path>", "Workspace root containing managed files")
    .option("--root <path>", "Additional allowed snapshot root; repeatable", collect, []);
}
