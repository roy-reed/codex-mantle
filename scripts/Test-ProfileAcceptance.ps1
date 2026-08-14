[CmdletBinding()]
param(
    [string]$NodePath = 'node',
    [string]$CodexPath = 'codex',
    [ValidateRange(1, 600)]
    [int]$ProcessTimeoutSeconds = 60,
    [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'The real-Codex profile acceptance test requires PowerShell 7 or later.'
}

function Assert-Condition {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )

    if (-not $Condition) { throw $Message }
}

function Resolve-Executable {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Label
    )

    if ([IO.Path]::IsPathFullyQualified($Value)) {
        $resolved = [IO.Path]::GetFullPath($Value)
        Assert-Condition -Condition (Test-Path -LiteralPath $resolved -PathType Leaf) -Message "$Label does not exist: $resolved"
        return $resolved
    }

    $command = Get-Command $Value -CommandType Application -ErrorAction Stop | Select-Object -First 1
    return $command.Source
}

function Invoke-ProcessCapture {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment,
        [ValidateRange(1, 600)][int]$TimeoutSeconds = 60,
        [switch]$AllowFailure
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
    }
    if ($null -ne $Environment) {
        foreach ($entry in $Environment.GetEnumerator()) {
            $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
        }
    }
    foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $result = $null
    try {
        Assert-Condition -Condition $process.Start() -Message "Failed to start $FilePath"
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
        $terminationObserved = -not $timedOut
        if ($timedOut) {
            try { $process.Kill($true) } catch { }
            $terminationObserved = $process.WaitForExit(5000)
        }
        $streamsDrained = $false
        try {
            $streamsDrained = [Threading.Tasks.Task]::WaitAll(
                [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask),
                5000
            )
        }
        catch { }
        $stdout = if ($stdoutTask.IsCompletedSuccessfully) { $stdoutTask.GetAwaiter().GetResult() } else { '' }
        $stderr = if ($stderrTask.IsCompletedSuccessfully) { $stderrTask.GetAwaiter().GetResult() } else { '' }
        $captureComplete = $terminationObserved -and $streamsDrained
        if (-not $captureComplete) {
            $captureDiagnostic = if ($timedOut) {
                'Process capture was truncated after the bounded termination deadline.'
            }
            else {
                'Process exited, but redirected output did not close within the bounded capture deadline.'
            }
            $stderr = if ([string]::IsNullOrEmpty($stderr)) { $captureDiagnostic } else { "$stderr`n$captureDiagnostic" }
        }
        $result = [pscustomobject]@{
            CaptureComplete = $captureComplete
            ExitCode = if ($terminationObserved -and $process.HasExited) { $process.ExitCode } else { $null }
            Stdout = $stdout
            Stderr = $stderr
            TimedOut = $timedOut
        }
    }
    finally {
        $process.Dispose()
    }

    if (-not $AllowFailure -and (-not $result.CaptureComplete -or $result.TimedOut -or $result.ExitCode -ne 0)) {
        $reason = if ($result.TimedOut) {
            "timed out after $TimeoutSeconds second(s)"
        }
        elseif (-not $result.CaptureComplete) {
            'output capture incomplete'
        }
        else {
            "exit $($result.ExitCode)"
        }
        throw "Process failed ($reason): $FilePath`n$($result.Stderr)"
    }
    return $result
}

function ConvertFrom-JsonResult {
    param(
        [Parameter(Mandatory)][psobject]$Result,
        [Parameter(Mandatory)][string]$Label
    )

    try {
        return $Result.Stdout | ConvertFrom-Json -Depth 100
    }
    catch {
        throw "$Label did not emit valid JSON. stdout: $($Result.Stdout)"
    }
}

function Join-ByteArrays {
    param(
        [Parameter(Mandatory)][byte[]]$First,
        [Parameter(Mandatory)][byte[]]$Second
    )

    $joined = [byte[]]::new($First.Length + $Second.Length)
    [Array]::Copy($First, 0, $joined, 0, $First.Length)
    [Array]::Copy($Second, 0, $joined, $First.Length, $Second.Length)
    return $joined
}

