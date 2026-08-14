# Contributing

Thank you for improving Codex Mantle. Small, testable changes are preferred over broad rewrites.
Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). See [SUPPORT.md](SUPPORT.md)
for support and security routing, and [GOVERNANCE.md](GOVERNANCE.md) for decision rules.

## Development setup

1. Install Node.js 22+ and pnpm 11.x (the repository pins 11.19.0).
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm check` before opening a pull request.

## Change contract

Every behavior change should identify:

- the target scenario;
- an existing scenario that must not regress;
- the path or security invariant it preserves;
- objective verification evidence.

Changes to file writes, restore behavior, path validation, remote binding, plugin execution, or
credential handling require a threat-model update and focused tests.

## Compatibility

Do not infer support from a Codex version string alone. Prefer capability probes. Keep experimental
protocol support behind the adapter boundary and make unknown capability sets read-only.

## Pull requests

- Keep unrelated changes out of the branch.
- Never commit personal instructions, tokens, generated user schemas, absolute home paths, or real
  workspace data.
- Add or update tests for behavior changes.
- Update `CHANGELOG.md` for user-visible changes.

AI-assisted development is allowed, but the author remains responsible for reviewing the patch,
checking provenance, and supplying deterministic acceptance evidence. External model reviewers must
work in an isolated branch or worktree with a narrow write allowlist; their conclusions never replace
maintainer acceptance.

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
