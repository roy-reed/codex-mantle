# Threat model

## Assets

- Codex and project instruction files;
- byte-exact backups and transaction metadata;
- local workspace structure and configuration values;
- the user's ability to recover from a failed or stale write.

Provider credentials, Codex authentication, browser sessions, and private Codex databases are outside
the product boundary and must not be read.

## Trust boundaries

The local user, a reviewed profile pack, and Mantle's own packaged code are trusted for the requested
operation. Browser pages, repository contents, plugin manifests, path strings, subprocess output, and
the installed Codex version are untrusted inputs.

## Invariants

1. The HTTP service accepts loopback bindings only and rejects foreign `Host` and `Origin` values.
2. HTTP mutations are absent in v0.1; future write endpoints must require an unguessable per-process
   token in addition to command-level approval.
3. File operations are constrained to canonical explicit roots and reject symlink or junction escape.
4. A plan is invalid after its destination hash changes.
5. Apply cannot begin until the original bytes have been snapshotted and verified.
6. Restore is explicit and refuses drift by default.
7. Child processes receive argument arrays and run without a shell.
8. Logs, API responses, tests, and fixtures contain no tokens or real user configuration.
9. v0.1 never executes third-party plugin code.

## Abuse cases and controls

| Abuse case | Control | Verification |
| --- | --- | --- |
| Drive-by website calls localhost | Host/Origin checks, no CORS, no v0.1 write endpoints | HTTP security tests |
| `..` or junction escapes a root | canonical boundary plus ancestor link checks | path fixtures |
| File changes after preview | SHA-256 precondition | stale-plan test |
| Partial multi-file failure | verified snapshot and reverse rollback | injected failure test |
| Malicious profile executes code | strict data schema; payload read as bytes only | unknown-field tests |
| CLI argument injects a command | `spawn` with `shell: false` | process tests |
| Unknown Codex release is treated as writable | capability probe defaults to read-only | adapter test |
| Backup silently corrupts data | payload hash and size verification | round-trip tests |

## Known alpha limitations

- Portable filesystem replacement cannot promise power-loss atomicity on every filesystem.
- On local NTFS volumes, Mantle-owned snapshot and lock directories are ACL-hardened and verified so
  access is limited to the current user, `SYSTEM`, and `Administrators`. Protected operations fail
  closed on non-NTFS volumes, network shares, or when Windows ACL tooling or verification fails.
- The dashboard is status-only; write endpoints are intentionally absent.
- UTF-16 and legacy encodings are rejected rather than rewritten.
- Outside the verified local NTFS boundary, no confidentiality guarantee is made; concurrently
  modified directories also remain unsupported.

Report suspected vulnerabilities through GitHub private vulnerability reporting as described in
[SECURITY.md](../SECURITY.md).