function Assert-ExactBytes {
    param(
        [Parameter(Mandatory)][byte[]]$Expected,
        [Parameter(Mandatory)][byte[]]$Actual,
        [Parameter(Mandatory)][string]$Message
    )

    Assert-Condition -Condition (
        [Convert]::ToBase64String($Expected) -ceq [Convert]::ToBase64String($Actual)
    ) -Message $Message
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Assert-JsonError {
    param(
        [Parameter(Mandatory)][psobject]$Result,
        [Parameter(Mandatory)][string]$ExpectedMessage,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-Condition -Condition ($Result.CaptureComplete -and $Result.ExitCode -ne 0 -and -not $Result.TimedOut) -Message "$Label did not fail normally."
    try {
        $document = $Result.Stderr | ConvertFrom-Json -Depth 20
    }
    catch {
        throw "$Label did not emit a machine-readable error. stderr: $($Result.Stderr)"
    }
    Assert-Condition -Condition ([string]$document.error.code -ceq 'runtime_error') -Message "$Label emitted the wrong error code."
    Assert-Condition -Condition ([string]$document.error.message -ceq $ExpectedMessage) -Message "$Label emitted the wrong error message: $($document.error.message)"
}

function Assert-SafeAcceptanceRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedParent
    )

    $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parent = [IO.Path]::GetFullPath((Split-Path -Parent $full)).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $expected = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $leaf = Split-Path -Leaf $full
    if (-not $parent.Equals($expected, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith('codex-mantle-profile-acceptance-', [StringComparison]::Ordinal)) {
        throw "Refusing to use an unexpected profile acceptance path: $full"
    }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Profile acceptance root is not a regular directory: $full"
        }
    }
    return $full
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cliPath = Join-Path $repositoryRoot 'apps\cli\dist\cli.js'
Assert-Condition -Condition (Test-Path -LiteralPath $cliPath -PathType Leaf) -Message 'Build the CLI before running profile acceptance.'
$cliBuildTime = (Get-Item -LiteralPath $cliPath).LastWriteTimeUtc
$newerSources = @(
    @(
        'apps\cli\src'
        'packages\codex-adapter\src'
        'packages\core\src'
        'packages\plugin-sdk\src'
    ) | ForEach-Object {
        Get-ChildItem -LiteralPath (Join-Path $repositoryRoot $_) -File -Recurse
    } | Where-Object { $_.LastWriteTimeUtc -gt $cliBuildTime }
)
Assert-Condition -Condition ($newerSources.Count -eq 0) -Message 'The CLI build is older than its source files. Run pnpm build before profile acceptance.'

$resolvedNode = Resolve-Executable -Value $NodePath -Label 'Node.js executable'
$resolvedCodex = Resolve-Executable -Value $CodexPath -Label 'Codex executable'
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$acceptanceRoot = Assert-SafeAcceptanceRoot -Path (
    Join-Path $tempParent "codex-mantle-profile-acceptance-$([Guid]::NewGuid().ToString('N')) 中文 space"
) -ExpectedParent $tempParent

$codexHome = Join-Path $acceptanceRoot 'Codex Home'
$workspace = Join-Path $acceptanceRoot '工作区 space'
$profileRoot = Join-Path $acceptanceRoot 'profile pack'
$payloadRoot = Join-Path $profileRoot 'payloads'
$stateRoot = Join-Path $acceptanceRoot 'state'
$plansRoot = Join-Path $acceptanceRoot 'plans'
$targetPath = Join-Path $workspace 'AGENTS.md'
$manifestPath = Join-Path $profileRoot 'profile.json'
$payloadPath = Join-Path $payloadRoot 'AGENTS.block.md'
$processEvidencePath = Join-Path $acceptanceRoot 'process-evidence.jsonl'

