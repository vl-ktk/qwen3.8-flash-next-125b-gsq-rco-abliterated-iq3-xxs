# Runs once from Inno Setup as the ORIGINAL non-elevated Windows account.
# Registers a fixed, demand-start/logon Task Scheduler action for that user.
# Does not require or store a Windows account password.
param([switch]$Live, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([bool]$Live -eq [bool]$CheckOnly) { throw 'choose_live_or_check_only' }
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $source 'Verify-KTKPackage.ps1') | Out-Null
foreach ($file in @('bin\node.exe','Run-KTKUserUpdate.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw 'user_updater_payload_incomplete' }
}
if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Build -lt 19045) { throw 'user_updater_unsupported_windows' }
if ($CheckOnly) { Write-Output 'KTK user updater payload verified; no scheduled task created.'; return }
if (-not [Environment]::UserInteractive -or -not [Environment]::Is64BitProcess -or -not $env:LOCALAPPDATA) { throw 'user_updater_interactive_x64_required' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw 'user_updater_service_account_denied' }
$root = Join-Path $env:LOCALAPPDATA 'KTK\UserUpdater'
$marker = Join-Path $root 'owner.json'
$node = Join-Path $root 'bin\node.exe'
$entry = Join-Path $root 'Run-KTKUserUpdate.mjs'
$taskName = 'KTKQwenUserUpdater'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $taskSid = [string]$existing.Principal.UserId
    if ($taskSid -cnotmatch '^S-1-') {
        try { $taskSid = ([Security.Principal.NTAccount]::new($taskSid)).Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { throw 'user_updater_existing_identity_unknown' }
    }
    if ($taskSid -ne $sid -or $existing.Principal.LogonType -ne 'Interactive' -or
        @($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ine $node -or
        $existing.Actions[0].Arguments -cne ('"' + $entry + '"')) { throw 'user_updater_existing_task_not_owned' }
}
if (Test-Path -LiteralPath $root) {
    if (([IO.File]::GetAttributes($root) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'user_updater_directory_unrecognized' }
    $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($owner.schema -ne 1 -or $owner.sid -ne $sid) { throw 'user_updater_owner_mismatch' }
} else {
    New-Item -ItemType Directory -Path (Join-Path $root 'bin') -Force -ErrorAction Stop | Out-Null
    @{schema=1;sid=$sid} | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8
}
Copy-Item -LiteralPath (Join-Path $source 'bin\node.exe') -Destination $node -Force -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $source 'Run-KTKUserUpdate.mjs') -Destination $entry -Force -ErrorAction Stop
if (-not $existing) {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $folder = $service.GetFolder('\')
    $definition = $service.NewTask(0)
    $definition.RegistrationInfo.Description = 'KTK Local AI verified updates; never elevated.'
    $definition.Principal.UserId = $sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $definition.Settings.Enabled = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.ExecutionTimeLimit = 'PT24H'
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $trigger = $definition.Triggers.Create(9)
    $trigger.UserId = $sid
    $trigger.Enabled = $true
    $action = $definition.Actions.Create(0)
    $action.Path = $node
    $action.Arguments = '"' + $entry + '"'
    $action.WorkingDirectory = $root
    $null = $folder.RegisterTaskDefinition($taskName,$definition,6,$sid,$null,3)
}
Write-Output 'KTK user-scoped updater registered. Future approved model/runtime work runs without elevation.'
