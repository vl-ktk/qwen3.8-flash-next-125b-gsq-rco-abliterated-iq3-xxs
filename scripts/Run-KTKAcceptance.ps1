# Single-entry acceptance runner. Used by Setup.exe; no user-entered commands.
# -Offline tests the real Windows SCM/ACL and removes only its fresh test install.
# -Live performs owner-approved enrollment and leaves the installed services.
param([switch]$Offline, [switch]$Live)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([bool]$Offline -eq [bool]$Live) { throw 'choose_exactly_one_acceptance_mode' }
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path $env:ProgramFiles 'KTK\QwenMCP'
$data = Join-Path $env:ProgramData 'KTK\QwenMCP'
$reportFolder = [Environment]::GetFolderPath('Desktop')
if (-not $reportFolder -or -not (Test-Path -LiteralPath $reportFolder -PathType Container)) { $reportFolder = $env:TEMP }
$reportFile = Join-Path $reportFolder ('KTK-MCP-Test-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$steps = New-Object System.Collections.Generic.List[string]
$created = $false
$completed = $false
$resuming = $false

function Record([string]$Text) { $steps.Add($Text) }
function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'UAC_admin_required' }
}
function Assert-OwnService([string]$Name) {
    $service = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $Name)
    $expected = Join-Path $root ($Name + '.exe')
    if (-not $service -or $service.PathName.Trim().Trim('"') -ine $expected -or $service.StartName -notmatch 'LocalService$') { throw 'service_ownership_mismatch' }
    return $service
}
function Assert-OfflineState {
    foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
        $service = Assert-OwnService $name
        if ($service.State -ne 'Stopped' -or $service.StartMode -ne 'Manual') { throw 'staged_service_not_manual_stopped' }
    }
    foreach ($file in @((Join-Path $data 'secrets\device-identity.json'), (Join-Path $data 'state\emergency.lock'), (Join-Path $root 'MANIFEST.json'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'staging_file_missing' }
    }
    if (Test-Path -LiteralPath (Join-Path $data 'secrets\tunnel.token')) { throw 'unapproved_tunnel_token_present' }
    if (Test-Path -LiteralPath (Join-Path $data 'secrets\gateway.key')) { throw 'unapproved_gateway_key_present' }
}
function Remove-OwnTestInstall {
    # Called ONLY for the installation made by this invocation, never preexisting roots.
    foreach ($name in @('KTKQwenTunnel','KTKQwenMCP')) {
        $entry = Assert-OwnService $name
        if ($entry.State -ne 'Stopped') { throw 'cleanup_refuses_running_service' }
        & (Join-Path $root ($name + '.exe')) uninstall | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'cleanup_service_uninstall_failed' }
    }
    foreach ($target in @($root,$data)) {
        if (([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'cleanup_link_denied' }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
}

try {
    # All real installation actions must use native 64-bit PowerShell, not WOW64.
    if (-not [Environment]::Is64BitProcess) { throw 'native_x64_powershell_required' }
    Assert-Admin
    Record 'UAC: administrator confirmed'
    & (Join-Path $source 'Verify-KTKPackage.ps1') | Out-Null
    Record 'Integrity: MANIFEST + SHA256 OK'
    if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $data)) {
        if ($Offline -or -not (Test-Path -LiteralPath $root) -or -not (Test-Path -LiteralPath $data)) { throw 'existing_ktk_install_refusing_overwrite' }
        # No overwrite or update: only a verified, locked, unprovisioned KTK
        # staging from a known previous installer can be enrolled again.
        & (Join-Path $source 'Assert-KTKStaged.ps1') -Root $root -Data $data | Out-Null
        $resuming = $true
        $created = $true
        Record 'Recovery: existing KTK staging verified; safely retrying enrollment'
    } else {
        foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
            if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'existing_ktk_service_refusing_overwrite' }
        }
        & (Join-Path $source 'Install-KTKMCP.ps1') -CheckOnly | Out-Null
        Record 'Preflight: OS, x64, disk, ports and service names OK'
    }
    if ($Offline) {
        & (Join-Path $source 'Install-KTKMCP.ps1') | Out-Null
        $created = $true
        Assert-OfflineState
        & (Join-Path $source 'Assert-KTKStaged.ps1') -Root $root -Data $data | Out-Null
        Record 'Real Windows SCM: two LocalService Manual/Stopped services OK'
        Record 'Staged identity, emergency lock and safe automatic resume gate OK'
        Remove-OwnTestInstall
        $created = $false
        Record 'Cleanup: both own services and only fresh test directories removed'
    } else {
        if ($resuming) {
            # FileShare.None prevents a concurrent second installer from
            # attempting enrollment of the same staged private identity.
            $claim = $null
            try {
                $claimFile = Join-Path $data 'state\acceptance.lock'
                $claim = [IO.File]::Open($claimFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
                & (Join-Path $root 'Activate-KTKMCP.ps1')
            } finally { if ($null -ne $claim) { $claim.Dispose() } }
        } else {
            & (Join-Path $source 'Install-KTKMCP.ps1') -Enroll
        }
        $created = $true
        foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
            $entry = Assert-OwnService $name
            if ($entry.State -ne 'Running') { throw 'activated_service_not_running' }
        }
        if (Test-Path -LiteralPath (Join-Path $data 'state\emergency.lock')) { throw 'emergency_lock_still_enabled' }
        Record 'Activation: owner-approved enrollment and both services running'
        Record 'Reminder: real ChatGPT OAuth/MCP call still requires a separate owner acceptance'
    }
    $completed = $true
} catch {
    Record ('FAIL: ' + $_.Exception.Message)
    if (-not $created -and (Test-Path -LiteralPath $root)) { $created = $true }
    if ($created) { Record 'Recovery: installation retained for inspection; do not delete it manually' }
    throw
} finally {
    $state = if ($completed) { 'PASS' } else { 'FAIL' }
    $content = @("KTK Windows MCP acceptance: $state", ('Mode: ' + $(if ($Offline) { 'Offline' } else { 'Live' })), ('Date: ' + (Get-Date -Format 'u')), 'No passwords, identity keys or tokens are included.', '') + $steps.ToArray()
    [IO.File]::WriteAllLines($reportFile, [string[]]$content)
    Write-Output ("Acceptance {0}; report: {1}" -f $state, $reportFile)
}