function Invoke-Mantle {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    try {
        $result = Invoke-ProcessCapture `
            -FilePath $resolvedNode `
            -Arguments (@($cliPath, '--json') + $Arguments) `
            -WorkingDirectory $workspace `
            -Environment @{ CODEX_HOME = $codexHome } `
            -TimeoutSeconds $ProcessTimeoutSeconds `
            -AllowFailure
    }
    catch {
        $captureError = $_
        try {
            $failureEvidence = [ordered]@{
                arguments = $Arguments
                captureComplete = $false
                captureError = $captureError.Exception.Message
                exitCode = $null
                stderr = ''
                stdout = ''
                timedOut = $false
            }
            [IO.File]::AppendAllText(
                $processEvidencePath,
                (($failureEvidence | ConvertTo-Json -Compress -Depth 20) + "`n"),
                [Text.UTF8Encoding]::new($false)
            )
        }
        catch {
            Write-Warning "Could not append process startup/capture evidence: $($_.Exception.Message)"
        }
        throw $captureError
    }
    try {
        $evidence = [ordered]@{
            arguments = $Arguments
            captureComplete = $result.CaptureComplete
            exitCode = $result.ExitCode
            stderr = $result.Stderr
            stdout = $result.Stdout
            timedOut = $result.TimedOut
        }
        [IO.File]::AppendAllText(
            $processEvidencePath,
            (($evidence | ConvertTo-Json -Compress -Depth 20) + "`n"),
            [Text.UTF8Encoding]::new($false)
        )
    }
    catch {
        Write-Warning "Could not append process evidence: $($_.Exception.Message)"
    }
    if (-not $AllowFailure -and (-not $result.CaptureComplete -or $result.TimedOut -or $result.ExitCode -ne 0)) {
        $reason = if ($result.TimedOut) {
            "timed out after $ProcessTimeoutSeconds second(s)"
        }
        elseif (-not $result.CaptureComplete) {
            'output capture incomplete'
        }
        else {
            "exit $($result.ExitCode)"
        }
        throw "Mantle process failed ($reason): $resolvedNode`n$($result.Stderr)"
    }
    return $result
}

$stalePlanRefused = $false
$restoreDriftRefused = $false
$applyVerified = $false
$byteExactRestoreVerified = $false
$passed = $false

