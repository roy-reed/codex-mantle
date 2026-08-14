#!/usr/bin/env node

import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  generateAppServerSchema,
  probeCodex,
  runDoctor,
  type CodexCapabilityProbe,
} from "@codex-mantle/codex-adapter";
import {
  applyPlan,
  buildProfilePlan,
  getPlanApprovalId,
  getRestoreApprovalId,
  loadProfilePack,
  type MutationPlan,
  MutationPlanSchema,
  PRODUCT_VERSION,
  resolveCodexHome,
  resolveStateDir,
  sha256,
  type SnapshotManifest,
  SnapshotStore,
} from "@codex-mantle/core";
import { parsePluginManifestJson } from "@codex-mantle/plugin-sdk";
import {
  startMantleServer,
  type SnapshotProviderValue,
  type StatusProviderValue,
} from "@codex-mantle/server";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import open from "open";

interface GlobalOptions {
  json?: boolean;
}

interface CommonCodexOptions {
  codex?: string;
}

interface RootOptions {
  codexHome?: string;
  root?: string[];
  workspace?: string;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function absolutePath(value: string, label: string): string {
  const path = resolve(value);
  if (!isAbsolute(path)) {
    throw new Error(`${label} must resolve to an absolute path.`);
  }
  return path;
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function print(command: Command, value: unknown, human: () => void): void {
  if (globalOptions(command).json === true) {
    process.stdout.write(jsonDocument(value));
    return;
  }
  human();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}

function displayedHash(hash: string | null): string {
  return hash ?? "(missing)";
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

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonDocument(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function codexOptions(options: CommonCodexOptions): { codexPath?: string } {
  return options.codex === undefined ? {} : { codexPath: options.codex };
}

function doctorCommands(options: CommonCodexOptions): { codex: string } | undefined {
  return options.codex === undefined ? undefined : { codex: options.codex };
}

function probeToStatus(probe: CodexCapabilityProbe): StatusProviderValue {
  const compatibility = probe.readOnly
    ? {
        state: probe.version === null ? ("unknown" as const) : ("limited" as const),
        summary: probe.reasons.join(" ") || "Codex is available in read-only mode.",
      }
    : {
        state: "compatible" as const,
        summary: `Codex ${probe.version?.raw ?? "unknown"} is in the tested compatibility series.`,
      };

  return {
    ...(probe.version === null ? {} : { codexVersion: probe.version.raw }),
    compatibility,
    capabilities: [
      {
        id: "codex-command",
        label: "Codex command",
        state: probe.capabilities.command ? "available" : "unavailable",
      },
      {
        id: "app-server",
        label: "Codex app-server",
        state: probe.capabilities.appServer ? "available" : "unavailable",
      },
      {
        id: "schema-generation",
        label: "App-server schema generation",
        state: probe.capabilities.schemaGeneration ? "available" : "unavailable",
      },
      {
        id: "configuration-mutations",
        label: "Guarded configuration mutations",
        state: probe.readOnly ? "degraded" : "available",
        detail: probe.readOnly
          ? "Disabled until this Codex series is validated."
          : "Plan, snapshot, apply and verify are enabled.",
      },
    ],
    warnings: [...probe.reasons],
  };
}

function resolveAllowedRoots(options: RootOptions): string[] {
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

async function currentHashes(
  entries: readonly { target: string }[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const entry of entries) {
    try {
      const metadata = await lstat(entry.target);
      if (!metadata.isFile()) {
        throw new Error(`Restore target is not a regular file: ${entry.target}`);
      }
      result[entry.target] = sha256(await readFile(entry.target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        result[entry.target] = null;
        continue;
      }
      throw error;
    }
  }
  return result;
}

function currentHashesDigest(hashes: Readonly<Record<string, string | null>>): string {
  const ordered = Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
  );
  return sha256(JSON.stringify(ordered));
}

async function existingWebRoot(explicit: string | undefined): Promise<string | undefined> {
  const candidate = explicit ?? process.env.CODEX_MANTLE_WEB_ROOT;
  const fallback = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const path = resolve(candidate ?? fallback);
  try {
    await access(path);
    return path;
  } catch {
    if (candidate !== undefined) {
      throw new Error(`Web root does not exist: ${path}`);
    }
    return undefined;
  }
}

function addRootOptions(command: Command): Command {
  return command
    .option("--codex-home <path>", "Codex home root (defaults to CODEX_HOME or ~/.codex)")
    .option("--workspace <path>", "Workspace root containing managed files")
    .option("--root <path>", "Additional allowed snapshot root; repeatable", collect, []);
}

export function buildProgram(): Command {
  const program = new Command()
    .name("codex-mantle")
    .description("Local-first, reversible control for Codex configuration and extensions")
    .version(PRODUCT_VERSION)
    .option("--json", "Emit machine-readable JSON")
    .showSuggestionAfterError();

  program
    .command("doctor")
    .description("Check the local toolchain without reading credentials")
    .option("--codex <path>", "Codex executable override")
    .action(async (options: CommonCodexOptions, command: Command) => {
      const commands = doctorCommands(options);
      const report = await runDoctor(commands === undefined ? {} : { commands });
      print(command, report, () => {
        for (const tool of report.tools) {
          process.stdout.write(
            `${tool.status.toUpperCase().padEnd(7)} ${tool.name.padEnd(12)} ${tool.version ?? tool.message}\n`,
          );
        }
        process.stdout.write(
          `\nMode: ${report.readOnly ? "read-only" : "guarded writes enabled"}\n`,
        );
      });
      if (!report.ok) process.exitCode = 1;
    });

  const compatibility = program.command("compatibility").description("Probe Codex compatibility");
  compatibility
    .command("probe")
    .option("--codex <path>", "Codex executable override")
    .action(async (options: CommonCodexOptions, command: Command) => {
      const probe = await probeCodex(codexOptions(options));
      print(command, probe, () => {
        process.stdout.write(`Codex: ${probe.version?.raw ?? "unavailable or unrecognized"}\n`);
        process.stdout.write(`Mode: ${probe.readOnly ? "read-only" : "guarded writes enabled"}\n`);
        for (const reason of probe.reasons) process.stdout.write(`- ${reason}\n`);
      });
      if (!probe.capabilities.command) process.exitCode = 1;
    });

  compatibility
    .command("schema")
    .description(
      "Generate the installed Codex app-server JSON Schema into an existing empty directory",
    )
    .requiredOption("--output <path>", "Existing, empty, absolute output directory")
    .option("--codex <path>", "Codex executable override")
    .option("--experimental", "Include explicitly experimental app-server fields")
    .action(
      async (
        options: CommonCodexOptions & { output: string; experimental?: boolean },
        command: Command,
      ) => {
        const result = await generateAppServerSchema({
          outputDir: options.output,
          ...(options.codex === undefined ? {} : { codexPath: options.codex }),
          ...(options.experimental === true ? { includeExperimental: true } : {}),
        });
        print(command, result, () => {
          process.stdout.write(
            result.ok
              ? `Generated ${result.generatedFiles.length} schema file(s) in ${result.outputDir}\n`
              : `Schema generation failed: ${result.message}\n`,
          );
        });
        if (!result.ok) process.exitCode = 1;
      },
    );

  const profile = program
    .command("profile")
    .description("Plan and apply declarative profile packs");
  profile
    .command("plan")
    .argument("<manifest>", "Profile manifest JSON")
    .option("--codex-home <path>", "Codex home root")
    .option("--workspace <path>", "Workspace root for workspace-targeted files")
    .option("--output <path>", "New plan file; defaults to the Mantle state directory")
    .action(
      async (
        manifest: string,
        options: { codexHome?: string; workspace?: string; output?: string },
        command: Command,
      ) => {
        const pack = await loadProfilePack(absolutePath(manifest, "Profile manifest"));
        const planOptions = {
          codexHome: absolutePath(options.codexHome ?? resolveCodexHome(), "Codex home"),
          ...(options.workspace === undefined
            ? {}
            : { workspaceRoot: absolutePath(options.workspace, "Workspace root") }),
        };
        const plan = await buildProfilePlan(pack, planOptions);
        const output = absolutePath(
          options.output ?? resolve(resolveStateDir(), "plans", `${plan.id}.json`),
          "Plan output",
        );
        await writeJsonExclusive(output, plan);
        const result = {
          approvalId: getPlanApprovalId(plan),
          changeCount: plan.operations.length,
          output,
          plan,
        };
        print(command, result, () => {
          process.stdout.write(formatProfilePlanHuman(plan, output, result.approvalId));
        });
      },
    );

  profile
    .command("apply")
    .argument("<plan>", "Plan JSON produced by profile plan")
    .requiredOption("--approve <id>", "Exact plan-bound approval id")
    .option("--codex <path>", "Codex executable override")
    .option("--state-dir <path>", "Snapshot and transaction state directory")
    .action(
      async (
        planPath: string,
        options: CommonCodexOptions & { approve: string; stateDir?: string },
        command: Command,
      ) => {
        const probe = await probeCodex(codexOptions(options));
        if (probe.readOnly) {
          throw new Error(
            `Profile apply is disabled in read-only compatibility mode. ${probe.reasons.join(" ")}`,
          );
        }
        const plan = MutationPlanSchema.parse(
          JSON.parse(await readFile(absolutePath(planPath, "Plan"), "utf8")),
        ) as MutationPlan;
        const result = await applyPlan(plan, {
          approvalId: options.approve,
          stateDir: absolutePath(options.stateDir ?? resolveStateDir(), "State directory"),
        });
        print(command, result, () => {
          process.stdout.write(
            `Applied ${result.changed.length} change(s). Snapshot: ${result.snapshotId ?? "not required"}\n`,
          );
        });
      },
    );

  const snapshot = program
    .command("snapshot")
    .description("Create, inspect, list and restore byte-exact snapshots");
  addRootOptions(
    snapshot
      .command("create")
      .requiredOption("--file <path>", "File to snapshot; repeatable", collect)
      .option("--reason <text>", "Short snapshot reason", "manual snapshot")
      .option("--state-dir <path>", "Mantle state directory"),
  ).action(
    async (
      options: RootOptions & { file?: string[]; reason: string; stateDir?: string },
      command: Command,
    ) => {
      if (!Array.isArray(options.file) || options.file.length === 0) {
        throw new Error("At least one --file option is required.");
      }
      const store = await SnapshotStore.open({
        allowedRoots: resolveAllowedRoots(options),
        stateDir: absolutePath(options.stateDir ?? resolveStateDir(), "State directory"),
      });
      const manifest = await store.create(
        options.file.map((path) => absolutePath(path, "Snapshot file")),
        options.reason,
      );
      print(command, manifest, () => process.stdout.write(`Snapshot created: ${manifest.id}\n`));
    },
  );

  addRootOptions(
    snapshot.command("list").option("--state-dir <path>", "Mantle state directory"),
  ).action(async (options: RootOptions & { stateDir?: string }, command: Command) => {
    const store = await SnapshotStore.open({
      allowedRoots: resolveAllowedRoots(options),
      stateDir: absolutePath(options.stateDir ?? resolveStateDir(), "State directory"),
    });
    const manifests = await store.list();
    print(command, manifests, () => {
      if (manifests.length === 0) process.stdout.write("No snapshots.\n");
      for (const manifest of manifests) {
        process.stdout.write(
          `${manifest.id}  ${manifest.createdAt}  ${manifest.entries.length} file(s)  ${manifest.reason}\n`,
        );
      }
    });
  });

  addRootOptions(
    snapshot
      .command("inspect")
      .argument("<id>", "Snapshot id")
      .option("--state-dir <path>", "Mantle state directory"),
  ).action(async (id: string, options: RootOptions & { stateDir?: string }, command: Command) => {
    const store = await SnapshotStore.open({
      allowedRoots: resolveAllowedRoots(options),
      stateDir: absolutePath(options.stateDir ?? resolveStateDir(), "State directory"),
    });
    const manifest = await store.load(id);
    const hashes = await currentHashes(manifest.entries);
    const result = {
      approvalId: getRestoreApprovalId(manifest),
      currentHashes: hashes,
      currentHashesDigest: currentHashesDigest(hashes),
      manifest,
    };
    print(command, result, () => {
      process.stdout.write(
        formatSnapshotInspectHuman(manifest, hashes, result.approvalId, result.currentHashesDigest),
      );
    });
  });

  addRootOptions(
    snapshot
      .command("restore")
      .argument("<id>", "Snapshot id")
      .requiredOption("--approve <id>", "Exact snapshot-bound approval id")
      .requiredOption(
        "--expect-current <sha256>",
        "Current-hash digest emitted by snapshot inspect",
      )
      .option("--state-dir <path>", "Mantle state directory"),
  ).action(
    async (
      id: string,
      options: RootOptions & { approve: string; expectCurrent: string; stateDir?: string },
      command: Command,
    ) => {
      const store = await SnapshotStore.open({
        allowedRoots: resolveAllowedRoots(options),
        stateDir: absolutePath(options.stateDir ?? resolveStateDir(), "State directory"),
      });
      const manifest = await store.load(id);
      const hashes = await currentHashes(manifest.entries);
      if (currentHashesDigest(hashes) !== options.expectCurrent) {
        throw new Error(
          "Restore refused because the inspected current-hash digest no longer matches.",
        );
      }
      const result = await store.restore(id, {
        approvalId: options.approve,
        expectedCurrentHashes: hashes,
      });
      print(command, result, () =>
        process.stdout.write(`Restored ${result.restored.length} file(s) from ${id}.\n`),
      );
    },
  );

  const plugin = program.command("plugin").description("Inspect data-only Mantle plugins");
  plugin
    .command("validate")
    .description("Validate a plugin manifest without executing third-party code")
    .argument("<manifest>", "Plugin manifest JSON")
    .action(async (manifest: string, _options: unknown, command: Command) => {
      const path = absolutePath(manifest, "Plugin manifest");
      const parsed = parsePluginManifestJson(await readFile(path, "utf8"));
      const result = { manifest: parsed, path, valid: true };
      print(command, result, () =>
        process.stdout.write(`Valid plugin manifest: ${parsed.id}@${parsed.version}\n`),
      );
    });

  program
    .command("serve")
    .description("Run the read-only local dashboard")
    .addOption(
      new Option("--host <host>", "Loopback host")
        .choices(["127.0.0.1", "::1"])
        .default("127.0.0.1"),
    )
    .option("--port <number>", "Loopback port", parsePort, 41_237)
    .option("--web-root <path>", "Built dashboard directory")
    .option("--codex <path>", "Codex executable override")
    .option("--codex-home <path>", "Codex home root")
    .option("--workspace <path>", "Workspace root for snapshot metadata")
    .option("--state-dir <path>", "Mantle state directory")
    .option("--open", "Open the dashboard in the default browser", false)
    .action(
      async (
        options: CommonCodexOptions &
          RootOptions & {
            host: "127.0.0.1" | "::1";
            port: number;
            webRoot?: string;
            stateDir?: string;
            open: boolean;
          },
      ) => {
        const probe = await probeCodex(codexOptions(options));
        const roots = resolveAllowedRoots(options);
        const stateDir = absolutePath(options.stateDir ?? resolveStateDir(), "State directory");
        const webRoot = await existingWebRoot(options.webRoot);
        const snapshotProvider = async (): Promise<readonly SnapshotProviderValue[]> => {
          const store = await SnapshotStore.open({ allowedRoots: roots, stateDir });
          return (await store.list()).map((manifest) => ({
            id: manifest.id,
            createdAt: manifest.createdAt,
            reason: manifest.reason,
            fileCount: manifest.entries.length,
            byteCount: manifest.entries.reduce((total, entry) => total + entry.size, 0),
          }));
        };
        const handle = await startMantleServer({
          host: options.host,
          port: options.port,
          productVersion: PRODUCT_VERSION,
          ...(webRoot === undefined ? {} : { webRoot }),
          statusProvider: () => probeToStatus(probe),
          snapshotProvider,
        });
        process.stdout.write(`Codex Mantle ${PRODUCT_VERSION} is listening at ${handle.origin}\n`);
        process.stdout.write("Dashboard APIs are read-only. Press Ctrl+C to stop.\n");
        if (options.open) await open(handle.origin).catch(() => undefined);
        await new Promise<void>((done) => {
          const stop = () => void handle.close().finally(done);
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      },
    );

  return program;
}

function captureParserStderr(command: Command, output: string[]): void {
  command.exitOverride();
  command.configureOutput({
    writeErr: (value) => {
      output.push(value);
    },
  });
  for (const subcommand of command.commands) captureParserStderr(subcommand, output);
}

export async function main(argv = process.argv): Promise<void> {
  const parserStderr: string[] = [];
  const program = buildProgram();
  captureParserStderr(program, parserStderr);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;

    const json = argv.includes("--json");
    if (json) {
      process.stderr.write(
        jsonDocument({
          error: {
            code: error instanceof CommanderError ? error.code : "runtime_error",
            message: errorMessage(error),
          },
        }),
      );
    } else if (parserStderr.length > 0) {
      process.stderr.write(parserStderr.join(""));
    } else {
      process.stderr.write(`Error: ${errorMessage(error)}\n`);
    }
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
