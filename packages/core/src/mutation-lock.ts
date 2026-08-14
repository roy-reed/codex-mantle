import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathIdentityKey } from "./path-boundary.js";

const activeMutationLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export class MutationLockError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MutationLockError";
  }
}

export interface MutationLockOptions {
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function withMutationLock<T>(
  stateDir: string,
  lockDirectory: string,
  operation: () => Promise<T>,
  options: MutationLockOptions = {},
): Promise<T> {
  const stateKey = pathIdentityKey(stateDir);
  const inherited = activeMutationLocks.getStore();
  if (inherited?.has(stateKey) === true) {
    return operation();
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isInteger(retryDelayMs) ||
    retryDelayMs < 1
  ) {
    throw new MutationLockError("Mutation lock timing values are invalid");
  }

  const lockPath = join(lockDirectory, "mutation.lock");
  const nonce = randomBytes(16).toString("hex");
  const lockDocument = `${JSON.stringify({ createdAt: new Date().toISOString(), nonce, pid: process.pid })}\n`;
  const deadline = Date.now() + timeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(lockDocument, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new MutationLockError(
          `Timed out waiting for the mutation lock: ${lockPath}. If a process crashed, verify no Mantle mutation is active before removing this exact lock file.`,
        );
      }
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  const context = new Set(inherited ?? []);
  context.add(stateKey);
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await activeMutationLocks.run(context, operation);
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  try {
    const heldDocument = await readFile(lockPath, "utf8");
    if (heldDocument !== lockDocument) {
      throw new MutationLockError(`Mutation lock ownership changed unexpectedly: ${lockPath}`);
    }
    await handle.close();
    handle = undefined;
    if ((await readFile(lockPath, "utf8")) !== lockDocument) {
      throw new MutationLockError(`Mutation lock changed before release: ${lockPath}`);
    }
    await unlink(lockPath);
  } catch (error) {
    releaseError = error;
    await handle?.close().catch(() => undefined);
  }

  if (operationError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [operationError, releaseError],
      "Mutation and lock release both failed",
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return result as T;
}
