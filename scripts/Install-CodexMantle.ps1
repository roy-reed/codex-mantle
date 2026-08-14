[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexMantle'),
    [switch]$SkipChecks,
    [ValidateSet('None', 'AfterLaunchersPublished')]
    [string]$AcceptanceFailurePoint = 'None'
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

function Assert-PathWithin {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Child,
        [Parameter(Mandatory)][string]$Label
    )

    $parentFull = Get-NormalizedPath -Path $Parent
    $childFull = Get-NormalizedPath -Path $Child
    $prefix = $parentFull + [IO.Path]::DirectorySeparatorChar
    if (-not $childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing $Label outside its expected parent: $childFull"
    }
    return $childFull
}

function Assert-OwnershipMarker {
    param(
        [Parameter(Mandatory)][string]$MarkerPath,
        [Parameter(Mandatory)][string]$ExpectedRoot
    )

    $markerItem = Get-Item -LiteralPath $MarkerPath -Force
    if (-not $markerItem.PSIsContainer -and
        ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        $markerData = Get-Content -LiteralPath $MarkerPath -Raw -Encoding utf8 | ConvertFrom-Json
        $markerRoot = if ($null -eq $markerData.installRoot) { '' } else { Get-NormalizedPath -Path ([string]$markerData.installRoot) }
        if ($markerData.schemaVersion -eq $script:MarkerSchemaVersion -and
            $markerData.product -ceq $script:MarkerProduct -and
            $markerRoot.Equals($ExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }
    throw "Install ownership marker is invalid: $MarkerPath"
}

function Resolve-ApplicationPath {
    param([Parameter(Mandatory)][string]$Name)

    $command = Get-Command $Name -CommandType Application -ErrorAction Stop |
        Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw "Required application was not found: $Name"
    }
    return [string]$command.Source
}

function Assert-Toolchain {
    $nodePath = Resolve-ApplicationPath -Name 'node'
    $pnpmPath = Resolve-ApplicationPath -Name 'pnpm'

    $nodeVersion = (& $nodePath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(?<major>\d+)(?:\.|$)' -or [int]$Matches.major -lt 22) {
        throw "Node.js 22 or later is required; reported version: $nodeVersion"
    }

    $pnpmVersion = (& $pnpmPath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pnpmVersion -notmatch '^(?<major>\d+)(?:\.|$)' -or [int]$Matches.major -ne 11) {
        throw "pnpm major version 11 is required; reported version: $pnpmVersion"
    }

    return [ordered]@{ Node = $nodePath; Pnpm = $pnpmPath }
}

function Test-RepositoryDependenciesReady {
    param([Parameter(Mandatory)][string]$RepositoryRoot)

    $required = @(
        (Join-Path $RepositoryRoot 'node_modules\.modules.yaml'),
        (Join-Path $RepositoryRoot 'node_modules\.bin\tsc.cmd'),
        (Join-Path $RepositoryRoot 'node_modules\.bin\biome.cmd'),
        (Join-Path $RepositoryRoot 'apps\cli\node_modules\commander'),
        (Join-Path $RepositoryRoot 'apps\web\node_modules\vite')
    )
    return -not ($required | Where-Object { -not (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

function Remove-InstallChild {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedParent,
        [Parameter(Mandatory)][string]$Label
    )

    $safePath = Assert-PathWithin -Parent $ExpectedParent -Child $Path -Label $Label
    $null = Assert-NoReparseTraversal -Path $safePath
    if (Test-Path -LiteralPath $safePath) {
        Remove-TreeWithoutFollowingLinks -Root $safePath
    }
}

function Remove-TreeWithoutFollowingLinks {
    param([Parameter(Mandatory)][string]$Root)

    $rootItem = Get-Item -LiteralPath $Root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to recursively remove a reparse-point root: $Root"
    }
    if (-not $rootItem.PSIsContainer) {
        Remove-Item -LiteralPath $Root -Force
        return
    }

    foreach ($child in Get-ChildItem -LiteralPath $Root -Force) {
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Remove-Item -LiteralPath $child.FullName -Force
        }
        elseif ($child.PSIsContainer) {
            Remove-TreeWithoutFollowingLinks -Root $child.FullName
        }
        else {
            Remove-Item -LiteralPath $child.FullName -Force
        }
    }
    Remove-Item -LiteralPath $Root -Force
}

$repositoryRoot = Get-NormalizedPath -Path (Split-Path -Parent $PSScriptRoot)
$packageFile = Join-Path $repositoryRoot 'package.json'
$package = Get-Content -LiteralPath $packageFile -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'package.json does not contain a version.' }

$toolchain = Assert-Toolchain
$nodePath = [string]$toolchain.Node
$pnpmPath = [string]$toolchain.Pnpm
$installRootFull = Assert-SafeInstallRoot -Path $InstallRoot
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$versionsRoot = Join-Path $installRootFull 'versions'
$binRoot = Join-Path $installRootFull 'bin'
$finalRoot = Join-Path $versionsRoot "$version-$timestamp-$PID"
$stagingRoot = Join-Path $installRootFull ".staging-$PID-$timestamp"
$marker = Join-Path $installRootFull '.codex-mantle-install.json'
$launcher = Join-Path $binRoot 'codex-mantle.cmd'
$powerShellLauncher = Join-Path $binRoot 'codex-mantle.ps1'
$launcherTemporary = "$launcher.$PID.tmp"
$powerShellLauncherTemporary = "$powerShellLauncher.$PID.tmp"
$createdFinalRoot = $false
$locationPushed = $false
$launcherState = @()

if (Test-Path -LiteralPath $installRootFull) {
    if (Test-Path -LiteralPath $marker) {
        Assert-OwnershipMarker -MarkerPath $marker -ExpectedRoot $installRootFull
    }
    elseif (Get-ChildItem -LiteralPath $installRootFull -Force | Select-Object -First 1) {
        throw "Refusing to adopt a non-empty directory without a Codex Mantle ownership marker: $installRootFull"
    }
}

Push-Location $repositoryRoot
$locationPushed = $true
try {
    if (-not (Test-RepositoryDependenciesReady -RepositoryRoot $repositoryRoot)) {
        Write-Host 'Workspace dependencies are missing; installing from the lockfile.'
        & $pnpmPath install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE." }
        if (-not (Test-RepositoryDependenciesReady -RepositoryRoot $repositoryRoot)) {
            throw 'pnpm install completed, but required workspace dependencies are still missing.'
        }
    }

    if (-not $SkipChecks) {
        & $pnpmPath check
        if ($LASTEXITCODE -ne 0) { throw "Repository checks failed with exit code $LASTEXITCODE." }
    }
    else {
        & $pnpmPath build
        if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
    }

    $null = New-Item -ItemType Directory -Path $installRootFull -Force
    $installRootFull = Assert-SafeInstallRoot -Path $installRootFull

    if (Test-Path -LiteralPath $marker) {
        Assert-OwnershipMarker -MarkerPath $marker -ExpectedRoot $installRootFull
    }
    elseif (Get-ChildItem -LiteralPath $installRootFull -Force | Select-Object -First 1) {
        throw "Refusing to adopt a non-empty directory without a Codex Mantle ownership marker: $installRootFull"
    }
    else {
        $markerTemporary = "$marker.$PID.tmp"
        [ordered]@{
            schemaVersion = $script:MarkerSchemaVersion
            product = $script:MarkerProduct
            installRoot = $installRootFull
            createdAt = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json | Set-Content -LiteralPath $markerTemporary -Encoding utf8
        Move-Item -LiteralPath $markerTemporary -Destination $marker
        Assert-OwnershipMarker -MarkerPath $marker -ExpectedRoot $installRootFull
    }

    $null = New-Item -ItemType Directory -Path $versionsRoot, $binRoot -Force
    $null = Assert-NoReparseTraversal -Path $versionsRoot
    $null = Assert-NoReparseTraversal -Path $binRoot

    & $pnpmPath --filter '@codex-mantle/cli' deploy --prod $stagingRoot
    if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed with exit code $LASTEXITCODE." }

    $webSource = Join-Path $repositoryRoot 'apps\web\dist'
    if (-not (Test-Path -LiteralPath $webSource -PathType Container)) {
        throw "Built dashboard is missing: $webSource"
    }
    $webDestination = Join-Path $stagingRoot 'web'
    Copy-Item -LiteralPath $webSource -Destination $webDestination -Recurse
    Move-Item -LiteralPath $stagingRoot -Destination $finalRoot
    $createdFinalRoot = $true

    $backupRoot = Join-Path $installRootFull 'launcher-backups'
    $null = New-Item -ItemType Directory -Path $backupRoot -Force
    $null = Assert-NoReparseTraversal -Path $backupRoot
    foreach ($candidate in @($powerShellLauncher, $launcher)) {
        $existed = Test-Path -LiteralPath $candidate -PathType Leaf
        $backup = Join-Path $backupRoot "$(Split-Path -Leaf $candidate)-$timestamp-$PID.bak"
        if ($existed) {
            $candidateItem = Get-Item -LiteralPath $candidate -Force
            if (($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to replace a launcher reparse point: $candidate"
            }
            Copy-Item -LiteralPath $candidate -Destination $backup
        }
        $launcherState += [pscustomobject]@{
            Path = $candidate
            Existed = $existed
            Backup = $backup
            Published = $false
            RollbackComplete = $false
        }
    }

    $cliPath = Join-Path $finalRoot 'dist\cli.js'
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw "Deployed CLI is missing: $cliPath"
    }
    $webPath = Join-Path $finalRoot 'web'
    $escapedNodePath = $nodePath.Replace("'", "''")
    $escapedCliPath = $cliPath.Replace("'", "''")
    $escapedWebPath = $webPath.Replace("'", "''")
    $powerShellLauncherContent = "`$ErrorActionPreference = 'Stop'`r`n`$env:CODEX_MANTLE_WEB_ROOT = '$escapedWebPath'`r`n& '$escapedNodePath' '$escapedCliPath' @args`r`nexit `$LASTEXITCODE`r`n"
    Set-Content -LiteralPath $powerShellLauncherTemporary -Value $powerShellLauncherContent -Encoding utf8 -NoNewline

    $launcherContent = "@echo off`r`npwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0codex-mantle.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    Set-Content -LiteralPath $launcherTemporary -Value $launcherContent -Encoding ascii -NoNewline

    Move-Item -LiteralPath $powerShellLauncherTemporary -Destination $powerShellLauncher -Force
    $launcherState[0].Published = $true
    Move-Item -LiteralPath $launcherTemporary -Destination $launcher -Force
    $launcherState[1].Published = $true

    if ($AcceptanceFailurePoint -eq 'AfterLaunchersPublished') {
        throw 'Injected acceptance failure after launcher publication.'
    }
}
catch {
    $originalError = $_
    $cleanupErrors = [Collections.Generic.List[string]]::new()

    foreach ($temporaryLauncher in @($launcherTemporary, $powerShellLauncherTemporary)) {
        try {
            if (Test-Path -LiteralPath $temporaryLauncher) {
                Remove-Item -LiteralPath $temporaryLauncher -Force
            }
        }
        catch { $cleanupErrors.Add($_.Exception.Message) }
    }

    foreach ($state in ($launcherState | Sort-Object { if ($_.Path -like '*.cmd') { 0 } else { 1 } })) {
        if (-not $state.Published) {
            $state.RollbackComplete = $true
            continue
        }
        try {
            if ($state.Existed) {
                Copy-Item -LiteralPath $state.Backup -Destination $state.Path -Force
            }
            elseif (Test-Path -LiteralPath $state.Path) {
                Remove-Item -LiteralPath $state.Path -Force
            }
            $state.RollbackComplete = $true
        }
        catch { $cleanupErrors.Add("Launcher rollback failed for $($state.Path): $($_.Exception.Message)") }
    }

    foreach ($state in $launcherState) {
        if (-not $state.RollbackComplete) { continue }
        try {
            if (Test-Path -LiteralPath $state.Backup) {
                Remove-Item -LiteralPath $state.Backup -Force
            }
        }
        catch { $cleanupErrors.Add("Launcher backup cleanup failed for $($state.Backup): $($_.Exception.Message)") }
    }

    try {
        if (Test-Path -LiteralPath $stagingRoot) {
            Remove-InstallChild -Path $stagingRoot -ExpectedParent $installRootFull -Label 'staging cleanup'
        }
    }
    catch { $cleanupErrors.Add($_.Exception.Message) }

    try {
        if ($createdFinalRoot -and (Test-Path -LiteralPath $finalRoot)) {
            Remove-InstallChild -Path $finalRoot -ExpectedParent $versionsRoot -Label 'failed version cleanup'
        }
    }
    catch { $cleanupErrors.Add($_.Exception.Message) }

    if ($cleanupErrors.Count -gt 0) {
        throw "Install failed: $($originalError.Exception.Message) Cleanup also failed: $($cleanupErrors -join '; ')"
    }
    throw $originalError
}
finally {
    if ($locationPushed) { Pop-Location }
}

Write-Host "Installed Codex Mantle $version to $finalRoot"
Write-Host "Launcher: $launcher"
Write-Host 'Add the bin directory to your user PATH manually if it is not already present.'
