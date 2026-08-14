# Compatibility policy

## Supported surface

The alpha supports Node.js 22+, Git, and local files on Windows, Linux, and macOS. PowerShell 7 is a
recommended Windows dependency and part of `doctor`; it is not used to parse or rewrite Codex files.

Mantle targets public Codex surfaces:

- global and project instruction/configuration files explicitly selected by the user;
- the installed `codex` executable and its public CLI help/version output;
- `codex app-server generate-json-schema` when the installed executable advertises it.

It does not edit authentication files, internal SQLite databases, cached conversations, or renderer
state. Codex configuration precedence is documented by OpenAI in
[Codex configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic).

## Compatibility outcomes

| Outcome | Meaning | Profile writes |
| --- | --- | --- |
| unknown | Codex cannot be invoked or its version output cannot be parsed | disabled |
| limited | Codex responds, but its series is untested or a required output contract fails | disabled |
| compatible | required output contracts pass and the release series is allowlisted | enabled only through the explicit plan/apply workflow |

Individual capability signals use `available`, `degraded`, `unavailable`, or `unknown`. Version text is
recorded as evidence but is never sufficient on its own. Preview and future versions therefore
degrade safely instead of being guessed compatible.

The initial tested allowlist is Codex `0.147.x`. This narrow alpha gate is intentional: adding a new
series requires probe fixtures, the full repository check, and the release acceptance matrix. It does
not imply support for every private or experimental feature in that series.

## Support matrix

Repository CI runs the platform-independent check on current Windows, Ubuntu, and macOS runners.
Core tests deterministically cover stale plans, restore drift, and interrupted configuration
transactions. Windows archive acceptance separately covers PowerShell 7, Unicode and spaced paths,
installer rollback, health, upgrade, and uninstall using an intentionally incompatible CLI stand-in.

Before a preview tag, a maintainer must also run `scripts/Test-ProfileAcceptance.ps1` with an actual
Codex CLI from the allowlisted series. That test uses an isolated temporary Codex home and workspace;
it proves capability gating, stale-plan refusal, apply, drift refusal, and byte-exact restore. The
sanitized result belongs in `docs/release/attestations/`. These three evidence layers are independent;
none is described as proving the others.

Generated app-server schemas are written only to an explicit, existing, empty directory chosen by the
caller. Mantle does not cache or publish machine-generated schemas in v0.1.
