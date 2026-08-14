# Release attestations

Each preview release keeps one concise Markdown record named after the version, for example
`v0.1.0-alpha.1.md`. Metadata fields and evidence rows must be unique. Evidence outcomes are the
exact enum `pending`, `passed`, or `failed`; explanatory detail belongs in prose below the table.
Release mode requires every pre-publication row to be `passed` and the Release commit field to read
`bound to the immutable tag target by the release workflow`. The exact SHA cannot self-reference
inside its own commit, so release-mode validation resolves the full checkout `HEAD`; the tagged
workflow additionally supplies the independently resolved tag target and requires an exact match.
The post-publication update on `main` records the resolved SHA. The record contains only sanitized evidence:

- date, release commit, operating-system family, PowerShell, Node, pnpm, and Codex versions;
- commands executed and pass/fail outcomes;
- real-Codex capability outcome and the tested allowlist series;
- Windows archive, stale-plan, apply, restore-drift, and byte-exact restore results;
- post-publication checksum and clean-install result;
- known limitations.

Never include usernames, absolute home paths, access tokens, private instructions, workspace content,
or generated machine-specific schemas. Attestations are evidence for one candidate, not a permanent
compatibility promise.
