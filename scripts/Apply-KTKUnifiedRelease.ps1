# Trusted, checksum-verified package entrypoint. Executed exclusively by the
# fixed SYSTEM update helper. MCP first, then a non-elevated user update job.
param([Parameter(Mandatory=$true)][string]$PackagePath,
      [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne 'S-1-5-18') { throw 'unified_update_requires_system' }
if ($Version -cnotmatch '^0\.18\.[1-9][0-9]{0,3}$') { throw 'unified_update_version_invalid' }
$manifestPath = Join-Path $PackagePath 'MANIFEST.json'
& (Join-Path $PackagePath 'Verify-KTKPackage.ps1') | Out-Null
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.package_version -cne $Version -or $manifest.target -cne 'windows-x64') { throw 'unified_update_manifest_invalid' }

# Abort before touching the running MCP if no known, password-free user task
# exists. Never register tasks under SYSTEM as the user's account.
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

# Verified user payload is retained for a logged-out user's next session.
# The live MCP transaction still gets its normal health gate and rollback.
& (Join-Path $PackagePath 'Maintain-KTKMCP.ps1') -Action Update -PackagePath $PackagePath -Resume -UpdaterApproved

$job = @{schema=1;version=$Version;attempt=[guid]::NewGuid().ToString('N');manifest_sha256=(Get-FileHash -LiteralPath (Join-Path $release 'MANIFEST.json') -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress
$next = Join-Path $public ('job-' + [guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($next, $job)
$active = Join-Path $public 'job.json'
if (Test-Path -LiteralPath $active) { [IO.File]::Replace($next, $active, $null) }
else { [IO.File]::Move($next, $active) }
& icacls.exe $active '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-32-545:R' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'unified_update_job_acl_failed' }
& schtasks.exe /run /tn $taskName | Out-Null
# A non-logged-in user means task is deferred to its next logon trigger.
# Failure here never undoes the already healthy MCP or destroys model bytes.
Write-Output 'KTK_USER_UPDATE_QUEUED'
