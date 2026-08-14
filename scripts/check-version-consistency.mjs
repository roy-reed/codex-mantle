#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseAttestation } from "./lib/release-attestation.mjs";
import { validateReleaseCommit } from "./lib/release-commit.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readArgumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspaceManifests(parent) {
  const root = resolve(repositoryRoot, parent);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name, "package.json"))
    .sort((left, right) => left.localeCompare(right, "en"));
}

const rootManifestPath = resolve(repositoryRoot, "package.json");
const rootManifest = readJson(rootManifestPath);
const expectedVersion = rootManifest.version;
const strictSemver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

if (typeof expectedVersion !== "string" || !strictSemver.test(expectedVersion)) {
  throw new Error("The root package version is missing or invalid.");
}

const mismatches = [];
const release = process.argv.includes("--release");
if (release) {
  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    mismatches.push("release checkout HEAD could not be resolved by Git");
  }
  mismatches.push(
    ...validateReleaseCommit({
      head,
      expected: readArgumentValue("--expected-commit"),
    }),
  );
}
for (const manifestPath of [...workspaceManifests("apps"), ...workspaceManifests("packages")]) {
  const manifest = readJson(manifestPath);
  if (manifest.version !== expectedVersion) {
    mismatches.push(`${manifest.name ?? basename(manifestPath)}=${String(manifest.version)}`);
  }
}

const versionSource = readFileSync(resolve(repositoryRoot, "packages/core/src/version.ts"), "utf8");
const sourceMatch = versionSource.match(
  /^export const PRODUCT_VERSION = "([^"]+)" as const;\r?$/mu,
);
if (sourceMatch?.[1] !== expectedVersion) {
  mismatches.push(`PRODUCT_VERSION=${sourceMatch?.[1] ?? "missing"}`);
}

const changelog = readFileSync(resolve(repositoryRoot, "CHANGELOG.md"), "utf8");
const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^## \\[${escapedVersion}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`, "mu").test(changelog)) {
  mismatches.push(`CHANGELOG heading for ${expectedVersion}=missing`);
}

const attestationPath = resolve(
  repositoryRoot,
  "docs",
  "release",
  "attestations",
  `v${expectedVersion}.md`,
);
if (!existsSync(attestationPath)) {
  mismatches.push(`release attestation v${expectedVersion}=missing`);
} else {
  const attestation = readFileSync(attestationPath, "utf8");
  mismatches.push(
    ...validateReleaseAttestation(attestation, {
      version: expectedVersion,
      release,
    }),
  );
}

if (mismatches.length > 0) {
  throw new Error(`Version consistency check failed:\n- ${mismatches.join("\n- ")}`);
}

console.log(`Version consistency check passed (${expectedVersion}).`);
