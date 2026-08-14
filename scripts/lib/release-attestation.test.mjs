import { describe, expect, it } from "vitest";
import {
  RELEASE_COMMIT_BINDING,
  REQUIRED_PREPUBLICATION_GATES,
  validateReleaseAttestation,
} from "./release-attestation.mjs";

const version = "0.1.0-alpha.1";

function fixture({
  status = "draft candidate",
  releaseCommit = "pending until the candidate is committed",
  outcome = "pending",
} = {}) {
  const rows = REQUIRED_PREPUBLICATION_GATES.map((gate) => `| ${gate} | ${outcome} |`).join("\n");
  return `# v${version} release attestation

- Status: ${status}
- Candidate date: 2026-08-15
- Release commit: ${releaseCommit}
- Host: Windows 11
- PowerShell: 7.6.3
- Node.js: 24.19.0
- pnpm: 11.19.0
- Codex CLI: 0.147.0-alpha.1.2
- Tested Codex allowlist: 0.147.x

## Pre-publication evidence

| Gate | Outcome |
| --- | --- |
${rows}

## Post-publication evidence

Pending publication.

## Known limitations

- Alpha release.
`;
}

describe("release attestation validation", () => {
  it("accepts a well-formed draft", () => {
    expect(validateReleaseAttestation(fixture(), { version })).toEqual([]);
  });

  it("accepts only a fully passed, workflow-bound release candidate", () => {
    expect(
      validateReleaseAttestation(
        fixture({
          status: "release candidate",
          releaseCommit: RELEASE_COMMIT_BINDING,
          outcome: "passed",
        }),
        { version, release: true },
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "duplicate status",
      (text) =>
        text.replace(
          "- Status: draft candidate",
          "- Status: draft candidate\n- Status: release candidate",
        ),
    ],
    ["impossible date", (text) => text.replace("2026-08-15", "2026-99-99")],
    ["fenced counterfeit", (text) => `${text}\n\`\`\`\n- Status: release candidate\n\`\`\`\n`],
    ["prefixed outcome", (text) => text.replace("| pending |", "| passed pending final rerun |")],
    [
      "duplicate gate",
      (text) =>
        text.replace(
          "| `pnpm check` | pending |",
          "| `pnpm check` | pending |\n| `pnpm check` | passed |",
        ),
    ],
  ])("rejects %s", (_label, mutate) => {
    expect(validateReleaseAttestation(mutate(fixture()), { version })).not.toEqual([]);
  });

  it("rejects a release candidate with pending gates", () => {
    const errors = validateReleaseAttestation(
      fixture({ status: "release candidate", releaseCommit: RELEASE_COMMIT_BINDING }),
      { version, release: true },
    );
    expect(errors.some((error) => error.includes("gate must be passed"))).toBe(true);
  });
});
