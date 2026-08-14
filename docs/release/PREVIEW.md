# Preview release checklist

Preview releases are created only by pushing an alpha tag that exactly matches the root package version. If `package.json` contains `0.1.0-alpha.1`, the only accepted tag is `v0.1.0-alpha.1`.

## Before tagging

1. Confirm the worktree contains only intended release changes and no credentials, local state, generated archives, or private paths.
2. Run `pnpm install --frozen-lockfile` with Node.js 22 or later and the pinned pnpm 11.x version.
3. Run `pnpm version:check` and `pnpm check`.
4. On Windows PowerShell 7, run `pwsh -NoProfile -File .\scripts\Test-WindowsAcceptance.ps1 -SourceMode GitArchive` against the release commit and record that exact gate in the attestation.
5. Run `pwsh -NoProfile -File .\scripts\Test-ProfileAcceptance.ps1` with a real allowlisted Codex CLI and add the sanitized result under [attestations](./attestations/README.md).
6. Confirm third-party actions remain pinned according to [ACTION_PINS.md](./ACTION_PINS.md).
7. Set the attestation status to `release candidate`, use the documented release-commit binding,
   and record every required pre-publication gate as the exact outcome `passed`.
8. Run `pnpm version:check:release` as the final metadata preflight against the current full Git
   `HEAD`. The tagged workflow additionally passes the independently resolved tag target through
   `--expected-commit` and requires an exact match.
9. Create and push the exact version tag only after the release commit is on `main`.

## Automated release gate

The preview workflow independently enforces tag/package/core/changelog version equality, validates
unique attestation metadata and exact gate outcomes, verifies the checkout `HEAD` exactly matches the
full tag-target SHA and that the commit is on `main`, and reruns the Windows
archive acceptance gate. Repository code runs with read-only contents permission and without
persisted checkout credentials. A separate final job alone receives `contents: write`; immediately
before publication it resolves the public remote tag again and refuses a changed target. The source
job runs the full repository check and publishes:

- `codex-mantle-source.zip`, produced from the tagged Git tree;
- `licenses.json`;
- `SHA256SUMS` covering both files.

The GitHub release is marked as a prerelease and receives generated notes. A failed tag check, Windows acceptance, repository check, source archive, license inventory, or checksum step prevents publication.

## After publication

Download the artifacts from GitHub, verify `SHA256SUMS`, and perform one clean archive install on
Windows. Add a short post-publication result to the corresponding attestation. Record known
limitations in the release notes. Correct a bad release with a new version and tag; do not silently
move a published tag.
