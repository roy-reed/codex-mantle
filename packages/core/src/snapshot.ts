import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  atomicWriteFile,
  conditionalUnlink,
  currentFileHash,
  rollbackFileIfUnchanged,
} from "./fs-atomic.js";
import { isSha256, sha256 } from "./hash.js";
import { type MutationLockOptions, withMutationLock } from "./mutation-lock.js";
import { PathBoundary, PathBoundaryError, pathIdentityKey } from "./path-boundary.js";
import { ensureRealDirectory } from "./private-directory.js";

const SNAPSHOT_ID_PATTERN = /^[0-9]{8}T[0-9]{6}[0-9]{3}Z-[a-f0-9]{12}$/u;

export const SnapshotEntrySchema = z
  .object({
    exists: z.boolean(),
    mode: z.number().int().nonnegative().max(0o777).nullable(),
    payload: z
      .string()
      .regex(/^files\/[0-9]{4}\.bin$/u)
      .nullable(),
    sha256: z.string().refine(isSha256).nullable(),
    size: z.number().int().nonnegative(),
    target: z.string().refine(isAbsolute, "Snapshot targets must be absolute"),
  })
  .strict();

export const SnapshotManifestSchema = z
  .object({
    createdAt: z.string().datetime(),
    entries: z.array(SnapshotEntrySchema).min(1),
    id: z.string().regex(SNAPSHOT_ID_PATTERN),
    reason: z.string().min(1).max(256),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const targets = new Set<string>();
    const payloads = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      const targetIdentity = pathIdentityKey(entry.target);
      if (targets.has(targetIdentity)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate snapshot target identity: ${entry.target}`,
          path: ["entries", index, "target"],
        });
      }
      targets.add(targetIdentity);
      if (entry.payload !== null) {
        if (payloads.has(entry.payload)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate snapshot payload: ${entry.payload}`,
            path: ["entries", index, "payload"],
          });
        }
        payloads.add(entry.payload);
      }
    }
  });

export type SnapshotEntry = z.infer<typeof SnapshotEntrySchema>;
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export interface SnapshotStoreOptions {
  readonly allowedRoots: readonly string[];
  readonly stateDir: string;
}

export interface RestoreSnapshotOptions {
  /** Must exactly bind to the snapshot selected by getRestoreApprovalId(). */
  readonly approvalId: string;
  /** Current hashes the caller showed to the user; null means absent. */
  readonly expectedCurrentHashes: Readonly<Record<string, string | null>>;
}

export interface RestoreSnapshotResult {
  readonly restored: readonly string[];
  readonly snapshotId: string;
}

interface ReviewedFileState {
  readonly bytes: Buffer | null;
  readonly hash: string | null;
  readonly mode: number | null;
  readonly target: string;
}

interface CommittedRestore {
  readonly committedHash: string | null;
  readonly identity: string;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function makeSnapshotId(now = new Date()): string {
  const stamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return `${stamp}-${randomBytes(6).toString("hex")}`;
}

function manifestBytes(manifest: SnapshotManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function getRestoreApprovalId(manifest: SnapshotManifest): string {
  return `restore:${manifest.id}:${sha256(manifestBytes(manifest)).slice(0, 16)}`;
}

export class SnapshotStore {
  public readonly stateDir: string;
  readonly #boundaries: readonly PathBoundary[];
  readonly #lockRoot: string;
  readonly #snapshotRoot: string;

  private constructor(
    stateDir: string,
    snapshotRoot: string,
    lockRoot: string,
    boundaries: readonly PathBoundary[],
  ) {
    this.stateDir = stateDir;
    this.#snapshotRoot = snapshotRoot;
    this.#lockRoot = lockRoot;
    this.#boundaries = boundaries;
  }

  public static async open(options: SnapshotStoreOptions): Promise<SnapshotStore> {
    if (!isAbsolute(options.stateDir)) {
      throw new Error("Snapshot state directory must be absolute");
    }
    if (options.allowedRoots.length === 0) {
      throw new Error("At least one allowed root is required");
    }

    // Validate the nearest existing ancestor before creating anything. The
    // arbitrary caller-owned stateDir itself is not ACL-rewritten.
    const stateDir = await ensureRealDirectory(resolve(options.stateDir));
    const snapshotRoot = await ensureRealDirectory(join(stateDir, "snapshots"), {
      privateDirectory: true,
    });
    const lockRoot = await ensureRealDirectory(join(stateDir, "locks"), {
      privateDirectory: true,
    });

    const boundaries = await Promise.all(
      options.allowedRoots.map((root) => PathBoundary.create(root)),
    );
    boundaries.sort((left, right) => right.root.length - left.root.length);
    return new SnapshotStore(stateDir, snapshotRoot, lockRoot, boundaries);
  }

  #boundaryFor(target: string): PathBoundary {
    const normalized = resolve(target);
    const boundary = this.#boundaries.find((candidate) => isWithin(candidate.root, normalized));
    if (boundary === undefined) {
      throw new PathBoundaryError(`Snapshot target is outside all allowed roots: ${normalized}`);
    }
    return boundary;
  }

  async #assertTarget(target: string): Promise<string> {
    return this.#boundaryFor(target).assert(resolve(target));
  }

