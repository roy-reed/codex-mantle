# Windows installation and removal

## Requirements

- Windows 10 or later;
- PowerShell 7 (`pwsh`), not Windows PowerShell 5.1;
- Node.js 22 or later;
- pnpm major version 11.

Administrator rights are neither required nor requested. Git is optional for an extracted source archive and is needed only for source-control workflows.

## Install from a checkout or source archive

Run the installer at the repository root:

```powershell
pwsh -NoProfile -File .\scripts\Install-CodexMantle.ps1
```

An archive does not need `.git` or preinstalled `node_modules`. When dependencies are absent or incomplete, the installer runs `pnpm install --frozen-lockfile`. It then runs the repository checks, builds the workspaces, deploys a production CLI, and copies the dashboard into a versioned user-local directory under `%LOCALAPPDATA%\Programs\CodexMantle`.

`-SkipChecks` skips the full repository check but still builds the product. It exists for the bounded acceptance gate and is not the recommended release-install path.

The installer writes both `codex-mantle.ps1` and `codex-mantle.cmd` under the install root's `bin` directory. It does not edit Codex configuration, PATH, PowerShell profiles, user state, or machine-wide registry keys. Add the printed `bin` directory to the user PATH manually if desired.

## Ownership and path safety

The install root must have the exact, case-sensitive leaf name `CodexMantle`. Filesystem roots, reparse-point traversal, and non-empty unmarked directories are rejected.

The installer owns a root only after creating `.codex-mantle-install.json` with this identity:

```json
{
  "schemaVersion": 1,
  "product": "CodexMantle",
  "installRoot": "<normalized exact install root>"
}
```

Upgrades publish a distinct version directory before replacing either launcher. If launcher publication fails, only that attempt's version and launcher backups are removed; the previously published launchers, versions, and external state are preserved.

## Uninstall

Default removal deletes both launchers but keeps versioned application files and state:

```powershell
pwsh -NoProfile -File .\scripts\Uninstall-CodexMantle.ps1
```

Full application removal requires the exact marked root. The root path and ownership marker reject reparse points; package-manager links inside the owned tree are unlinked as leaf entries and are never followed to their targets:

```powershell
pwsh -NoProfile -File .\scripts\Uninstall-CodexMantle.ps1 -RemoveInstalledVersions
```

The full mode never removes the external state directory. It also refuses to proceed when `CODEX_MANTLE_HOME` resolves inside the install root. Remove state separately only after reviewing and backing it up.

## State

User state lives at `%LOCALAPPDATA%\CodexMantle` unless `CODEX_MANTLE_HOME` is set. Installation, upgrade, default removal, and full application removal preserve that directory.

## Windows acceptance gate

The end-to-end gate uses an isolated temporary root whose path contains Chinese characters and spaces. It creates an archive-equivalent source without `.git` or dependencies, runs the repository safety scan, installs twice to exercise the upgrade boundary, injects a failure after launcher publication and verifies rollback, executes `doctor`, starts the dashboard and checks `/api/v1/health`, exercises both uninstall modes, and verifies unrelated directories and external state are unchanged.

```powershell
# Complete checks before installation
pwsh -NoProfile -File .\scripts\Test-WindowsAcceptance.ps1 -SourceMode Auto

# Faster CI gate; installation still builds all product workspaces
pwsh -NoProfile -File .\scripts\Test-WindowsAcceptance.ps1 -Fast -SourceMode GitArchive
```

`GitArchive` requires a committed `HEAD`; `SafeCopy` provides the equivalent test for an uncommitted working tree without following reparse points. `Auto` selects between them. Temporary artifacts are removed only after their exact generated root is validated; use `-KeepArtifacts` only for diagnosis.