try {
    $null = New-Item -ItemType Directory -Path $acceptanceRoot, $codexHome, $workspace, $payloadRoot, $stateRoot, $plansRoot

    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    $bom = [byte[]](0xEF, 0xBB, 0xBF)
    $originalBody = $utf8NoBom.GetBytes("# Existing`r`n`r`nKeep this line.`r`n")
    $originalBytes = Join-ByteArrays -First $bom -Second $originalBody
    [IO.File]::WriteAllBytes($targetPath, $originalBytes)
    [IO.File]::WriteAllText($payloadPath, "## Evidence boundary`n`nOnly confirmed facts may be persisted.`n", $utf8NoBom)

    $manifest = [ordered]@{
        schemaVersion = 1
        id = 'real-codex-acceptance'
        name = 'Real Codex acceptance profile'
        version = '0.1.0'
        description = 'Isolated release acceptance fixture.'
        files = @(
            [ordered]@{
                blockId = 'real-codex-acceptance'
                path = 'AGENTS.md'
                strategy = 'managed-block'
                target = 'workspace'
                source = 'payloads/AGENTS.block.md'
            }
        )
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8NoBom)

    $probeResult = Invoke-Mantle -Arguments @('compatibility', 'probe', '--codex', $resolvedCodex)
    $probe = ConvertFrom-JsonResult -Result $probeResult -Label 'Compatibility probe'
    Assert-Condition -Condition ($probe.capabilities.command -eq $true) -Message 'The actual Codex command probe failed.'
    Assert-Condition -Condition ($probe.supportedVersion -eq $true -and $probe.readOnly -eq $false) -Message 'The actual Codex CLI is not in a fully compatible allowlisted series.'

    $stalePlanPath = Join-Path $plansRoot 'stale-plan.json'
    $stalePlanResult = Invoke-Mantle -Arguments @(
        'profile', 'plan', $manifestPath,
        '--codex-home', $codexHome,
        '--workspace', $workspace,
        '--output', $stalePlanPath
    )
    $stalePlan = ConvertFrom-JsonResult -Result $stalePlanResult -Label 'Stale-plan creation'
    $driftBytes = Join-ByteArrays -First $originalBytes -Second ($utf8NoBom.GetBytes("external drift`r`n"))
    [IO.File]::WriteAllBytes($targetPath, $driftBytes)
    $staleApply = Invoke-Mantle -Arguments @(
        'profile', 'apply', $stalePlanPath,
        '--approve', [string]$stalePlan.approvalId,
        '--codex', $resolvedCodex,
        '--state-dir', $stateRoot
    ) -AllowFailure
    Assert-JsonError `
        -Result $staleApply `
        -ExpectedMessage "Plan is stale; target hash changed: $targetPath" `
        -Label 'Stale profile apply'
    Assert-ExactBytes -Expected $driftBytes -Actual ([IO.File]::ReadAllBytes($targetPath)) -Message 'Stale-plan refusal changed the target bytes.'
    $stalePlanRefused = $true

    [IO.File]::WriteAllBytes($targetPath, $originalBytes)
    $applyPlanPath = Join-Path $plansRoot 'apply-plan.json'
    $applyPlanResult = Invoke-Mantle -Arguments @(
        'profile', 'plan', $manifestPath,
        '--codex-home', $codexHome,
        '--workspace', $workspace,
        '--output', $applyPlanPath
    )
    $applyPlan = ConvertFrom-JsonResult -Result $applyPlanResult -Label 'Apply-plan creation'
    $applyResultRaw = Invoke-Mantle -Arguments @(
        'profile', 'apply', $applyPlanPath,
        '--approve', [string]$applyPlan.approvalId,
        '--codex', $resolvedCodex,
        '--state-dir', $stateRoot
    )
    $applyResult = ConvertFrom-JsonResult -Result $applyResultRaw -Label 'Profile apply'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$applyResult.snapshotId)) -Message 'Profile apply did not create a snapshot.'

    $appliedBytes = [IO.File]::ReadAllBytes($targetPath)
    Assert-Condition -Condition ($applyPlan.plan.operations.Count -eq 1) -Message 'The acceptance plan did not contain exactly one operation.'
    $expectedAppliedBytes = [Convert]::FromBase64String([string]$applyPlan.plan.operations[0].contentBase64)
    Assert-ExactBytes -Expected $expectedAppliedBytes -Actual $appliedBytes -Message 'Profile apply bytes differ from the approved plan payload.'
    $independentExpectedBody = $utf8NoBom.GetBytes(
        "# Existing`r`n`r`nKeep this line.`r`n`r`n" +
        "<!-- codex-mantle:real-codex-acceptance:begin -->`r`n" +
        "## Evidence boundary`r`n`r`nOnly confirmed facts may be persisted.`r`n" +
        "<!-- codex-mantle:real-codex-acceptance:end -->`r`n"
    )
    $independentExpectedBytes = Join-ByteArrays -First $bom -Second $independentExpectedBody
    Assert-ExactBytes -Expected $independentExpectedBytes -Actual $appliedBytes -Message 'Profile apply changed bytes outside the managed block or encoded the block incorrectly.'
    Assert-Condition -Condition ((Get-Sha256Hex -Bytes $appliedBytes) -ceq [string]$applyPlan.plan.operations[0].afterHash) -Message 'Profile apply hash differs from the approved plan hash.'
    Assert-Condition -Condition ($appliedBytes.Length -gt $originalBytes.Length) -Message 'Profile apply did not add the managed block.'
    Assert-Condition -Condition ($appliedBytes[0] -eq 0xEF -and $appliedBytes[1] -eq 0xBB -and $appliedBytes[2] -eq 0xBF) -Message 'Profile apply did not preserve the UTF-8 BOM.'
    $appliedText = $utf8NoBom.GetString($appliedBytes, 3, $appliedBytes.Length - 3)
    Assert-Condition -Condition ($appliedText.Contains('Keep this line.')) -Message 'Profile apply changed existing content.'
    $beginMarker = '<!-- codex-mantle:real-codex-acceptance:begin -->'
    $endMarker = '<!-- codex-mantle:real-codex-acceptance:end -->'
    Assert-Condition -Condition ([Text.RegularExpressions.Regex]::Matches($appliedText, [Text.RegularExpressions.Regex]::Escape($beginMarker)).Count -eq 1) -Message 'Profile apply did not add exactly one begin marker.'
    Assert-Condition -Condition ([Text.RegularExpressions.Regex]::Matches($appliedText, [Text.RegularExpressions.Regex]::Escape($endMarker)).Count -eq 1) -Message 'Profile apply did not add exactly one end marker.'
    Assert-Condition -Condition ($appliedText.Contains("## Evidence boundary`r`n`r`nOnly confirmed facts may be persisted.`r`n")) -Message 'Profile apply did not preserve the exact managed payload.'
    Assert-Condition -Condition (-not [Text.RegularExpressions.Regex]::IsMatch($appliedText, '(?<!\r)\n')) -Message 'Profile apply did not preserve CRLF newlines.'
    $applyVerified = $true

    $snapshotId = [string]$applyResult.snapshotId
    $inspectBeforeDriftRaw = Invoke-Mantle -Arguments @(
        'snapshot', 'inspect', $snapshotId,
        '--codex-home', $codexHome,
        '--workspace', $workspace,
        '--state-dir', $stateRoot
    )
    $inspectBeforeDrift = ConvertFrom-JsonResult -Result $inspectBeforeDriftRaw -Label 'Snapshot inspect before drift'

    $postApplyDrift = Join-ByteArrays -First $appliedBytes -Second ($utf8NoBom.GetBytes("post-apply drift`r`n"))
    [IO.File]::WriteAllBytes($targetPath, $postApplyDrift)
    $staleRestore = Invoke-Mantle -Arguments @(
        'snapshot', 'restore', $snapshotId,
        '--approve', [string]$inspectBeforeDrift.approvalId,
        '--expect-current', [string]$inspectBeforeDrift.currentHashesDigest,
        '--codex-home', $codexHome,
        '--workspace', $workspace,
        '--state-dir', $stateRoot
    ) -AllowFailure
    Assert-JsonError `
        -Result $staleRestore `
        -ExpectedMessage 'Restore refused because the inspected current-hash digest no longer matches.' `
        -Label 'Stale snapshot restore'
    Assert-ExactBytes -Expected $postApplyDrift -Actual ([IO.File]::ReadAllBytes($targetPath)) -Message 'Drift refusal changed the target bytes.'
    $restoreDriftRefused = $true

    $inspectAfterDriftRaw = Invoke-Mantle -Arguments @(
        'snapshot', 'inspect', $snapshotId,
        '--codex-home', $codexHome,
        '--workspace', $workspace,
        '--state-dir', $stateRoot
    )
    $inspectAfterDrift = ConvertFrom-JsonResult -Result $inspectAfterDriftRaw -Label 'Snapshot inspect after drift'
    $restoreRaw = Invoke-Mantle -Arguments @(
        'snapshot', 'restore', $snapshotId,
        '--approve', [string]$inspectAfterDrift.approvalId,
        '--expect-current', [string]$inspectAfterDrift.currentHashesDigest,
        '--codex-home', $codexHome,
        '--workspace', $workspace,
        '--state-dir', $stateRoot
    )
    $null = ConvertFrom-JsonResult -Result $restoreRaw -Label 'Snapshot restore'
    Assert-ExactBytes -Expected $originalBytes -Actual ([IO.File]::ReadAllBytes($targetPath)) -Message 'Snapshot restore was not byte-exact.'
    $byteExactRestoreVerified = $true

    $nodeVersionResult = Invoke-ProcessCapture -FilePath $resolvedNode -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    $reportJson = [ordered]@{
        schemaVersion = 1
        passed = $true
        codexVersion = [string]$probe.version.raw
        allowlistSeries = "$($probe.version.major).$($probe.version.minor).x"
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        nodeVersion = $nodeVersionResult.Stdout.Trim()
        isolatedRoots = $true
        stalePlanRefused = $stalePlanRefused
        applyVerified = $applyVerified
        restoreDriftRefused = $restoreDriftRefused
        byteExactRestoreVerified = $byteExactRestoreVerified
    } | ConvertTo-Json -Depth 5
    Write-Output $reportJson
    $passed = $true
}
finally {
    if ($passed -and -not $KeepArtifacts) {
        try {
            $safeRoot = Assert-SafeAcceptanceRoot -Path $acceptanceRoot -ExpectedParent $tempParent
            if (Test-Path -LiteralPath $safeRoot) {
                Remove-Item -LiteralPath $safeRoot -Recurse -Force
            }
        }
        catch {
            Write-Warning "Acceptance passed, but cleanup failed. Artifacts remain at: $acceptanceRoot. $($_.Exception.Message)"
        }
    }
    elseif (Test-Path -LiteralPath $acceptanceRoot) {
        Write-Warning "Acceptance artifacts retained at: $acceptanceRoot"
    }
}