  #targetIdentity(target: string): string {
    return this.#boundaryFor(target).identity(resolve(target));
  }

  public async runMutation<T>(
    operation: () => Promise<T>,
    options: MutationLockOptions = {},
  ): Promise<T> {
    return withMutationLock(this.stateDir, this.#lockRoot, operation, options);
  }

  public async create(
    targets: readonly string[],
    reason = "manual snapshot",
  ): Promise<SnapshotManifest> {
    return this.runMutation(() => this.#create(targets, reason));
  }

  async #create(targets: readonly string[], reason: string): Promise<SnapshotManifest> {
    if (targets.length === 0) {
      throw new Error("A snapshot requires at least one target");
    }
    if (reason.trim() === "" || reason.length > 256) {
      throw new Error("Snapshot reason must be 1-256 characters");
    }

    const normalizedTargets = new Map<string, string>();
    for (const requestedTarget of targets) {
      const target = await this.#assertTarget(requestedTarget);
      const identity = this.#targetIdentity(target);
      if (normalizedTargets.has(identity)) {
        throw new Error(`Snapshot request contains a duplicate target identity: ${target}`);
      }
      normalizedTargets.set(identity, target);
    }
    const uniqueTargets = [...normalizedTargets.values()].sort((left, right) =>
      pathIdentityKey(left).localeCompare(pathIdentityKey(right)),
    );
    const id = makeSnapshotId();
    const temporaryDir = join(this.#snapshotRoot, `.creating-${id}`);
    const finalDir = join(this.#snapshotRoot, id);
    await mkdir(join(temporaryDir, "files"), { mode: 0o700, recursive: true });

    try {
      const entries: SnapshotEntry[] = [];
      for (const [index, target] of uniqueTargets.entries()) {
        await this.#assertTarget(target);
        if (!(await pathExists(target))) {
          entries.push({ exists: false, mode: null, payload: null, sha256: null, size: 0, target });
          continue;
        }

        const info = await stat(target);
        if (!info.isFile()) {
          throw new Error(`Only regular files can be snapshotted: ${target}`);
        }
        const bytes = await readFile(target);
        const payload = `files/${index.toString().padStart(4, "0")}.bin`;
        await writeFile(join(temporaryDir, ...payload.split("/")), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        entries.push({
          exists: true,
          mode: info.mode & 0o777,
          payload,
          sha256: sha256(bytes),
          size: bytes.byteLength,
          target,
        });
      }

      const manifest = SnapshotManifestSchema.parse({
        createdAt: new Date().toISOString(),
        entries,
        id,
        reason,
        schemaVersion: 1,
      });
      await writeFile(join(temporaryDir, "manifest.json"), manifestBytes(manifest), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryDir, finalDir);

      // Success is based on the persisted bytes, not the in-memory document.
      return await this.load(id);
    } catch (error) {
      await rm(temporaryDir, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  public async list(): Promise<SnapshotManifest[]> {
    const children = await readdir(this.#snapshotRoot, { withFileTypes: true });
    const manifests: SnapshotManifest[] = [];
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || !SNAPSHOT_ID_PATTERN.test(child.name)) {
        continue;
      }
      manifests.push(await this.load(child.name));
    }
    return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public async load(id: string): Promise<SnapshotManifest> {
    if (!SNAPSHOT_ID_PATTERN.test(id)) {
      throw new Error("Invalid snapshot id");
    }
    const snapshotDir = join(this.#snapshotRoot, id);
    const snapshotBoundary = await PathBoundary.create(snapshotDir);
    const manifestPath = await snapshotBoundary.assert(join(snapshotDir, "manifest.json"));
    const manifest = SnapshotManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.id !== id) {
      throw new Error("Snapshot manifest id does not match its directory");
    }

    for (const entry of manifest.entries) {
      await this.#assertTarget(entry.target);
      if (!entry.exists) {
        if (
          entry.payload !== null ||
          entry.sha256 !== null ||
          entry.mode !== null ||
          entry.size !== 0
        ) {
          throw new Error(`Invalid absent snapshot entry: ${entry.target}`);
        }
        continue;
      }
      if (entry.payload === null || entry.sha256 === null || entry.mode === null) {
        throw new Error(`Incomplete snapshot entry: ${entry.target}`);
      }
      const payloadPath = await snapshotBoundary.assert(
        join(snapshotDir, ...entry.payload.split("/")),
      );
      const bytes = await readFile(payloadPath);
      if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
        throw new Error(`Snapshot payload integrity check failed: ${entry.target}`);
      }
    }
    return manifest;
  }

  public async restore(
    id: string,
    options: RestoreSnapshotOptions,
  ): Promise<RestoreSnapshotResult> {
    return this.runMutation(() => this.#restore(id, options));
  }

  async #restore(id: string, options: RestoreSnapshotOptions): Promise<RestoreSnapshotResult> {
    const manifest = await this.load(id);
    if (options.approvalId !== getRestoreApprovalId(manifest)) {
      throw new Error("Restore approval id does not match the selected snapshot");
    }

    const expectedHashes = new Map<string, string | null>();
    for (const [target, expectedHash] of Object.entries(options.expectedCurrentHashes)) {
      await this.#assertTarget(target);
      const identity = this.#targetIdentity(target);
      if (expectedHashes.has(identity)) {
        throw new Error(`Duplicate expected-current-hash target identity: ${target}`);
      }
      expectedHashes.set(identity, expectedHash);
    }

    const current = new Map<string, ReviewedFileState>();
    for (const entry of manifest.entries) {
      const target = await this.#assertTarget(entry.target);
      const identity = this.#targetIdentity(target);
      const targetExists = await pathExists(target);
      const bytes = targetExists ? await readFile(target) : null;
      const info = targetExists ? await stat(target) : null;
      if (info !== null && !info.isFile()) {
        throw new Error(`Restore target is not a regular file: ${target}`);
      }
      const hash = bytes === null ? null : sha256(bytes);
      if (!expectedHashes.has(identity)) {
        throw new Error(`Missing expected current hash for restore target: ${target}`);
      }
      if (expectedHashes.get(identity) !== hash) {
        throw new Error(`Restore refused because target drifted: ${target}`);
      }
      current.set(identity, {
        bytes,
        hash,
        mode: info === null ? null : info.mode & 0o777,
        target,
      });
    }

    const snapshotDir = join(this.#snapshotRoot, id);
    const snapshotBoundary = await PathBoundary.create(snapshotDir);
    const changed: CommittedRestore[] = [];
    try {
      for (const entry of manifest.entries) {
        const identity = this.#targetIdentity(entry.target);
        const reviewed = current.get(identity);
        if (reviewed === undefined) {
          throw new Error(`Missing reviewed state for restore target: ${entry.target}`);
        }

        if (!entry.exists) {
          await conditionalUnlink(reviewed.target, {
            beforeCommit: async () => {
              await this.#assertTarget(reviewed.target);
            },
            expectedTargetHash: reviewed.hash,
          });
        } else {
          if (entry.payload === null || entry.sha256 === null || entry.mode === null) {
            throw new Error(`Incomplete snapshot entry: ${entry.target}`);
          }
          const payloadPath = await snapshotBoundary.assert(
            join(snapshotDir, ...entry.payload.split("/")),
          );
          const payload = await readFile(payloadPath);
          if (payload.byteLength !== entry.size || sha256(payload) !== entry.sha256) {
            throw new Error(
              `Snapshot payload integrity check failed before write: ${entry.target}`,
            );
          }
          await atomicWriteFile(reviewed.target, payload, {
            beforeCommit: async () => {
              await this.#assertTarget(reviewed.target);
            },
            expectedTargetHash: reviewed.hash,
            mode: entry.mode,
          });
        }
        changed.push({ committedHash: entry.sha256, identity });
        if ((await currentFileHash(reviewed.target)) !== entry.sha256) {
          throw new Error(`Post-restore verification failed: ${reviewed.target}`);
        }
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const committed of [...changed].reverse()) {
        const prior = current.get(committed.identity);
        if (prior === undefined) {
          continue;
        }
        try {
          await rollbackFileIfUnchanged(
            prior.target,
            prior.bytes,
            prior.mode,
            committed.committedHash,
            async () => {
              await this.#assertTarget(prior.target);
            },
          );
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Snapshot restore failed; rollback conflicts were preserved instead of overwriting external data",
        );
      }
      throw error;
    }

    return {
      restored: manifest.entries.map((entry) => {
        const reviewed = current.get(this.#targetIdentity(entry.target));
        if (reviewed === undefined) {
          throw new Error(`Missing restored state for target: ${entry.target}`);
        }
        return reviewed.target;
      }),
      snapshotId: id,
    };
  }
}
