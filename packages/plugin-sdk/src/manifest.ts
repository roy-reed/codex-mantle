import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "must be a lowercase kebab-case identifier");

const semver = z
  .string()
  .max(100)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    "must be a semantic version",
  );

const numericVersionPart = /^(?:0|[1-9]\d*)$/u;
const wildcardVersionPart = /^(?:x|X|\*)$/u;
const semverIdentifier = /^[0-9A-Za-z-]+$/u;

function validDottedIdentifiers(value: string, enforceNumericLeadingZeros: boolean): boolean {
  return value.split(".").every((identifierPart) => {
    if (identifierPart.length === 0 || !semverIdentifier.test(identifierPart)) return false;
    return !(
      enforceNumericLeadingZeros &&
      /^\d+$/u.test(identifierPart) &&
      !numericVersionPart.test(identifierPart)
    );
  });
}

function isValidPartialVersion(input: string): boolean {
  const value = /^[vV]/u.test(input) ? input.slice(1) : input;
  if (value.length === 0) return false;

  const buildParts = value.split("+");
  if (buildParts.length > 2) return false;
  const coreAndPrerelease = buildParts[0];
  const build = buildParts[1];
  if (coreAndPrerelease === undefined || build === "") return false;

  const prereleaseSeparator = coreAndPrerelease.indexOf("-");
  const core =
    prereleaseSeparator === -1
      ? coreAndPrerelease
      : coreAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1 ? undefined : coreAndPrerelease.slice(prereleaseSeparator + 1);
  if (prerelease === "") return false;

  const coreParts = core.split(".");
  if (coreParts.length < 1 || coreParts.length > 3) return false;
  let wildcardSeen = false;
  let fullyNumeric = true;
  for (const part of coreParts) {
    if (wildcardVersionPart.test(part)) {
      wildcardSeen = true;
      fullyNumeric = false;
      continue;
    }
    if (!numericVersionPart.test(part) || wildcardSeen) return false;
  }

  if (prerelease !== undefined || build !== undefined) {
    if (coreParts.length !== 3 || !fullyNumeric) return false;
  }
  if (prerelease !== undefined && !validDottedIdentifiers(prerelease, true)) return false;
  if (build !== undefined && !validDottedIdentifiers(build, false)) return false;
  return true;
}

function isValidComparatorSet(input: string): boolean {
  const value = input.trim();
  if (value.length === 0) return false;

  const hyphenRange = /^(\S+)\s+-\s+(\S+)$/u.exec(value);
  if (hyphenRange !== null) {
    return (
      isValidPartialVersion(hyphenRange[1] ?? "") && isValidPartialVersion(hyphenRange[2] ?? "")
    );
  }

  const normalized = value.replace(/(<=|>=|[<>=^~])\s+/gu, "$1");
  return normalized.split(/\s+/u).every((comparator) => {
    const match = /^(<=|>=|<|>|=|\^|~)?(.+)$/u.exec(comparator);
    return match !== null && isValidPartialVersion(match[2] ?? "");
  });
}

