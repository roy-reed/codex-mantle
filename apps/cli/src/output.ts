import type { MutationPlan, SnapshotManifest } from "@codex-mantle/core";
import type { Command } from "commander";
import open from "open";

// 输出与格式化：JSON / 人类可读输出、错误信息、仪表盘打开
export type DashboardOpener = (target: string) => Promise<unknown>;

export interface GlobalOptions {
  json?: boolean;
}

export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

export function print(command: Command, value: unknown, human: () => void): void {
  if (globalOptions(command).json === true) {
    process.stdout.write(jsonDocument(value));
    return;
  }
  human();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}

export function displayedHash(hash: string | null): string {
  return hash ?? "(missing)";
}

export async function openDashboardIfRequested(
  requested: boolean,
  origin: string,
  opener: DashboardOpener = open,
): Promise<void> {
  if (!requested) return;
  await opener(origin).catch(() => undefined);
}

export function formatProfilePlanHuman(
  plan: Pick<MutationPlan, "operations">,
  output: string,
  approvalId: string,
): string {
  const lines = [
    `Plan: ${output}`,
    `Changes: ${plan.operations.length}`,
    `Approval: ${approvalId}`,
  ];
  for (const operation of plan.operations) {
    lines.push(`- ${operation.beforeHash === null ? "CREATE" : "UPDATE"}`);
    lines.push(`  target: ${operation.target}`);
    lines.push(`  before: ${displayedHash(operation.beforeHash)}`);
    lines.push(`  after: ${operation.afterHash}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatSnapshotInspectHuman(
  manifest: Pick<SnapshotManifest, "entries" | "id">,
  hashes: Readonly<Record<string, string | null>>,
  approvalId: string,
  hashesDigest: string,
): string {
  const lines = [
    `Snapshot: ${manifest.id}`,
    `Approval: ${approvalId}`,
    `Current hashes: ${hashesDigest}`,
  ];
  for (const entry of manifest.entries) {
    lines.push(`- target: ${entry.target}`);
    lines.push(`  current: ${displayedHash(hashes[entry.target] ?? null)}`);
    lines.push(`  snapshot: ${displayedHash(entry.sha256)}`);
  }
  return `${lines.join("\n")}\n`;
}
