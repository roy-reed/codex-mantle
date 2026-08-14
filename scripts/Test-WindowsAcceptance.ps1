[CmdletBinding()]
param(
    [switch]$Fast,
    [ValidateSet('Auto', 'GitArchive', 'SafeCopy')]
    [string]$SourceMode = 'Auto',
    [switch]$KeepArtifacts,
    [ValidateRange(0, 65535)]
    [int]$Port = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'The Windows acceptance test requires PowerShell 7 or later.'
}

function Assert-Condition {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )

    if (-not $Condition) { throw $Message }
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

function Assert-AcceptanceRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedParent
    )

    $full = Get-NormalizedPath -Path $Path
    $parent = Get-NormalizedPath -Path (Split-Path -Parent $full)
    $expected = Get-NormalizedPath -Path $ExpectedParent
    $leaf = Split-Path -Leaf $full
    if (-not $parent.Equals($expected, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith('CodexMantle 验收 空格-', [StringComparison]::Ordinal)) {
        throw "Refusing to clean an unexpected acceptance path: $full"
    }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Acceptance root is not a regular directory: $full"
        }
    }
    return $full
}

function Test-SafeCopyExcluded {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$IsDirectory
    )

    if ($IsDirectory -and $Name -in @(
            '.git', '.cache', '.codex-mantle', '.codex-mantle-home',
            '.codex-mantle-state', '.local-state', '.pnpm-store', '.turbo',
            '.vite', 'artifacts', 'coverage', 'dist', 'node_modules', 'secrets'
        )) {
        return $true
    }
    if (-not $IsDirectory) {
        if ($Name -eq '.env' -or ($Name -like '.env.*' -and $Name -ne '.env.example')) { return $true }
        if ($Name -like '.codex-task-*.json' -or $Name -like '*.log' -or
            $Name -like '*.key' -or $Name -like '*.pem' -or $Name -like '*.p12' -or
            $Name -like '*.pfx' -or $Name -like '*.token' -or $Name -like '*.tgz' -or
            $Name -like '*.zip') {
            return $true
        }
    }
    return $false
}

function Copy-SafeSourceTree {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $sourceFull = Get-NormalizedPath -Path $Source
    $destinationFull = Get-NormalizedPath -Path $Destination
    $null = New-Item -ItemType Directory -Path $destinationFull
    $pending = [Collections.Generic.Stack[object]]::new()
    $pending.Push([pscustomobject]@{ Source = $sourceFull; Destination = $destinationFull })

    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($child in Get-ChildItem -LiteralPath $current.Source -Force) {
            if (Test-SafeCopyExcluded -Name $child.Name -IsDirectory $child.PSIsContainer) { continue }
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }

            $target = Join-Path $current.Destination $child.Name
            if ($child.PSIsContainer) {
                $null = New-Item -ItemType Directory -Path $target
                $pending.Push([pscustomobject]@{ Source = $child.FullName; Destination = $target })
            }
            else {
                Copy-Item -LiteralPath $child.FullName -Destination $target
            }
        }
    }
}

function Test-GitArchiveAvailable {
    param([Parameter(Mandatory)][string]$RepositoryRoot)

    if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot '.git'))) { return $false }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) { return $false }
    & $git.Source -C $RepositoryRoot rev-parse --verify --quiet HEAD *> $null
    return $LASTEXITCODE -eq 0
}

function New-SourceCopy {
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$Mode,
        [Parameter(Mandatory)][string]$AcceptanceRoot
    )

    $selected = $Mode
    if ($selected -eq 'Auto') {
        $selected = if (Test-GitArchiveAvailable -RepositoryRoot $RepositoryRoot) { 'GitArchive' } else { 'SafeCopy' }
    }

    if ($selected -eq 'GitArchive') {
        if (-not (Test-GitArchiveAvailable -RepositoryRoot $RepositoryRoot)) {
            throw 'GitArchive mode requires Git and a committed HEAD.'
        }
        $archive = Join-Path $AcceptanceRoot 'codex-mantle-source.zip'
        & git -C $RepositoryRoot archive --format=zip --output=$archive HEAD
        if ($LASTEXITCODE -ne 0) { throw "git archive failed with exit code $LASTEXITCODE." }
        Expand-Archive -LiteralPath $archive -DestinationPath $Destination
        Remove-Item -LiteralPath $archive -Force
    }
    else {
        Copy-SafeSourceTree -Source $RepositoryRoot -Destination $Destination
    }
    return $selected
}

