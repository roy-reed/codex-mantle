[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexMantle'),
    [switch]$RemoveInstalledVersions
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:MarkerSchemaVersion = 1
$script:MarkerProduct = 'CodexMantle'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Codex Mantle requires PowerShell 7 or later.'
}

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $volumeRoot = [IO.Path]::GetPathRoot($full)
    if (-not $full.Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        $full = $full.TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
    }
    return $full
}

function Assert-NoReparseTraversal {
    param([Parameter(Mandatory)][string]$Path)

    $full = Get-NormalizedPath -Path $Path
    $volumeRoot = [IO.Path]::GetPathRoot($full)
    $current = $volumeRoot
    $relative = $full.Substring($volumeRoot.Length)
    foreach ($segment in $relative.Split(
            @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
            [StringSplitOptions]::RemoveEmptyEntries
        )) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { break }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a path that traverses a reparse point: $current"
        }
    }
    return $full
}

function Assert-SafeInstallRoot {
    param([Parameter(Mandatory)][string]$Path)

    $full = Assert-NoReparseTraversal -Path $Path
    $volumeRoot = [IO.Path]::GetPathRoot($full)
    if ([string]::IsNullOrWhiteSpace($volumeRoot) -or
        $full.Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use a filesystem root as the install directory: $full"
    }
    if (-not (Split-Path -Leaf $full).Equals('CodexMantle', [StringComparison]::Ordinal)) {
        throw "InstallRoot must end with an exact CodexMantle directory: $full"
    }
    return $full
}

function Assert-OwnedInstallRoot {
    param([Parameter(Mandatory)][string]$Root)

    $marker = Join-Path $Root '.codex-mantle-install.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw "Refusing an unmarked install directory: $Root"
    }
    $markerItem = Get-Item -LiteralPath $marker -Force
    if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a reparse-point ownership marker: $marker"
    }
    $markerData = Get-Content -LiteralPath $marker -Raw -Encoding utf8 | ConvertFrom-Json
    $markerRoot = if ($null -eq $markerData.installRoot) { '' } else { Get-NormalizedPath -Path ([string]$markerData.installRoot) }
    if ($markerData.schemaVersion -ne $script:MarkerSchemaVersion -or
        $markerData.product -cne $script:MarkerProduct -or
        -not $markerRoot.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Install ownership marker is invalid: $marker"
    }
}

function Remove-OwnedTreeSafely {
    param([Parameter(Mandatory)][string]$Root)

    $rootItem = Get-Item -LiteralPath $Root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to remove a reparse-point install root: $Root"
    }
    if (-not $rootItem.PSIsContainer) {
        throw "Install root is not a directory: $Root"
    }

    foreach ($child in Get-ChildItem -LiteralPath $Root -Force) {
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            # Package managers legitimately create directory links. Remove the
            # link itself as a leaf and never enumerate or follow its target.
            Remove-Item -LiteralPath $child.FullName -Force
        }
        elseif ($child.PSIsContainer) {
            Remove-OwnedTreeSafely -Root $child.FullName
        }
        else {
            Remove-Item -LiteralPath $child.FullName -Force
        }
    }

    Remove-Item -LiteralPath $Root -Force
}

function Test-PathInside {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Candidate
    )

    $parentFull = Get-NormalizedPath -Path $Parent
    $candidateFull = Get-NormalizedPath -Path $Candidate
    return $candidateFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase) -or
        $candidateFull.StartsWith($parentFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

$installRootFull = Assert-SafeInstallRoot -Path $InstallRoot
$stateRoot = Get-NormalizedPath -Path $(
    if ($env:CODEX_MANTLE_HOME) { $env:CODEX_MANTLE_HOME } else { Join-Path $env:LOCALAPPDATA 'CodexMantle' }
)

if (-not (Test-Path -LiteralPath $installRootFull)) {
    Write-Host "Codex Mantle is not installed at $installRootFull"
    Write-Host "Codex Mantle user state was preserved at $stateRoot"
    return
}

Assert-OwnedInstallRoot -Root $installRootFull

if ($RemoveInstalledVersions) {
    if (Test-PathInside -Parent $installRootFull -Candidate $stateRoot) {
        throw "Refusing to remove the install root because CODEX_MANTLE_HOME is inside it: $stateRoot"
    }
    if ($PSCmdlet.ShouldProcess($installRootFull, 'Remove the marked Codex Mantle install root; preserve external state')) {
        Remove-OwnedTreeSafely -Root $installRootFull
    }
}
else {
    foreach ($launcher in @(
            (Join-Path $installRootFull 'bin\codex-mantle.cmd'),
            (Join-Path $installRootFull 'bin\codex-mantle.ps1')
        )) {
        if (-not (Test-Path -LiteralPath $launcher)) { continue }
        $launcherItem = Get-Item -LiteralPath $launcher -Force
        if ($launcherItem.PSIsContainer -or
            ($launcherItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to remove a launcher that is not a regular file: $launcher"
        }
        if ($PSCmdlet.ShouldProcess($launcher, 'Remove launcher')) {
            Remove-Item -LiteralPath $launcher -Force
        }
    }
}

Write-Host "Codex Mantle user state was preserved at $stateRoot"
