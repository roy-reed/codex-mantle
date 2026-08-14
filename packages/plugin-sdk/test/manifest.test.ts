import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  isValidSemverRange,
  PluginManifestValidationError,
  parsePluginManifest,
  parsePluginManifestJson,
  validatePluginManifest,
} from "../src/index.js";

const validManifest = {
  schemaVersion: 1,
  id: "evidence-first",
  name: "Evidence First",
  version: "1.0.0",
  description: "Adds a bounded evidence-first collaboration profile.",
  license: "Apache-2.0",
  repository: "https://github.com/example/evidence-first",
  compatibility: { mantle: "^0.1.0", codexSeries: ["0.147"] },
  contributions: {
    profiles: [
      {
        id: "default",
        title: "Default profile",
        files: [
          {
            source: "profiles/default/AGENTS.md",
            target: { scope: "workspace", path: "AGENTS.md" },
            strategy: "managed-block",
            marker: "evidence-first",
          },
        ],
      },
    ],
  },
} as const;

describe("plugin manifest validation", () => {
  it("accepts a versioned, declarative manifest", () => {
    expect(parsePluginManifest(validManifest)).toEqual(validManifest);
  });

  it.each([
    "^0.1.0",
    ">=0.1.0 <1.0.0",
    ">= 0.1.0 < 1.0.0",
    "1.2.x || >=2.0.0",
    "1.2.3 - 2.0.0",
    "1.2.3-beta.1+build.7",
  ])("accepts the semantic-version range %s", (range) => {
    expect(isValidSemverRange(range)).toBe(true);
    expect(
      validatePluginManifest({
        ...validManifest,
        compatibility: { ...validManifest.compatibility, mantle: range },
      }).success,
    ).toBe(true);
  });

  it.each(["latest", "^", "1..2", "1.2.3 ||", ">=1.2.3 garbage", "01.2.3"])(
    "rejects the invalid semantic-version range %s",
    (range) => {
      expect(isValidSemverRange(range)).toBe(false);
      expect(
        validatePluginManifest({
          ...validManifest,
          compatibility: { ...validManifest.compatibility, mantle: range },
        }).success,
      ).toBe(false);
    },
  );

  it("validates the shipped data-only plugin example", async () => {
    const manifest = await readFile(
      new URL("../../../examples/plugins/evidence-first/codex-mantle.plugin.json", import.meta.url),
      "utf8",
    );

    expect(parsePluginManifestJson(manifest)).toMatchObject({
      id: "evidence-first",
      compatibility: { mantle: "^0.1.0" },
    });
  });

  it.each(["executable", "html", "shell", "scripts", "hooks"])(
    "rejects the forbidden field %s at any nesting depth",
    (field) => {
      const manifest = structuredClone(validManifest) as Record<string, unknown>;
      manifest.contributions = {
        ...(manifest.contributions as Record<string, unknown>),
        extra: { [field]: "payload" },
      };
      const result = validatePluginManifest(manifest);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.issues[0]?.code).toBe("forbidden-field");
    },
  );

  it("rejects unknown fields even when they are not executable", () => {
    const result = validatePluginManifest({ ...validManifest, color: "blue" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues.some((issue) => issue.code === "schema")).toBe(true);
  });

  it("rejects traversal, scripts, and HTML file targets", () => {
    for (const path of ["../AGENTS.md", "tools/install.ps1", "dashboard/index.html"]) {
      const manifest = structuredClone(validManifest);
      manifest.contributions.profiles[0].files[0].source = path;
      expect(validatePluginManifest(manifest).success).toBe(false);
    }
  });

  it("reports invalid JSON without echoing its contents", () => {
    expect(() => parsePluginManifestJson('{"token":"secret"')).toThrow(
      PluginManifestValidationError,
    );
    try {
      parsePluginManifestJson('{"token":"secret"');
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});