function Get-AvailablePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Stop-TestServer {
    param(
        [Diagnostics.Process]$Process,
        [bool]$Started = $true
    )

    if ($null -eq $Process -or -not $Started) { return }
    if (-not $Process.HasExited) {
        $Process.Kill($true)
        if (-not $Process.WaitForExit(10000)) {
            throw 'The dashboard test server did not terminate within 10 seconds.'
        }
    }
}

function Receive-TestServerOutput {
    param(
        [Threading.Tasks.Task[string]]$StdoutTask,
        [Threading.Tasks.Task[string]]$StderrTask,
        [ValidateRange(1, 30000)][int]$TimeoutMilliseconds = 5000
    )

    $tasks = @($StdoutTask, $StderrTask) | Where-Object { $null -ne $_ }
    $diagnostics = [Collections.Generic.List[string]]::new()
    if ($tasks.Count -gt 0) {
        try {
            if (-not [Threading.Tasks.Task]::WaitAll(
                    [Threading.Tasks.Task[]]$tasks,
                    $TimeoutMilliseconds
                )) {
                $diagnostics.Add("Server output streams did not close within $TimeoutMilliseconds ms.")
            }
        }
        catch {
            $diagnostics.Add("Server output capture failed: $($_.Exception.Message)")
        }
    }

    $stdout = if ($null -ne $StdoutTask -and $StdoutTask.IsCompletedSuccessfully) {
        $StdoutTask.GetAwaiter().GetResult()
    }
    else { '' }
    $stderr = if ($null -ne $StderrTask -and $StderrTask.IsCompletedSuccessfully) {
        $StderrTask.GetAwaiter().GetResult()
    }
    else { '' }

    return [pscustomobject]@{
        Complete = $diagnostics.Count -eq 0
        Stdout = $stdout
        Stderr = $stderr
        Diagnostic = if ($diagnostics.Count -eq 0) {
            'Server output capture completed.'
        }
        else {
            $diagnostics -join ' '
        }
    }
}

$repositoryRoot = Get-NormalizedPath -Path (Split-Path -Parent $PSScriptRoot)
$tempParent = Get-NormalizedPath -Path ([IO.Path]::GetTempPath())
$acceptanceRoot = Join-Path $tempParent "CodexMantle 验收 空格-$([Guid]::NewGuid().ToString('N'))"
$acceptanceRoot = Assert-AcceptanceRoot -Path $acceptanceRoot -ExpectedParent $tempParent
$sourceRoot = Join-Path $acceptanceRoot '源码 副本'
$localAppData = Join-Path $acceptanceRoot '本地 应用'
$stateRoot = Join-Path $acceptanceRoot '状态 数据'
$codexHome = Join-Path $acceptanceRoot 'Codex 空目录'
$installRoot = Join-Path $localAppData 'Programs\CodexMantle'
$unrelatedRoot = Join-Path $localAppData 'Programs\Unrelated App'
$unrelatedSentinel = Join-Path $unrelatedRoot 'sentinel.txt'
$stateSentinel = Join-Path $stateRoot 'sentinel.txt'
$previousLocalAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
$previousMantleHome = [Environment]::GetEnvironmentVariable('CODEX_MANTLE_HOME', 'Process')
$serverProcess = $null
$stdoutTask = $null
$stderrTask = $null
$serverStdout = ''
$serverStderr = ''
$serverStarted = $false
$passed = $false

