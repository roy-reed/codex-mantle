import { describe, expect, it } from "vitest";
import { validateReleaseCommit } from "./release-commit.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("release commit validation", () => {
  it("accepts a full checkout commit without an external expectation", () => {
    expect(validateReleaseCommit({ head: commit })).toEqual([]);
  });

  it("accepts an exact externally bound tag target", () => {
    expect(validateReleaseCommit({ head: commit, expected: commit.toUpperCase() })).toEqual([]);
  });

  it.each([
    ["abbreviated checkout", { head: commit.slice(0, 12) }],
    ["abbreviated expectation", { head: commit, expected: commit.slice(0, 12) }],
    ["different tag target", { head: commit, expected: `f${commit.slice(1)}` }],
  ])("rejects %s", (_label, input) => {
    expect(validateReleaseCommit(input)).not.toEqual([]);
  });
});
