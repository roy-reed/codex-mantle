import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PathBoundary,
  pathIdentityKey,
  resolveCodexHome,
  resolveStateDir,
  samePathIdentity,
} from "../src/index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-mantle-core-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("directory resolution", () => {
  it("uses explicit absolute overrides", () => {
    expect(resolveStateDir({ CODEX_MANTLE_HOME: "C:\\state" }, "win32", "C:\\Users\\<user>")).toBe(
      "C:\\state",
    );
    expect(resolveCodexHome({ CODEX_HOME: "C:\\codex" }, "C:\\Users\\<user>")).toBe("C:\\codex");
  });

  it("rejects relative overrides", () => {
    expect(() => resolveStateDir({ CODEX_MANTLE_HOME: "relative" })).toThrow(/absolute/u);
    expect(() => resolveCodexHome({ CODEX_HOME: "relative" })).toThrow(/absolute/u);
  });
});

describe("PathBoundary", () => {
  it("treats Windows case aliases as one identity without folding POSIX paths", () => {
    const mixedCase = "C:\\Users\\USERNAME\\.codex\\AGENTS.md";
    const lowerCase = "c:\\users\\username\\.CODEX\\agents.md";

    expect(pathIdentityKey(mixedCase, "win32")).toBe(pathIdentityKey(lowerCase, "win32"));
    expect(samePathIdentity(mixedCase, lowerCase, "win32")).toBe(true);
    expect(samePathIdentity("/repo/AGENTS.md", "/repo/agents.md", "linux")).toBe(false);
  });

  it("accepts missing file targets under a real root and rejects escapes", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "nested"));
    const boundary = await PathBoundary.create(root);

    await expect(boundary.assert(join(root, "nested", "future.txt"))).resolves.toBe(
      join(root, "nested", "future.txt"),
    );
    await expect(boundary.assert(join(root, "..", "outside.txt"))).rejects.toThrow(/escapes/u);
    expect(() => boundary.resolve("../outside.txt")).toThrow(/Unsafe/u);
  });

  it("rejects a symbolic link or junction anywhere in the target path", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "private.txt"), "outside", "utf8");
    const link = join(root, "link");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }

    const boundary = await PathBoundary.create(root);
    await expect(boundary.assert(join(link, "private.txt"))).rejects.toThrow(
      /Symbolic links|junctions/u,
    );

    await mkdir(join(outside, "nested"));
    await expect(PathBoundary.create(join(link, "nested"))).rejects.toThrow(
      /Symbolic link|symbolic link|junction/u,
    );
  });
});