try {
    $null = New-Item -ItemType Directory -Path $acceptanceRoot, $localAppData, $stateRoot, $codexHome, $unrelatedRoot
    Set-Content -LiteralPath $unrelatedSentinel -Value 'unrelated-directory-must-survive' -Encoding utf8 -NoNewline
    Set-Content -LiteralPath $stateSentinel -Value 'state-must-survive' -Encoding utf8 -NoNewline
    $unrelatedHash = (Get-FileHash -LiteralPath $unrelatedSentinel -Algorithm SHA256).Hash
    $stateHash = (Get-FileHash -LiteralPath $stateSentinel -Algorithm SHA256).Hash

    $env:LOCALAPPDATA = $localAppData
    $env:CODEX_MANTLE_HOME = $stateRoot

    $selectedMode = New-SourceCopy -RepositoryRoot $repositoryRoot -Destination $sourceRoot -Mode $SourceMode -AcceptanceRoot $acceptanceRoot
    Write-Host "Acceptance source: $selectedMode at $sourceRoot"
    Assert-Condition -Condition (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'node_modules'))) -Message 'Acceptance source unexpectedly contains root dependencies.'
    Assert-Condition -Condition (-not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) -Message 'Acceptance source unexpectedly contains Git metadata.'

    $nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    & $nodePath (Join-Path $sourceRoot 'scripts\\scan-repository.mjs')
    Assert-Condition -Condition ($LASTEXITCODE -eq 0) -Message 'Repository heuristic scan failed in the archive-equivalent source.'

    $installer = Join-Path $sourceRoot 'scripts\Install-CodexMantle.ps1'
    $uninstaller = Join-Path $sourceRoot 'scripts\Uninstall-CodexMantle.ps1'
    Assert-Condition -Condition (Test-Path -LiteralPath $installer -PathType Leaf) -Message 'Installer is missing from the acceptance source.'
    Assert-Condition -Condition (Test-Path -LiteralPath $uninstaller -PathType Leaf) -Message 'Uninstaller is missing from the acceptance source.'

    $protectedInstallRoot = Join-Path $acceptanceRoot '受保护 安装\CodexMantle'
    $protectedInstallSentinel = Join-Path $protectedInstallRoot 'sentinel.txt'
    $null = New-Item -ItemType Directory -Path $protectedInstallRoot
    Set-Content -LiteralPath $protectedInstallSentinel -Value 'installer-must-not-adopt-this-directory' -Encoding utf8 -NoNewline
    $protectedInstallRejected = $false
    try {
        & $installer -InstallRoot $protectedInstallRoot -SkipChecks
    }
    catch {
        $protectedInstallRejected = $true
    }
    Assert-Condition -Condition $protectedInstallRejected -Message 'Installer accepted a non-empty unmarked directory.'
    Assert-Condition -Condition (Test-Path -LiteralPath $protectedInstallSentinel -PathType Leaf) -Message 'Installer damaged a non-empty unmarked directory.'

    if ($Fast) {
        & $installer -InstallRoot $installRoot -SkipChecks
    }
    else {
        & $installer -InstallRoot $installRoot
    }

    $markerPath = Join-Path $installRoot '.codex-mantle-install.json'
    $launcherCmd = Join-Path $installRoot 'bin\codex-mantle.cmd'
    $launcherPs1 = Join-Path $installRoot 'bin\codex-mantle.ps1'
    Assert-Condition -Condition (Test-Path -LiteralPath $markerPath -PathType Leaf) -Message 'Ownership marker was not installed.'
    Assert-Condition -Condition (Test-Path -LiteralPath $launcherCmd -PathType Leaf) -Message 'CMD launcher was not installed.'
    Assert-Condition -Condition (Test-Path -LiteralPath $launcherPs1 -PathType Leaf) -Message 'PowerShell launcher was not installed.'
    $versionsRoot = Join-Path $installRoot 'versions'
    $backupRoot = Join-Path $installRoot 'launcher-backups'
    $firstVersions = @(Get-ChildItem -LiteralPath $versionsRoot -Directory | Sort-Object Name)
    Assert-Condition -Condition ($firstVersions.Count -eq 1) -Message 'The first install did not publish exactly one version.'

    $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-Condition -Condition ($marker.schemaVersion -eq 1) -Message 'Ownership marker schema is invalid.'
    Assert-Condition -Condition ($marker.product -ceq 'CodexMantle') -Message 'Ownership marker product is invalid.'
    Assert-Condition -Condition ((Get-NormalizedPath -Path ([string]$marker.installRoot)).Equals((Get-NormalizedPath -Path $installRoot), [StringComparison]::OrdinalIgnoreCase)) -Message 'Ownership marker root is invalid.'

    & $installer -InstallRoot $installRoot -SkipChecks
    $secondVersions = @(Get-ChildItem -LiteralPath $versionsRoot -Directory | Sort-Object Name)
    Assert-Condition -Condition ($secondVersions.Count -eq 2) -Message 'A second install did not publish a distinct version directory.'
    Assert-Condition -Condition (Test-Path -LiteralPath $firstVersions[0].FullName -PathType Container) -Message 'A second install removed the previous version.'

    $launcherCmdHash = (Get-FileHash -LiteralPath $launcherCmd -Algorithm SHA256).Hash
    $launcherPs1Hash = (Get-FileHash -LiteralPath $launcherPs1 -Algorithm SHA256).Hash
    $publishedVersionNames = @($secondVersions.Name)
    $publishedBackupNames = @(Get-ChildItem -LiteralPath $backupRoot -File | Sort-Object Name | ForEach-Object Name)
    $injectedFailureObserved = $false
    try {
        & $installer -InstallRoot $installRoot -SkipChecks -AcceptanceFailurePoint AfterLaunchersPublished
    }
    catch {
        $injectedFailureObserved = $_.Exception.Message -like '*Injected acceptance failure after launcher publication*'
    }
    Assert-Condition -Condition $injectedFailureObserved -Message 'The mid-install failure injection was not observed.'
    Assert-Condition -Condition ((Get-FileHash -LiteralPath $launcherCmd -Algorithm SHA256).Hash -eq $launcherCmdHash) -Message 'CMD launcher rollback did not restore the previous launcher.'
    Assert-Condition -Condition ((Get-FileHash -LiteralPath $launcherPs1 -Algorithm SHA256).Hash -eq $launcherPs1Hash) -Message 'PowerShell launcher rollback did not restore the previous launcher.'

    $versionsAfterFailure = @(Get-ChildItem -LiteralPath $versionsRoot -Directory | Sort-Object Name | ForEach-Object Name)
    $backupsAfterFailure = @(Get-ChildItem -LiteralPath $backupRoot -File | Sort-Object Name | ForEach-Object Name)
    Assert-Condition -Condition (($versionsAfterFailure -join "`n") -ceq ($publishedVersionNames -join "`n")) -Message 'A failed upgrade changed the published version set.'
    Assert-Condition -Condition (($backupsAfterFailure -join "`n") -ceq ($publishedBackupNames -join "`n")) -Message 'A failed upgrade left launcher backup artifacts behind.'
    Assert-Condition -Condition (-not (Get-ChildItem -LiteralPath $installRoot -Force | Where-Object Name -Like '.staging-*' | Select-Object -First 1)) -Message 'A failed upgrade left a staging directory behind.'
    Assert-Condition -Condition (-not (Get-ChildItem -LiteralPath (Join-Path $installRoot 'bin') -Force | Where-Object Name -Like '*.tmp' | Select-Object -First 1)) -Message 'A failed upgrade left a temporary launcher behind.'

    $doctorText = (& $launcherPs1 --json doctor --codex $nodePath | Out-String).Trim()
    $doctorExitCode = $LASTEXITCODE
    $doctor = $doctorText | ConvertFrom-Json
    Assert-Condition -Condition (
        (($doctor.ok -eq $true) -and ($doctorExitCode -eq 0)) -or
        (($doctor.ok -eq $false) -and ($doctorExitCode -eq 1))
    ) -Message "Installed doctor exit code and JSON report disagree: exit=$doctorExitCode report=$doctorText"
    Assert-Condition -Condition ($doctor.readOnly -eq $true) -Message 'Doctor did not enter the expected read-only compatibility mode for the Node.js stand-in.'
    Assert-Condition -Condition (($doctor.tools | Where-Object name -eq 'codex').status -in @('warning', 'error')) -Message 'Doctor did not report the incompatible Codex stand-in.'

    $selectedPort = if ($Port -eq 0) { Get-AvailablePort } else { $Port }
    $processInfo = [Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = (Get-Process -Id $PID).Path
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    foreach ($argument in @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', $launcherPs1, 'serve', '--codex', $nodePath,
            '--codex-home', $codexHome, '--state-dir', $stateRoot,
            '--port', [string]$selectedPort
        )) {
        $null = $processInfo.ArgumentList.Add($argument)
    }
    $serverProcess = [Diagnostics.Process]::new()
    $serverProcess.StartInfo = $processInfo
    $serverStarted = $serverProcess.Start()
    Assert-Condition -Condition $serverStarted -Message 'Failed to start the installed dashboard server.'
    $stdoutTask = $serverProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $serverProcess.StandardError.ReadToEndAsync()

    $health = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($serverProcess.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$selectedPort/api/v1/health" -TimeoutSec 2
            if ($health.ok -eq $true) { break }
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    }
    Assert-Condition -Condition ($null -ne $health -and $health.ok -eq $true -and $health.service -eq 'codex-mantle') -Message 'Installed dashboard health endpoint did not become ready.'
    Stop-TestServer -Process $serverProcess -Started $serverStarted
    $serverOutput = Receive-TestServerOutput -StdoutTask $stdoutTask -StderrTask $stderrTask
    $serverStdout = $serverOutput.Stdout
    $serverStderr = $serverOutput.Stderr
    Assert-Condition -Condition $serverOutput.Complete -Message $serverOutput.Diagnostic
    $serverProcess = $null
    $serverStarted = $false

    & $uninstaller -InstallRoot $installRoot -Confirm:$false
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $launcherCmd)) -Message 'Default uninstall left the CMD launcher behind.'
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $launcherPs1)) -Message 'Default uninstall left the PowerShell launcher behind.'
    Assert-Condition -Condition (Test-Path -LiteralPath $installRoot -PathType Container) -Message 'Default uninstall removed installed versions.'
    Assert-Condition -Condition ((Get-FileHash -LiteralPath $unrelatedSentinel -Algorithm SHA256).Hash -eq $unrelatedHash) -Message 'Default uninstall changed an unrelated directory.'
    Assert-Condition -Condition ((Get-FileHash -LiteralPath $stateSentinel -Algorithm SHA256).Hash -eq $stateHash) -Message 'Default uninstall changed user state.'

    $unmarkedRoot = Join-Path $acceptanceRoot '未授权 目录\CodexMantle'
    $unmarkedSentinel = Join-Path $unmarkedRoot 'sentinel.txt'
    $null = New-Item -ItemType Directory -Path $unmarkedRoot
    Set-Content -LiteralPath $unmarkedSentinel -Value 'unmarked-directory-must-survive' -Encoding utf8 -NoNewline
    $unmarkedRejected = $false
    try {
        & $uninstaller -InstallRoot $unmarkedRoot -RemoveInstalledVersions -Confirm:$false
    }
    catch {
        $unmarkedRejected = $true
    }
    Assert-Condition -Condition $unmarkedRejected -Message 'Full uninstall accepted an unmarked directory.'
    Assert-Condition -Condition (Test-Path -LiteralPath $unmarkedSentinel -PathType Leaf) -Message 'Full uninstall damaged an unmarked directory.'

    & $uninstaller -InstallRoot $installRoot -RemoveInstalledVersions -Confirm:$false
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $installRoot)) -Message 'Full uninstall left the marked install root behind.'
    Assert-Condition -Condition ((Get-FileHash -LiteralPath $unrelatedSentinel -Algorithm SHA256).Hash -eq $unrelatedHash) -Message 'Full uninstall changed an unrelated directory.'
    Assert-Condition -Condition ((Get-FileHash -LiteralPath $stateSentinel -Algorithm SHA256).Hash -eq $stateHash) -Message 'Full uninstall changed user state.'
    Assert-Condition -Condition (Test-Path -LiteralPath $unmarkedSentinel -PathType Leaf) -Message 'Full uninstall changed the unmarked canary directory.'

    Write-Host "Windows acceptance passed with upgrade and rollback coverage (source=$selectedMode, port=$selectedPort, fast=$($Fast.IsPresent))."
    $passed = $true
}
catch {
    $originalError = $_
    try {
        Stop-TestServer -Process $serverProcess -Started $serverStarted
    }
    catch {
        Write-Warning "Could not stop the dashboard test server cleanly: $($_.Exception.Message)"
    }
    $serverOutput = Receive-TestServerOutput -StdoutTask $stdoutTask -StderrTask $stderrTask
    if ($serverOutput.Stdout) { $serverStdout = $serverOutput.Stdout }
    if ($serverOutput.Stderr) { $serverStderr = $serverOutput.Stderr }
    if (-not $serverOutput.Complete) { Write-Warning $serverOutput.Diagnostic }
    if ($serverStdout) { Write-Host "Server stdout:`n$serverStdout" }
    if ($serverStderr) { Write-Host "Server stderr:`n$serverStderr" }
    throw $originalError
}
finally {
    try {
        Stop-TestServer -Process $serverProcess -Started $serverStarted
    }
    catch {
        Write-Warning "Could not stop the dashboard test server during cleanup: $($_.Exception.Message)"
    }

    if ($null -eq $previousLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue }
    else { $env:LOCALAPPDATA = $previousLocalAppData }
    if ($null -eq $previousMantleHome) { Remove-Item Env:CODEX_MANTLE_HOME -ErrorAction SilentlyContinue }
    else { $env:CODEX_MANTLE_HOME = $previousMantleHome }

    if ($KeepArtifacts -or -not $passed) {
        Write-Host "Acceptance artifacts kept at $acceptanceRoot"
    }
    elseif (Test-Path -LiteralPath $acceptanceRoot) {
        try {
            $safeRoot = Assert-AcceptanceRoot -Path $acceptanceRoot -ExpectedParent $tempParent
            Remove-Item -LiteralPath $safeRoot -Recurse -Force
        }
        catch {
            Write-Warning "Acceptance passed, but cleanup was refused or failed; artifacts remain at ${acceptanceRoot}: $($_.Exception.Message)"
        }
    }
}
