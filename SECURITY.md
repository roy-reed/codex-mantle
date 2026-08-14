# Security Policy

## Supported versions

Until 1.0, only the latest minor release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability
reporting for this repository. Include affected versions, reproduction steps, impact, and any
suggested mitigation. Do not include real credentials or private workspace content.

## Security boundaries

- The server binds to loopback only and validates `Host` and `Origin`. The v0.1 API is read-only;
  a per-process CSRF token is reserved for any future mutation endpoints.
- Profile operations are constrained to explicit Codex or project roots.
- Existing targets and path ancestors are checked for symlink escape.
- Apply requires a non-stale plan and a verified snapshot.
- Restore requires explicit approval.
- Plugin manifests are data only in v0.1; third-party code is not loaded.
- Provider credentials are out of scope and must never be stored in a policy pack.

`pnpm repository:scan` is a bounded credential/private-path heuristic, not a security audit. It skips
symlinks, binary files, generated directories, and files larger than 2 MB. Reviews and dedicated
security tooling remain necessary for security-sensitive changes.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for assumptions and known limitations.
