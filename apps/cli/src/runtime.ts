import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { CodexCapabilityProbe } from "@codex-mantle/codex-adapter";
import { sha256 } from "@codex-mantle/core";
import type { StatusProviderValue } from "@codex-mantle/server";
import { jsonDocument } from "./output.js";

// 运行时辅助：文件写入、Codex 探测结果转换、快照哈希、Web 根目录
export async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonDocument(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function probeToStatus(probe: CodexCapabilityProbe): StatusProviderValue {
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

export async function currentHashes(
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

export function currentHashesDigest(hashes: Readonly<Record<string, string | null>>): string {
  const ordered = Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
  );
  return sha256(JSON.stringify(ordered));
}

export async function existingWebRoot(explicit: string | undefined): Promise<string | undefined> {
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
