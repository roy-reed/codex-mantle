import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atomicWriteFile,
  FileMutationConflictError,
  rollbackFileIfUnchanged,
} from "../src/fs-atomic.js";
import { getRestoreApprovalId, SnapshotStore, sha256 } from "../src/index.js";

const temporaryRoots: string[] = [];

// Windows ACL hardening intentionally invokes the system PowerShell process
// with shell:false and verifies the resulting DACL. Cold process startup can
// exceed Vitest's 5 second default on slower hosts.
vi.setConfig({ hookTimeout: 15_000, testTimeout: 15_000 });

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-mantle-snapshot-")));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("SnapshotStore", () => {
  it("captures and restores exact bytes, including original absence", async () => {
    const root = await temporaryRoot();
    const state = await temporaryRoot();
    const existing = join(root, "AGENTS.md");
    const originallyMissing = join(root, "created.txt");
    const original = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("原始\r\n", "utf8")]);
    await writeFile(existing, original);
    const store = await SnapshotStore.open({ allowedRoots: [root], stateDir: state });
    const snapshot = await store.create([existing, originallyMissing], "test snapshot");

    await writeFile(existing, "changed", "utf8");
    await writeFile(originallyMissing, "new", "utf8");
    await store.restore(snapshot.id, {
      approvalId: getRestoreApprovalId(snapshot),
      expectedCurrentHashes: {
        [existing]: sha256("changed"),
        [originallyMissing]: sha256("new"),
      },
    });

    expect(await readFile(existing)).toEqual(original);
    await expect(readFile(originallyMissing)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.list()).map((entry) => entry.id)).toContain(snapshot.id);
    expect((await store.load(snapshot.id)).entries).toHaveLength(2);
  });

  it("refuses to overwrite an unreviewed drift", async () => {
    const root = await temporaryRoot();
    const state = await temporaryRoot();
    const target = join(root, "file.txt");
    await writeFile(target, "before", "utf8");
    const store = await SnapshotStore.open({ allowedRoots: [root], stateDir: state });
    const snapshot = await store.create([target], "drift test");
    await writeFile(target, "unexpected", "utf8");

    await expect(
      store.restore(snapshot.id, {
        approvalId: getRestoreApprovalId(snapshot),
        expectedCurrentHashes: { [target]: sha256("expected") },
      }),
    ).rejects.toThrow(/drifted/u);
    expect(await readFile(target, "utf8")).toBe("unexpected");
  });

  it("detects a modified snapshot payload before restore", async () => {
    const root = await temporaryRoot();
    const state = await temporaryRoot();
    const target = join(root, "file.txt");
    await writeFile(target, "before", "utf8");
    const store = await SnapshotStore.open({ allowedRoots: [root], stateDir: state });
    const snapshot = await store.create([target], "integrity test");
    await writeFile(join(state, "snapshots", snapshot.id, "files", "0000.bin"), "tampered", "utf8");

    await expect(store.load(snapshot.id)).rejects.toThrow(/integrity/u);
  });

  it("reports snapshot creation success only after re-loading persisted bytes", async () => {
    const root = await temporaryRoot();
    const state = await temporaryRoot();
    const target = join(root, "file.txt");
    await writeFile(target, "before", "utf8");
    const store = await SnapshotStore.open({ allowedRoots: [root], stateDir: state });
    const load = vi
      .spyOn(store, "load")
      .mockRejectedValueOnce(new Error("persisted verification sentinel"));

    await expect(store.create([target], "persisted verification test")).rejects.toThrow(
      /persisted verification sentinel/u,
    );
    const persistedId = load.mock.calls[0]?.[0];
    expect(persistedId).toMatch(/^[0-9]{8}T/u);
    load.mockRestore();
    if (persistedId === undefined) {
      throw new Error("create did not attempt to reload the snapshot");
    }
    await expect(store.load(persistedId)).resolves.toMatchObject({ id: persistedId });
  });

  it("serializes competing mutations for one state directory", async () => {
    const root = await temporaryRoot();
    const state = await temporaryRoot();
    const store = await SnapshotStore.open({ allowedRoots: [root], stateDir: state });
    let releaseGate: (() => void) | undefined;
    let signalEntered: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      releaseGate = resolvePromise;
    });
    const entered = new Promise<void>((resolvePromise) => {
      signalEntered = resolvePromise;
    });
    const holder = store.runMutation(async () => {
      signalEntered?.();
      await gate;
    });
    await entered;

    try {
      await expect(
        store.runMutation(async () => undefined, { retryDelayMs: 5, timeoutMs: 40 }),
      ).rejects.toThrow(/Timed out waiting for the mutation lock/u);
    } finally {
      releaseGate?.();
      await holder;
    }
  });

  it("rejects a state directory whose existing ancestor is a link or junction", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const link = join(root, "state-link");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }

    await expect(
      SnapshotStore.open({ allowedRoots: [root], stateDir: join(link, "nested-state") }),
    ).rejects.toThrow(/symbolic link|junction/u);
  });
});

describe("conditional filesystem mutations", () => {
  it("detects drift injected immediately before the final rename", async () => {
    const root = await temporaryRoot();
    const target = join(root, "file.txt");
    await writeFile(target, "reviewed", "utf8");
    let checks = 0;

    await expect(
      atomicWriteFile(target, Buffer.from("mantle", "utf8"), {
        beforeCommit: async () => {
          checks += 1;
          if (checks === 2) {
            await writeFile(target, "external", "utf8");
          }
        },
        expectedTargetHash: sha256("reviewed"),
      }),
    ).rejects.toBeInstanceOf(FileMutationConflictError);
    expect(checks).toBe(2);
    expect(await readFile(target, "utf8")).toBe("external");
  });

  it("preserves external bytes when conditional rollback sees a conflict", async () => {
    const root = await temporaryRoot();
    const target = join(root, "file.txt");
    await writeFile(target, "external", "utf8");

    await expect(
      rollbackFileIfUnchanged(
        target,
        Buffer.from("original", "utf8"),
        0o600,
        sha256("mantle-commit"),
      ),
    ).rejects.toThrow(/target drifted before commit/u);
    expect(await readFile(target, "utf8")).toBe("external");
  });
});
