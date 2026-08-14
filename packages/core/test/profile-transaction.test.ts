import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPlan,
  buildProfilePlan,
  getPlanApprovalId,
  loadProfilePack,
  type MutationPlan,
  TransactionError,
  verifyPlan,
} from "../src/index.js";

const temporaryRoots: string[] = [];

// SnapshotStore.open performs fail-closed Windows ACL hardening in a separate
// system PowerShell process; allow for cold startup without weakening checks.
vi.setConfig({ hookTimeout: 15_000, testTimeout: 15_000 });

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-mantle-profile-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture(): Promise<{
  codexHome: string;
  manifest: string;
  original: Buffer;
  state: string;
  target: string;
}> {
  const packDir = await temporaryRoot();
  const codexHome = await temporaryRoot();
  const state = await temporaryRoot();
  const sourceDir = join(packDir, "files");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "rules.md"), "managed rule\n", "utf8");
  const manifest = join(packDir, "profile.json");
  await writeFile(
    manifest,
    `${JSON.stringify(
      {
        files: [
          {
            blockId: "evidence-first",
            path: "AGENTS.md",
            source: "files/rules.md",
            strategy: "managed-block",
            target: "codex-home",
          },
        ],
        id: "evidence-first",
        name: "Evidence First",
        schemaVersion: 1,
        version: "0.1.0",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const target = join(codexHome, "AGENTS.md");
  const original = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("personal\r\n", "utf8"),
  ]);
  await writeFile(target, original);
  return { codexHome, manifest, original, state, target };
}

describe("profile plans and transactions", () => {
  it("loads a bounded source, plans exact bytes, and applies after approval", async () => {
    const data = await fixture();
    const pack = await loadProfilePack(data.manifest);
    const plan = await buildProfilePlan(pack, { codexHome: data.codexHome });

    expect(plan.operations).toHaveLength(1);
    await expect(verifyPlan(plan)).resolves.toMatchObject({ changes: [{ target: data.target }] });
    const result = await applyPlan(plan, {
      approvalId: getPlanApprovalId(plan),
      stateDir: data.state,
    });

    expect(result.snapshotId).not.toBeNull();
    const changed = await readFile(data.target);
    expect(changed.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(changed.toString("utf8")).toContain("managed rule\r\n");
  });

  it("refuses stale plans before creating a snapshot", async () => {
    const data = await fixture();
    const plan = await buildProfilePlan(await loadProfilePack(data.manifest), {
      codexHome: data.codexHome,
    });
    await writeFile(data.target, "external edit", "utf8");

    await expect(
      applyPlan(plan, { approvalId: getPlanApprovalId(plan), stateDir: data.state }),
    ).rejects.toThrow(/stale/u);
    expect(await readFile(data.target, "utf8")).toBe("external edit");
  });

  it("restores exact original bytes when domain verification fails", async () => {
    const data = await fixture();
    const plan = await buildProfilePlan(await loadProfilePack(data.manifest), {
      codexHome: data.codexHome,
    });

    await expect(
      applyPlan(plan, {
        approvalId: getPlanApprovalId(plan),
        stateDir: data.state,
        verify: () => false,
      }),
    ).rejects.toBeInstanceOf(TransactionError);
    expect(await readFile(data.target)).toEqual(data.original);
  });

  it("restores every original in a multi-file transaction failure", async () => {
    const data = await fixture();
    const secondTarget = join(data.codexHome, "config.toml");
    const secondOriginal = Buffer.from("personal = true\r\n", "utf8");
    await writeFile(secondTarget, secondOriginal);
    const manifest = JSON.parse(await readFile(data.manifest, "utf8")) as {
      files: Record<string, unknown>[];
    };
    manifest.files.push({
      blockId: "second-file",
      content: "managed = true\n",
      path: "config.toml",
      strategy: "managed-block",
      target: "codex-home",
    });
    await writeFile(data.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const plan = await buildProfilePlan(await loadProfilePack(data.manifest), {
      codexHome: data.codexHome,
    });
    expect(plan.operations).toHaveLength(2);

    await expect(
      applyPlan(plan, {
        approvalId: getPlanApprovalId(plan),
        stateDir: data.state,
        verify: () => false,
      }),
    ).rejects.toBeInstanceOf(TransactionError);
    expect(await readFile(data.target)).toEqual(data.original);
    expect(await readFile(secondTarget)).toEqual(secondOriginal);
  });

  it("preserves an external edit that conflicts with automatic rollback", async () => {
    const data = await fixture();
    const plan = await buildProfilePlan(await loadProfilePack(data.manifest), {
      codexHome: data.codexHome,
    });
    const external = "external after Mantle commit";

    let failure: unknown;
    try {
      await applyPlan(plan, {
        approvalId: getPlanApprovalId(plan),
        stateDir: data.state,
        verify: async () => {
          await writeFile(data.target, external, "utf8");
          return false;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TransactionError);
    expect((failure as TransactionError).rollbackError).toBeDefined();
    expect(String((failure as TransactionError).rollbackError)).toMatch(/drifted/u);
    expect(await readFile(data.target, "utf8")).toBe(external);
  });

  it("rejects duplicate targets expressed through overlapping roots", async () => {
    const data = await fixture();
    const workspace = join(data.codexHome, "workspace");
    await mkdir(workspace);
    const manifest = JSON.parse(await readFile(data.manifest, "utf8")) as {
      files: Record<string, unknown>[];
    };
    manifest.files = [
      {
        blockId: "via-codex-root",
        content: "one\n",
        path: "workspace/AGENTS.md",
        strategy: "managed-block",
        target: "codex-home",
      },
      {
        blockId: "via-workspace-root",
        content: "two\n",
        path: "AGENTS.md",
        strategy: "managed-block",
        target: "workspace",
      },
    ];
    await writeFile(data.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(
      buildProfilePlan(await loadProfilePack(data.manifest), {
        codexHome: data.codexHome,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/duplicate target/u);
  });

  it("rejects approval mismatch and digest tampering", async () => {
    const data = await fixture();
    const plan = await buildProfilePlan(await loadProfilePack(data.manifest), {
      codexHome: data.codexHome,
    });

    await expect(applyPlan(plan, { approvalId: "wrong", stateDir: data.state })).rejects.toThrow(
      /approval/u,
    );
    const tampered = structuredClone(plan) as MutationPlan;
    const firstOperation = tampered.operations[0];
    if (firstOperation === undefined) {
      throw new Error("fixture plan has no operations");
    }
    firstOperation.contentBase64 = Buffer.from("tampered").toString("base64");
    await expect(verifyPlan(tampered)).rejects.toThrow(/digest/u);
  });
});
