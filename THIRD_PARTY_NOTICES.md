# Third-party notices

Runtime and development dependencies are declared in `package.json` and each workspace package.
The lockfile is the authoritative dependency inventory for a release. Run `pnpm licenses list` or
`pnpm license:inventory` after installing dependencies to produce the machine-readable license
inventory at `artifacts/licenses.json`. This file is not a CycloneDX or SPDX SBOM.

Codex Mantle does not contain source code, assets, schemas, or documentation copied from Codey,
Codex++, or OpenCodex. Those products informed problem discovery only; see [INSPIRATION.md](INSPIRATION.md).

OpenAI Codex is a separate project distributed under its own license. Invoking a locally installed
`codex` executable does not incorporate that executable into Codex Mantle.
