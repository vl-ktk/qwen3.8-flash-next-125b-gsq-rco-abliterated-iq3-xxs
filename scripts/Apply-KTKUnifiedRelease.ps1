# Trusted, checksum-verified package entrypoint. Executed exclusively by the
# fixed SYSTEM update helper. MCP always; user-scoped AI only if the owner
# explicitly completed local AI acceptance and its protected opt-in is enabled.
param([Parameter(Mandatory=$true)][string]$PackagePath,
      [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne 'S-1-5-18') { throw 'unified_update_requires_system' }
if ($Version -cnotmatch '^0\.18\.[1-9][0-9]{0,3}$') { throw 'unified_update_version_invalid' }
# The already-installed 0.18.12 updater launches PowerShell with an explicit
# limited environment and no PATH. Repair native command lookup INSIDE the
# verified payload so a remote 0.18.12 -> 0.18.16 update can find sc.exe,
# icacls.exe and schtasks.exe without first replacing the updater service.
$windowsRoot = [string]$env:SystemRoot
if ([string]::IsNullOrWhiteSpace($windowsRoot) -or
    -not (Test-Path -LiteralPath (Join-Path $windowsRoot 'System32\sc.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $windowsRoot 'System32\icacls.exe') -PathType Leaf)) { throw 'unified_update_windows_tools_missing' }
$env:Path = (Join-Path $windowsRoot 'System32') + ';' + $windowsRoot
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
$manifestPath = Join-Path $PackagePath 'MANIFEST.json'
& (Join-Path $PackagePath 'Verify-KTKPackage.ps1') | Out-Null
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.package_version -cne $Version -or $manifest.target -cne 'windows-x64') { throw 'unified_update_manifest_invalid' }

# A user task's existence is NOT consent to download ~77 GB. A protected
# opt-in marker is written by the elevated Setup only after the local model
# passed inference acceptance. No marker (including legacy 0.18.10) means
# remote MCP-only update, never an automatic Strata/model download.
$optInFile = Join-Path $env:ProgramData 'KTK\Updater\local-ai-opt-in.json'
$doLocalAI = $false
if (Test-Path -LiteralPath $optInFile) {
    try {
        if (-not (Test-Path -LiteralPath $optInFile -PathType Leaf) -or
            ([IO.File]::GetAttributes($optInFile) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unified_update_local_ai_marker_untrusted' }
        $acl = Get-Acl -LiteralPath $optInFile
        if (-not $acl.AreAccessRulesProtected) { throw 'unified_update_local_ai_acl_untrusted' }
        foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $ace.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'unified_update_local_ai_acl_untrusted' }
        }
        $optIn = Get-Content -LiteralPath $optInFile -Raw | ConvertFrom-Json
        if ($optIn.schema -ne 1 -or $optIn.enabled -isnot [bool]) { throw 'unified_update_local_ai_marker_invalid' }
        $doLocalAI = $optIn.enabled
    } catch {
        # A malformed, inaccessible, linked or writable opt-in can NEVER
        # authorize Strata/77-GB model work. Treat it as NO CONSENT while
        # still allowing the separately authorized MCP-only upgrade.
        $doLocalAI = $false
        Write-Output 'KTK_LOCAL_AI_OPT_IN_IGNORED_MCP_ONLY'
    }
}
if ($doLocalAI) {
# Abort before touching the running MCP if the explicitly opted-in AI owner
# has no known password-free user task. SYSTEM never impersonates that user.
$taskName = 'KTKQwenUserUpdater'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task -or @($task.Actions).Count -ne 1 -or
    $task.Principal.LogonType -ne 'Interactive' -or
    $task.Principal.UserId -in @('S-1-5-18','S-1-5-19','S-1-5-20') -or
    $task.Principal.UserId -match '(?i)(?:system|localservice|networkservice)$' -or
    $task.Actions[0].Execute -notmatch '(?i)\\KTK\\UserUpdater\\bin\\node\.exe$' -or
    $task.Actions[0].Arguments -notmatch '(?i)^"[A-Z]:\\[^"\r\n]+\\KTK\\UserUpdater\\Run-KTKUserUpdate\.mjs"$') {
    throw 'unified_update_user_task_missing_or_untrusted'
}
$expectedUserScript = Join-Path (Split-Path (Split-Path $task.Actions[0].Execute -Parent) -Parent) 'Run-KTKUserUpdate.mjs'
if ($task.Actions[0].Arguments -cne ('"' + $expectedUserScript + '"')) { throw 'unified_update_user_task_mismatch' }

$public = Join-Path $env:ProgramData 'KTK\Updater\public'
if (Test-Path -LiteralPath $public) {
    if (-not (Test-Path -LiteralPath $public -PathType Container) -or
        ([IO.File]::GetAttributes($public) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unified_update_public_directory_untrusted' }
} else { New-Item -ItemType Directory -Path $public -ErrorAction Stop | Out-Null }
# No secrets here: only approved release code and its public hash/manifest.
# Users may read, but may not modify the release or its queued version.
& icacls.exe $public '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'unified_update_public_acl_failed' }
$release = Join-Path $public ('release-' + $Version)
if (Test-Path -LiteralPath $release) {
    if (-not (Test-Path -LiteralPath $release -PathType Container) -or
        ([IO.File]::GetAttributes($release) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unified_update_existing_release_untrusted' }
    $prior = Get-Content -LiteralPath (Join-Path $release 'MANIFEST.json') -Raw | ConvertFrom-Json
    if ($prior.package_version -cne $Version -or (Get-FileHash -LiteralPath (Join-Path $release 'MANIFEST.json') -Algorithm SHA256).Hash -cne
        (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash) { throw 'unified_update_release_conflict' }
    & (Join-Path $release 'Verify-KTKPackage.ps1') | Out-Null
} else {
    New-Item -ItemType Directory -Path $release -ErrorAction Stop | Out-Null
    foreach ($item in (Get-ChildItem -LiteralPath $PackagePath -Force)) {
        Copy-Item -LiteralPath $item.FullName -Destination $release -Recurse -Force -ErrorAction Stop
    }
    & (Join-Path $release 'Verify-KTKPackage.ps1') | Out-Null
    & icacls.exe $release '/T' '/C' '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-32-545:RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'unified_update_release_acl_failed' }
}
}

# The live MCP transaction always gets its normal health gate and rollback.
& (Join-Path $PackagePath 'Maintain-KTKMCP.ps1') -Action Update -PackagePath $PackagePath -Resume -UpdaterApproved

if ($doLocalAI) {
# Verified user payload is retained for a logged-out opted-in user's next session.
$job = @{schema=1;version=$Version;attempt=[guid]::NewGuid().ToString('N');manifest_sha256=(Get-FileHash -LiteralPath (Join-Path $release 'MANIFEST.json') -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress
$next = Join-Path $public ('job-' + [guid]::NewGuid().ToString('N') + '.tmp')
$backup = Join-Path $public ('job-prev-' + [guid]::NewGuid().ToString('N') + '.bak')
[IO.File]::WriteAllText($next, $job)
$active = Join-Path $public 'job.json'
if ((Test-Path -LiteralPath $active) -and
    ((-not (Test-Path -LiteralPath $active -PathType Leaf)) -or
     ([IO.File]::GetAttributes($active) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'unified_update_job_untrusted' }
# Windows PowerShell 5.1/.NET Framework requires a non-empty backup path.
if (Test-Path -LiteralPath $active) { [IO.File]::Replace($next, $active, $backup) }
else { [IO.File]::Move($next, $active) }
# Do not keep legacy explicit write grants inherited from a replaced job.
& icacls.exe $active '/reset' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'unified_update_job_acl_reset_failed' }
& icacls.exe $active '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-32-545:R' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'unified_update_job_acl_failed' }
$jobAcl = Get-Acl -LiteralPath $active
if (-not $jobAcl.AreAccessRulesProtected) { throw 'unified_update_job_acl_untrusted' }
foreach ($ace in $jobAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $ace.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')) { throw 'unified_update_job_acl_untrusted' }
}
[IO.File]::WriteAllText($active, $job)
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction Stop }
& schtasks.exe /run /tn $taskName | Out-Null
# A non-logged-in user means task is deferred to its next logon trigger.
# Failure here never undoes the already healthy MCP or destroys model bytes.
Write-Output 'KTK_USER_UPDATE_QUEUED'
} else {
    Write-Output 'KTK_MCP_UPDATE_ONLY'
}
} catch {
    # The already-installed updater (e.g. 0.18.12) knows only the safe
    # KTK_UPDATE_FAILURE marker. Preserve meaningful symbolic exceptions,
    # but encode non-symbolic PowerShell errors inside this trusted payload
    # before the old wrapper collapses them to "powershell_exception".
    $reason = [string]$_.Exception.Message
    if ($reason -cmatch '^[a-z][a-z0-9_]{2,63}$') { throw }
    $scriptName = [IO.Path]::GetFileName([string]$_.InvocationInfo.ScriptName)
    $scriptKey = switch -CaseSensitive ($scriptName) {
        'Maintain-KTKMCP.ps1' { 'maintain' }
        'Apply-KTKUnifiedRelease.ps1' { 'unified' }
        'Verify-KTKPackage.ps1' { 'verify' }
        default { 'other' }
    }
    $line = [int]$_.InvocationInfo.ScriptLineNumber
    if ($line -lt 1 -or $line -gt 9999) { $line = 0 }
    $type = [string]$_.Exception.GetType().Name
    if ($type -cnotmatch '^[A-Za-z]{3,40}$') { $type = 'exception' }
    throw ('ps_{0}_{1}_{2}' -f $scriptKey, $line, $type.ToLowerInvariant())
}
