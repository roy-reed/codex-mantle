import { randomBytes } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { sha256 } from "./hash.js";
import { assertPortableRelativePath, PathBoundary, samePathIdentity } from "./path-boundary.js";
import { applyManagedBlock, decodeUtf8Text } from "./text.js";

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

const ProfileFileBaseSchema = z.object({
  blockId: z.string().regex(PORTABLE_ID),
  path: z.string().min(1),
  strategy: z.literal("managed-block"),
  target: z.enum(["codex-home", "workspace"]),
});

export const ProfileFileSchema = z
  .union([
    ProfileFileBaseSchema.extend({ content: z.string(), source: z.never().optional() }).strict(),
    ProfileFileBaseSchema.extend({
      content: z.never().optional(),
      source: z.string().min(1),
    }).strict(),
  ])
  .superRefine((file, context) => {
    for (const [field, value] of [
      ["path", file.path],
      ["source", file.source],
    ] as const) {
      if (value === undefined) {
        continue;
      }
      try {
        assertPortableRelativePath(value);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : `Invalid ${field}`,
          path: [field],
        });
      }
    }
  });

export const ProfilePackSchema = z
  .object({
    description: z.string().max(512).optional(),
    files: z.array(ProfileFileSchema).min(1),
    id: z.string().regex(PORTABLE_ID),
    name: z.string().min(1).max(128),
    schemaVersion: z.literal(1),
    version: z.string().regex(SEMVER),
  })
  .strict();

export type ProfilePack = z.infer<typeof ProfilePackSchema>;

export interface LoadedProfileFile {
  readonly blockId: string;
  readonly content: string;
  readonly path: string;
  readonly strategy: "managed-block";
  readonly target: "codex-home" | "workspace";
}

export interface LoadedProfilePack extends Omit<ProfilePack, "files"> {
  readonly files: readonly LoadedProfileFile[];
  readonly manifestPath: string;
}

const OptionalHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .nullable();

export const PlanOperationSchema = z
  .object({
    afterHash: z.string().regex(/^[a-f0-9]{64}$/u),
    beforeHash: OptionalHashSchema,
    contentBase64: z.string(),
    mode: z.number().int().nonnegative().max(0o777),
    path: z.string().min(1),
    strategy: z.literal("managed-block"),
    target: z.string().refine(isAbsolute, "Plan targets must be absolute"),
    targetRoot: z.enum(["codex-home", "workspace"]),
  })
  .strict();

export const MutationPlanSchema = z
  .object({
    createdAt: z.string().datetime(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    id: z.string().regex(/^plan-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/u),
    operations: z.array(PlanOperationSchema),
    profile: z
      .object({ id: z.string().regex(PORTABLE_ID), version: z.string().regex(SEMVER) })
      .strict(),
    roots: z
      .object({
        codexHome: z.string().refine(isAbsolute, "Codex home must be absolute"),
        workspace: z.string().refine(isAbsolute, "Workspace root must be absolute").optional(),
      })
      .strict(),
    schemaVersion: z.literal(1),
  })
  .strict();

export type PlanOperation = z.infer<typeof PlanOperationSchema>;
export type MutationPlan = z.infer<typeof MutationPlanSchema>;

export interface BuildProfilePlanOptions {
  readonly codexHome: string;
  readonly workspaceRoot?: string;
}

function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

function planId(now = new Date()): string {
  const stamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return `plan-${stamp}-${randomBytes(6).toString("hex")}`;
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableObject(entry)]),
    );
  }
  return value;
}

export function calculatePlanDigest(plan: Omit<MutationPlan, "digest">): string {
  return sha256(JSON.stringify(stableObject(plan)));
}

export function getPlanApprovalId(plan: MutationPlan): string {
  return `apply:${plan.id}:${plan.digest.slice(0, 16)}`;
}

export async function loadProfilePack(manifestPath: string): Promise<LoadedProfilePack> {
  if (!isAbsolute(manifestPath)) {
    throw new Error("Profile manifest path must be absolute");
  }

  const normalizedManifest = resolve(manifestPath);
  const packDir = dirname(normalizedManifest);
  const boundary = await PathBoundary.create(packDir);
  await boundary.assert(normalizedManifest);
  const manifestDocument = decodeUtf8Text(await readFile(normalizedManifest));
  const pack = ProfilePackSchema.parse(JSON.parse(manifestDocument.text));

  const files: LoadedProfileFile[] = [];
  for (const file of pack.files) {
    let content: string;
    if (file.content !== undefined) {
      content = file.content;
    } else {
      const source = boundary.resolve(file.source as string);
      await boundary.assert(source);
      content = decodeUtf8Text(await readFile(source)).text;
    }
    files.push({
      blockId: file.blockId,
      content,
      path: file.path,
      strategy: file.strategy,
      target: file.target,
    });
  }

  return {
    ...(pack.description === undefined ? {} : { description: pack.description }),
    files,
    id: pack.id,
    manifestPath: normalizedManifest,
    name: pack.name,
    schemaVersion: pack.schemaVersion,
    version: pack.version,
  };
}

export async function buildProfilePlan(
  pack: LoadedProfilePack,
  options: BuildProfilePlanOptions,
): Promise<MutationPlan> {
  const codexBoundary = await PathBoundary.create(options.codexHome);
  const workspaceBoundary =
    options.workspaceRoot === undefined
      ? undefined
      : await PathBoundary.create(options.workspaceRoot);
  const operations: PlanOperation[] = [];
  const seenTargets = new Set<string>();

  for (const file of pack.files) {
    const boundary = file.target === "codex-home" ? codexBoundary : workspaceBoundary;
    if (boundary === undefined) {
      throw new Error(`Profile ${pack.id} requires a workspace root`);
    }
    const target = await boundary.assert(boundary.resolve(file.path));
    const targetIdentity = boundary.identity(target);
    if (seenTargets.has(targetIdentity)) {
      throw new Error(`Profile contains duplicate target: ${target}`);
    }
    seenTargets.add(targetIdentity);

    const exists = await pathExists(target);
    const before = exists ? await readFile(target) : Buffer.alloc(0);
    const next = applyManagedBlock(before, { blockId: file.blockId, content: file.content });
    const beforeHash = exists ? sha256(before) : null;
    const afterHash = sha256(next);
    if (beforeHash === afterHash) {
      continue;
    }

    const info = exists ? await stat(target) : null;
    operations.push({
      afterHash,
      beforeHash,
      contentBase64: next.toString("base64"),
      mode: info === null ? 0o600 : info.mode & 0o777,
      path: file.path,
      strategy: file.strategy,
      target,
      targetRoot: file.target,
    });
  }

  const basePlan = {
    createdAt: new Date().toISOString(),
    id: planId(),
    operations,
    profile: { id: pack.id, version: pack.version },
    roots: {
      codexHome: codexBoundary.root,
      ...(workspaceBoundary === undefined ? {} : { workspace: workspaceBoundary.root }),
    },
    schemaVersion: 1 as const,
  };
  const plan = MutationPlanSchema.parse({ ...basePlan, digest: calculatePlanDigest(basePlan) });

  for (const operation of plan.operations) {
    const root =
      operation.targetRoot === "codex-home" ? plan.roots.codexHome : plan.roots.workspace;
    if (
      root === undefined ||
      !samePathIdentity(
        resolve(root, ...operation.path.replaceAll("\\", "/").split("/")),
        operation.target,
      )
    ) {
      throw new Error(`Plan operation target does not match its bound root: ${operation.target}`);
    }
  }

  return plan;
}
