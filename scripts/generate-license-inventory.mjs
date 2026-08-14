import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactsRoot = resolve(repositoryRoot, "artifacts");
const publicMetadataFields = ["author", "homepage", "description"];

function sanitizeLicenseInventory(rawInventory) {
  if (!rawInventory || typeof rawInventory !== "object" || Array.isArray(rawInventory)) {
    throw new TypeError("pnpm license inventory must be an object grouped by license");
  }

  return Object.fromEntries(
    Object.entries(rawInventory)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([licenseName, rawEntries]) => {
        if (!Array.isArray(rawEntries)) {
          throw new TypeError(`License group ${licenseName} must contain an array`);
        }

        const entries = rawEntries
          .map((rawEntry) => {
            if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
              throw new TypeError(`License group ${licenseName} contains an invalid entry`);
            }
            if (typeof rawEntry.name !== "string" || rawEntry.name.length === 0) {
              throw new TypeError(`License group ${licenseName} contains an entry without a name`);
            }
            if (
              !Array.isArray(rawEntry.versions) ||
              rawEntry.versions.some((item) => typeof item !== "string")
            ) {
              throw new TypeError(`Package ${rawEntry.name} has an invalid versions list`);
            }
            if (typeof rawEntry.license !== "string" || rawEntry.license.length === 0) {
              throw new TypeError(`Package ${rawEntry.name} has an invalid license value`);
            }

            const entry = {
              name: rawEntry.name,
              versions: [...new Set(rawEntry.versions)].sort((left, right) =>
                left.localeCompare(right, "en"),
              ),
              license: rawEntry.license,
            };
            for (const field of publicMetadataFields) {
              if (rawEntry[field] === undefined) {
                continue;
              }
              if (typeof rawEntry[field] !== "string") {
                throw new TypeError(`Package ${rawEntry.name} has an invalid ${field} value`);
              }
              entry[field] = rawEntry[field];
            }
            return entry;
          })
          .sort((left, right) => {
            const byName = left.name.localeCompare(right.name, "en");
            return byName !== 0
              ? byName
              : left.versions.join("\u0000").localeCompare(right.versions.join("\u0000"), "en");
          });

        return [licenseName, entries];
      }),
  );
}

function assertPublicInventory(inventory) {
  const serialized = JSON.stringify(inventory);
  if (/"paths"\s*:/.test(serialized)) {
    throw new Error("Public license inventory must not contain dependency installation paths");
  }

  const machinePath =
    /(?:^[A-Za-z]:[\\/]|^\\\\|^\/(?:Users|home|root|tmp|var|private|opt|workspace)(?:\/|$)|^file:)/i;
  for (const entries of Object.values(inventory)) {
    for (const entry of entries) {
      for (const value of Object.values(entry)) {
        const values = Array.isArray(value) ? value : [value];
        if (values.some((item) => typeof item === "string" && machinePath.test(item))) {
          throw new Error(
            `Public license inventory contains a machine-local path for ${entry.name}`,
          );
        }
      }
    }
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

async function resolvePnpmInvocation() {
  if (process.platform !== "win32") {
    return { command: "pnpm", leadingArguments: [] };
  }

  for (const rawEntry of (process.env.PATH ?? "").split(delimiter)) {
    const entry = rawEntry.replace(/^"|"$/g, "");
    if (entry.length === 0) {
      continue;
    }

    const executable = join(entry, "pnpm.exe");
    if (await isFile(executable)) {
      return { command: executable, leadingArguments: [] };
    }

    const commandShim = join(entry, "pnpm.cmd");
    if (!(await isFile(commandShim))) {
      continue;
    }

    const shim = await readFile(commandShim, "utf8");
    const scriptMatch = shim.match(/["']?([^"'\r\n]*pnpm[^"'\r\n]*\.(?:cjs|mjs|js))["']?\s+%\*/i);
    if (!scriptMatch) {
      continue;
    }

    const entryPrefix = entry.endsWith(sep) ? entry : `${entry}${sep}`;
    const expanded = scriptMatch[1].replace(/%~dp0/gi, entryPrefix).replace(/%dp0%/gi, entryPrefix);
    if (expanded.includes("%")) {
      continue;
    }

    const pnpmScript = resolve(entry, expanded);
    if (await isFile(pnpmScript)) {
      return { command: process.execPath, leadingArguments: [pnpmScript] };
    }
  }

  throw new Error("Could not resolve a shell-free pnpm launcher from PATH");
}

async function collectLicenses() {
  const invocation = await resolvePnpmInvocation();
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      invocation.command,
      [...invocation.leadingArguments, "licenses", "list", "--json"],
      {
        cwd: repositoryRoot,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`pnpm licenses failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`),
        );
        return;
      }
      resolveResult(Buffer.concat(stdout));
    });
  });
}

await mkdir(artifactsRoot, { recursive: true });
const rawLicenses = await collectLicenses();
const licenses = sanitizeLicenseInventory(JSON.parse(rawLicenses.toString("utf8")));
assertPublicInventory(licenses);
await writeFile(resolve(artifactsRoot, "licenses.json"), `${JSON.stringify(licenses, null, 2)}\n`, {
  flag: "w",
  mode: 0o600,
});
process.stdout.write(`Wrote ${resolve(artifactsRoot, "licenses.json")}\n`);
