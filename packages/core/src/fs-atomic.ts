import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256 } from "./hash.js";

export class FileMutationConflictError extends Error {
  public readonly actualHash: string | null;
  public readonly expectedHash: string | null;
  public readonly target: string;

  public constructor(target: string, expectedHash: string | null, actualHash: string | null) {
    super(
      `Refused filesystem mutation because the target drifted before commit: ${target} ` +
        `(expected ${expectedHash ?? "absent"}, found ${actualHash ?? "absent"})`,
    );
    this.name = "FileMutationConflictError";
    this.actualHash = actualHash;
    this.expectedHash = expectedHash;
    this.target = target;
  }
}

export interface ConditionalMutationOptions {
  /** Revalidate path boundaries immediately before the final rename or unlink. */
  readonly beforeCommit?: () => Promise<void>;
  /** null means that the target was reviewed as absent. */
  readonly expectedTargetHash: string | null;
}

export interface AtomicWriteFileOptions {
  /** Revalidate path boundaries before preparation and immediately before rename. */
  readonly beforeCommit?: () => Promise<void>;
  /** Omit only for non-transactional callers. null means reviewed as absent. */
  readonly expectedTargetHash?: string | null;
  readonly mode?: number;
}

export async function currentFileHash(target: string): Promise<string | null> {
  try {
    const info = await lstat(target);
    if (!info.isFile()) {
      throw new Error(`Mutation target is not a regular file: ${target}`);
    }
    return sha256(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function verifyExpectedHash(target: string, expectedHash: string | null): Promise<void> {
  const actualHash = await currentFileHash(target);
  if (actualHash !== expectedHash) {
    throw new FileMutationConflictError(target, expectedHash, actualHash);
  }
}

/**
 * Writes through a sibling temporary file. The final boundary/hash verification
 * materially narrows drift, but the verification-to-rename micro-window is not
 * a portable compare-and-swap primitive against hostile non-Mantle processes.
 */
export async function atomicWriteFile(
  target: string,
  content: Uint8Array,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  const parent = dirname(target);
  await options.beforeCommit?.();
  await mkdir(parent, { mode: 0o700, recursive: true });
  const temporary = join(
    parent,
    `.${basename(target)}.codex-mantle-${randomBytes(8).toString("hex")}.tmp`,
  );
  const mode = options.mode ?? 0o600;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);

    await options.beforeCommit?.();
    if (Object.hasOwn(options, "expectedTargetHash")) {
      await verifyExpectedHash(target, options.expectedTargetHash ?? null);
    }
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function conditionalUnlink(
  target: string,
  options: ConditionalMutationOptions,
): Promise<void> {
  await options.beforeCommit?.();
  await verifyExpectedHash(target, options.expectedTargetHash);
  if (options.expectedTargetHash !== null) {
    // As with rename above, the preceding check is not a portable filesystem CAS.
    await unlink(target);
  }
}

/** Restore only while the file still contains the bytes committed by Mantle. */
export async function rollbackFileIfUnchanged(
  target: string,
  priorBytes: Uint8Array | null,
  priorMode: number | null,
  committedHash: string | null,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const commitHook = beforeCommit === undefined ? {} : { beforeCommit };
  if (priorBytes === null) {
    await conditionalUnlink(target, { ...commitHook, expectedTargetHash: committedHash });
  } else {
    await atomicWriteFile(target, priorBytes, {
      ...commitHook,
      expectedTargetHash: committedHash,
      mode: priorMode ?? 0o600,
    });
  }

  const restoredHash = await currentFileHash(target);
  const expectedRestoredHash = priorBytes === null ? null : sha256(priorBytes);
  if (restoredHash !== expectedRestoredHash) {
    throw new FileMutationConflictError(target, expectedRestoredHash, restoredHash);
  }
}