/** Validate the data-only manifest's Mantle compatibility range syntax. */
export function isValidSemverRange(value: string): boolean {
  return value.split("||").every(isValidComparatorSet);
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

const relativePath = z
  .string()
  .max(240)
  .refine(isSafeRelativePath, "must be a normalized package-relative POSIX path");

const dataFilePath = relativePath.refine(
  (value) => /\.(?:json|md|toml|txt|ya?ml)$/iu.test(value),
  "must reference a data or text file (json, md, toml, txt, yaml, or yml)",
);

const targetPath = relativePath.refine(
  (value) => !/\.(?:bat|cmd|com|exe|html?|js|mjs|cjs|ps1|sh|ts|tsx)$/iu.test(value),
  "must not target executable, script, or HTML content",
);

const profileFileSchema = z.strictObject({
  source: dataFilePath,
  target: z.strictObject({
    scope: z.enum(["user", "workspace"]),
    path: targetPath,
  }),
  strategy: z.literal("managed-block"),
  marker: identifier.optional(),
});

const profileContributionSchema = z.strictObject({
  id: identifier,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(500).optional(),
  files: z.array(profileFileSchema).min(1).max(32),
});

const documentationContributionSchema = z.strictObject({
  id: identifier,
  title: z.string().min(1).max(120),
  path: relativePath.refine((value) => value.toLowerCase().endsWith(".md"), "must be Markdown"),
});

export const pluginManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  name: z.string().min(1).max(120),
  version: semver,
  description: z.string().min(1).max(500),
  license: z.string().min(1).max(100).optional(),
  repository: z
    .url()
    .refine((value) => value.startsWith("https://"), "must use HTTPS")
    .optional(),
  compatibility: z.strictObject({
    mantle: z
      .string()
      .min(1)
      .max(100)
      .refine(isValidSemverRange, "must be a valid semantic-version range"),
    codexSeries: z
      .array(z.string().regex(/^\d+\.\d+$/u))
      .max(32)
      .optional(),
  }),
  contributions: z
    .strictObject({
      profiles: z.array(profileContributionSchema).max(64).optional(),
      documentation: z.array(documentationContributionSchema).max(64).optional(),
    })
    .refine(
      (value) => (value.profiles?.length ?? 0) + (value.documentation?.length ?? 0) > 0,
      "must declare at least one profile or documentation contribution",
    ),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type PluginManifestIssueCode = "forbidden-field" | "invalid-json" | "schema";

export interface PluginManifestIssue {
  code: PluginManifestIssueCode;
  path: readonly (string | number)[];
  message: string;
}

export type PluginManifestValidationResult =
  | { success: true; data: PluginManifest }
  | { success: false; issues: readonly PluginManifestIssue[] };

const FORBIDDEN_FIELDS = new Set([
  "command",
  "commands",
  "entrypoint",
  "exec",
  "executable",
  "executablepath",
  "hooks",
  "html",
  "script",
  "scripts",
  "shell",
]);

function findForbiddenFields(
  value: unknown,
  path: readonly (string | number)[] = [],
  issues: PluginManifestIssue[] = [],
): PluginManifestIssue[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findForbiddenFields(item, [...path, index], issues);
    });
    return issues;
  }
  if (value === null || typeof value !== "object") return issues;

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      issues.push({
        code: "forbidden-field",
        path: nestedPath,
        message: `Field "${key}" is forbidden because plugin manifests are data-only.`,
      });
    }
    findForbiddenFields(nestedValue, nestedPath, issues);
  }
  return issues;
}

export function validatePluginManifest(input: unknown): PluginManifestValidationResult {
  const forbiddenIssues = findForbiddenFields(input);
  if (forbiddenIssues.length > 0) return { success: false, issues: forbiddenIssues };

  const parsed = pluginManifestSchema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };

  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      code: "schema",
      path: issue.path.map((segment) =>
        typeof segment === "symbol" ? (segment.description ?? "<symbol>") : segment,
      ),
      message: issue.message,
    })),
  };
}

export class PluginManifestValidationError extends Error {
  readonly issues: readonly PluginManifestIssue[];

  constructor(issues: readonly PluginManifestIssue[]) {
    super(
      issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
    );
    this.name = "PluginManifestValidationError";
    this.issues = issues;
  }
}

export function parsePluginManifest(input: unknown): PluginManifest {
  const result = validatePluginManifest(input);
  if (!result.success) throw new PluginManifestValidationError(result.issues);
  return result.data;
}

export function parsePluginManifestJson(json: string): PluginManifest {
  let input: unknown;
  try {
    input = JSON.parse(json) as unknown;
  } catch {
    throw new PluginManifestValidationError([
      { code: "invalid-json", path: [], message: "Manifest is not valid JSON." },
    ]);
  }
  return parsePluginManifest(input);
}
