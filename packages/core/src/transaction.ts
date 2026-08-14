import { lstat, readFile } from "node:fs/promises";
import { atomicWriteFile } from "./fs-atomic.js";
import { sha256 } from "./hash.js";
import { PathBoundary, pathIdentityKey, samePathIdentity } from "./path-boundary.js";
import {
  calculatePlanDigest,
  getPlanApprovalId,
  type MutationPlan,
  MutationPlanSchema,
  type PlanOperation,
} from "./profile.js";
import { getRestoreApprovalId, SnapshotStore } from "./snapshot.js";

export interface VerifiedPlan {
  readonly changes: readonly {
    readonly afterHash: string;
    readonly beforeHash: string | null;
    readonly target: string;
  }[];
  readonly plan: MutationPlan;
}

export interface ApplyPlanOptions {
  readonly approvalId: string;
  readonly stateDir: string;
  /** Optional domain verification. Throw or return false to trigger rollback. */
  readonly verify?: (plan: MutationPlan) => unknown;
}

export interface ApplyPlanResult {
  readonly changed: readonly string[];
  readonly planId: string;
  readonly snapshotId: string | null;
}

export class TransactionError extends Error {
  public readonly causeError: unknown;
  public readonly rollbackError: unknown;
  public readonly snapshotId: string | null;

  public constructor(
    message: string,
    options: { cause: unknown; rollbackError?: unknown; snapshotId?: string | null },
  ) {
    super(message, { cause: options.cause });
    this.name = "TransactionError";
    this.causeError = options.cause;
    this.rollbackError = options.rollbackError;
    this.snapshotId = options.snapshotId ?? null;
  }
}

async function currentHash(target: string): Promise<string | null> {
  try {
    const info = await lstat(target);
    if (!info.isFile()) {
      throw new Error(`Transaction target is not a regular file: ${target}`);
    }
    return sha256(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function withoutDigest(plan: MutationPlan): Omit<MutationPlan, "digest"> {
  const { digest: _digest, ...unsigned } = plan;
  return unsigned;
}

function decodePlannedContent(operation: PlanOperation): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      operation.contentBase64,
    )
  ) {
    throw new Error(`Invalid base64 content in plan operation: ${operation.target}`);
  }
  const content = Buffer.from(operation.contentBase64, "base64");
  if (sha256(content) !== operation.afterHash) {
    throw new Error(`Plan content does not match afterHash: ${operation.target}`);
  }
  return content;
}

async function planBoundaries(
  plan: MutationPlan,
): Promise<Map<"codex-home" | "workspace", PathBoundary>> {
  const boundaries = new Map<"codex-home" | "workspace", PathBoundary>();
  boundaries.set("codex-home", await PathBoundary.create(plan.roots.codexHome));
  if (plan.roots.workspace !== undefined) {
    boundaries.set("workspace", await PathBoundary.create(plan.roots.workspace));
  }
  return boundaries;
}

export async function verifyPlan(input: MutationPlan): Promise<VerifiedPlan> {
  const plan = MutationPlanSchema.parse(input);
  if (calculatePlanDigest(withoutDigest(plan)) !== plan.digest) {
    throw new Error("Plan digest verification failed");
  }

  const boundaries = await planBoundaries(plan);
  const changes: VerifiedPlan["changes"][number][] = [];
  const seenTargets = new Set<string>();
  for (const operation of plan.operations) {
    const boundary = boundaries.get(operation.targetRoot);
    if (boundary === undefined) {
      throw new Error(`Plan has no bound root for ${operation.targetRoot}`);
    }
    const expectedTarget = boundary.resolve(operation.path);
    const target = await boundary.assert(operation.target);
    if (!samePathIdentity(expectedTarget, target)) {
      throw new Error(`Plan target does not match its root and relative path: ${target}`);
    }
    const targetIdentity = boundary.identity(target);
    if (seenTargets.has(targetIdentity)) {
      throw new Error(`Plan contains a duplicate target: ${target}`);
    }
    seenTargets.add(targetIdentity);
    decodePlannedContent(operation);

    const actualHash = await currentHash(target);
    if (actualHash !== operation.beforeHash) {
      throw new Error(`Plan is stale; target hash changed: ${target}`);
    }
    changes.push({ afterHash: operation.afterHash, beforeHash: operation.beforeHash, target });
  }

  return { changes, plan };
}

export async function applyPlan(
  input: MutationPlan,
  options: ApplyPlanOptions,
): Promise<ApplyPlanResult> {
  const verified = await verifyPlan(input);
  const plan = verified.plan;
  if (options.approvalId !== getPlanApprovalId(plan)) {
    throw new Error("Apply approval id does not match this exact plan");
  }
  if (plan.operations.length === 0) {
    return { changed: [], planId: plan.id, snapshotId: null };
  }

  const allowedRoots = [
    plan.roots.codexHome,
    ...(plan.roots.workspace === undefined ? [] : [plan.roots.workspace]),
  ];
  const store = await SnapshotStore.open({ allowedRoots, stateDir: options.stateDir });
  return store.runMutation(async () => {
    // Revalidate after waiting for the state-directory lock. This closes the
    // ordinary Mantle-vs-Mantle stale-plan window before snapshot creation.
    const lockedVerified = await verifyPlan(plan);
    const targets = lockedVerified.changes.map((change) => change.target);
    const snapshot = await store.create(
      targets,
      `before applying ${plan.profile.id}@${plan.profile.version}`,
    );
    const plannedBeforeHashes = new Map(
      plan.operations.map((operation) => [pathIdentityKey(operation.target), operation.beforeHash]),
    );
    for (const entry of snapshot.entries) {
      if (entry.sha256 !== plannedBeforeHashes.get(pathIdentityKey(entry.target))) {
        throw new Error(`Plan is stale; target drifted while snapshotting: ${entry.target}`);
      }
    }
    const expectedDuringRollback: Record<string, string | null> = Object.fromEntries(
      plan.operations.map((operation) => [operation.target, operation.beforeHash]),
    );

    try {
      const boundaries = await planBoundaries(plan);
      for (const operation of plan.operations) {
        const boundary = boundaries.get(operation.targetRoot);
        if (boundary === undefined) {
          throw new Error(`Missing boundary for ${operation.targetRoot}`);
        }
        await atomicWriteFile(operation.target, decodePlannedContent(operation), {
          beforeCommit: async () => {
            await boundary.assert(operation.target);
          },
          expectedTargetHash: operation.beforeHash,
          mode: operation.mode,
        });
        expectedDuringRollback[operation.target] = operation.afterHash;
        if ((await currentHash(operation.target)) !== operation.afterHash) {
          throw new Error(`Post-write hash verification failed: ${operation.target}`);
        }
      }

      const domainResult = await options.verify?.(plan);
      if (domainResult === false) {
        throw new Error("Transaction verification callback rejected the applied plan");
      }
    } catch (error) {
      try {
        await store.restore(snapshot.id, {
          approvalId: getRestoreApprovalId(snapshot),
          expectedCurrentHashes: expectedDuringRollback,
        });
      } catch (rollbackError) {
        throw new TransactionError("Plan application failed and automatic rollback was not clean", {
          cause: error,
          rollbackError,
          snapshotId: snapshot.id,
        });
      }
      throw new TransactionError("Plan application failed; the original bytes were restored", {
        cause: error,
        snapshotId: snapshot.id,
      });
    }

    return { changed: targets, planId: plan.id, snapshotId: snapshot.id };
  });
}
