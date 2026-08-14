#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const excludedDirectories = new Set([
  ".git",
  ".cache",
  ".codex-mantle",
  ".codex-mantle-home",
  ".codex-mantle-state",
  ".local-state",
  ".pnpm-store",
  ".turbo",
  ".vite",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
]);

function isExcludedPath(path) {
  return path
    .split(/[\\/]/u)
    .filter(Boolean)
    .some((segment) => excludedDirectories.has(segment.toLowerCase()));
}

function relativeFile(path) {
  const candidate = relative(repositoryRoot, path);
  if (
    !candidate ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    throw new Error(`Refusing to scan a path outside the repository: ${path}`);
  }
  return candidate;
}

function enumerateArchiveFiles() {
  const files = [];
  const pending = [repositoryRoot];

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const candidate = relativeFile(absolute);
      if (isExcludedPath(candidate)) continue;

      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        pending.push(absolute);
      } else if (metadata.isFile()) {
        files.push(candidate);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function enumerateRepositoryFiles() {
  if (!existsSync(resolve(repositoryRoot, ".git"))) {
    return { files: enumerateArchiveFiles(), source: "release archive" };
  }

  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
  });
  if (listed.status !== 0) {
    throw new Error(listed.stderr || "Unable to enumerate repository files with Git.");
  }

  const files = [];
  for (const file of listed.stdout.split(/\r?\n/u).filter(Boolean)) {
    if (isExcludedPath(file)) continue;
    const absolute = resolve(repositoryRoot, file);
    relativeFile(absolute);
    if (!existsSync(absolute)) continue;
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    files.push(file);
  }
  return { files, source: "Git worktree" };
}

const tokenPrefixes = ["gh" + "p_", "gh" + "o_", "github" + "_pat_", "sk" + "-proj-"];
const privateWindowsHomePattern =
  /[A-Za-z]:[\\/]+Users[\\/]+(?!<user>(?:[\\/]|$)|USERNAME(?:[\\/]|$)|user(?:[\\/]|$))([^\\/\s"']+)[\\/]+/i;

function verifyScannerContract() {
  const drive = "C:";
  const users = "Users";
  const separator = "\\";
  const person = "ExamplePerson";
  const ordinary = [drive, users, person, "project"].join(separator);
  const escaped = [drive, users, person, "project"].join(separator.repeat(2));
  const placeholders = ["<user>", "USERNAME", "user"].flatMap((placeholder) => [
    [drive, users, placeholder, "project"].join(separator),
    [drive, users, placeholder, "project"].join(separator.repeat(2)),
  ]);

  if (!privateWindowsHomePattern.test(ordinary) || !privateWindowsHomePattern.test(escaped)) {
    throw new Error("Repository scanner self-test failed to detect a private Windows home path.");
  }
  if (placeholders.some((fixture) => privateWindowsHomePattern.test(fixture))) {
    throw new Error("Repository scanner self-test rejected an approved Windows home placeholder.");
  }
}

const patterns = [
  { name: "private key", expression: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  {
    name: "personal Windows home path",
    expression: privateWindowsHomePattern,
  },
  { name: "private auth staging path", expression: /[.]tmp[\\/]gh-auth/i },
  ...tokenPrefixes.map((prefix) => ({
    name: `credential prefix ${prefix.slice(0, 2)}…`,
    expression: new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_-]{32,}`),
  })),
];

let inventory;
try {
  verifyScannerContract();
  inventory = enumerateRepositoryFiles();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const findings = [];
for (const file of inventory.files) {
  const absolute = resolve(repositoryRoot, file);
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    throw new Error(`File changed during repository scan: ${file}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 2_000_000) continue;

  const content = readFileSync(absolute);
  if (content.includes(0)) continue;
  const value = content.toString("utf8");
  for (const pattern of patterns) {
    if (pattern.expression.test(value)) findings.push(`${file}: ${pattern.name}`);
  }
}

if (findings.length > 0) {
  console.error(
    `Repository heuristic scan failed:\n${findings.map((item) => `- ${item}`).join("\n")}`,
  );
  process.exit(1);
}

console.log(
  `Repository heuristic scan passed (${inventory.files.length} files, ${inventory.source}).`,
);
