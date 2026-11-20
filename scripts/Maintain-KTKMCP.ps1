# Owner-operated maintenance, step 17. Never invoked by a remote MCP tool.
# Requires an independently verified candidate ZIP extracted to a directory.
param(
    [Parameter(Mandatory=$true)][ValidateSet('Update','Repair','Rollback','Uninstall')][string]$Action,
    [string]$PackagePath,
    [switch]$Resume,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Exit([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw ("{0}_exit_{1}" -f $Operation, $LASTEXITCODE) }
}
function Assert-OrdinaryDirectory([string]$Folder) {
    if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { throw 'directory_missing' }
    if (([IO.File]::GetAttributes($Folder) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse_point_denied' }
}
function Assert-NoLinks([string]$Folder) {
    Assert-OrdinaryDirectory $Folder
    foreach ($item in (Get-ChildItem -LiteralPath $Folder -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'data_or_code_link_denied' }
        if ($item.PSIsContainer) { Assert-NoLinks $item.FullName }
    }
}
function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Set-CodeAcl([string]$Folder) {
    & icacls.exe $Folder '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
    Assert-Exit 'code_acl'
    & icacls.exe $Folder '/T' '/C' '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:RX' | Out-Null
    Assert-Exit 'recursive_code_acl'
}
function Set-ManualStopped {
    foreach ($name in @('KTKQwenTunnel','KTKQwenMCP')) {
        & sc.exe config $name start= demand | Out-Null
        Assert-Exit 'manual_service'
        $service = Get-Service -Name $name -ErrorAction Stop
        if ($service.Status -ne 'Stopped') {
            Stop-Service -Name $name -ErrorAction Stop
            $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }
    }
}
function Assert-OwnedServices([string]$Root) {
    foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
        $record = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $name)
        $expected = Join-Path $Root ($name + '.exe')
        if ($null -eq $record -or $record.PathName.Trim().Trim('"') -ine $expected -or $record.StartName -notmatch 'LocalService$') { throw 'unrecognized_service_refusing_change' }
    }
}
function Assert-FileTree([string]$Root, $Manifest) {
    foreach ($record in $Manifest.files) {
        $relative = [string]$record.path
        if ($relative -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_./-]{0,180}$' -or $relative -match '(^|/)\.\.(/|$)|//') { throw 'unsafe_manifest_path' }
        $parts = $relative.Split('/')
        $parent = $Root
        for ($i=0; $i -lt $parts.Length-1; $i++) {
            $parent = Join-Path $parent $parts[$i]
            Assert-OrdinaryDirectory $parent
        }
        $inputFile = Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $inputFile -PathType Leaf)) { throw 'package_file_missing' }
        if (([IO.File]::GetAttributes($inputFile) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'package_link_denied' }
        if ((Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$record.sha256) { throw 'manifest_checksum_mismatch' }
    }
}
function Test-Enrollment {
    return (Test-Path -LiteralPath $receipt -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $data 'secrets\gateway.key') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $data 'secrets\tunnel.token') -PathType Leaf)
}
function Set-DeviceXml([string]$Root) {
    if (-not (Test-Enrollment)) { return }
    $record = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($record.schema -ne 1 -or [string]$record.device_id -cnotmatch '^[A-Za-z0-9_-]{32}$') { throw 'invalid_enrollment_receipt' }
    $file = Join-Path $Root 'KTKQwenMCP.xml'
    $xml = [xml](Get-Content -LiteralPath $file -Raw)
    if ($xml.service.id -cne 'KTKQwenMCP' -or $xml.service.startmode -cne 'Manual' -or $xml.service.serviceaccount.user -cne 'LocalService') { throw 'unsafe_service_xml' }
    if (@($xml.service.env | Where-Object { $_.name -eq 'QWEN_DEVICE_ID' }).Count -ne 0) { throw 'duplicate_device_environment' }
    $item = $xml.CreateElement('env')
    $item.SetAttribute('name', 'QWEN_DEVICE_ID')
    $item.SetAttribute('value', [string]$record.device_id)
    $null = $xml.service.AppendChild($item)
    $xml.Save($file)
}
function Assert-RunningHealthy([string]$Root) {
    if (-not (Test-Enrollment)) { throw 'enrollment_not_ready' }
    Remove-Item -LiteralPath $lock -ErrorAction Stop
    Start-Service -Name 'KTKQwenMCP' -ErrorAction Stop
    $healthy = $false
    for ($i=0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        & (Join-Path $Root 'bin\node.exe') (Join-Path $Root 'SelfTest-KTKMCP.mjs') (Join-Path $data 'secrets\device-identity.json') $receipt (Join-Path $data 'secrets\gateway.key') | Out-Null
        if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    }
    if (-not $healthy) { throw 'mcp_selftest_failed' }
    Start-Service -Name 'KTKQwenTunnel' -ErrorAction Stop
    $connected = $false
    for ($i=0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 2
        try {
            $metrics = (Invoke-WebRequest -Uri 'http://127.0.0.1:20241/metrics' -UseBasicParsing -TimeoutSec 2).Content
            foreach ($m in [regex]::Matches($metrics, '(?m)^cloudflared_tunnel_ha_connections(?:\{[^\r\n}]*\})?\s+([0-9]+)')) {
                if ([int]$m.Groups[1].Value -gt 0) { $connected = $true; break }
            }
            if ($connected) { break }
        } catch { }
    }
    if (-not $connected) { throw 'tunnel_health_failed' }
    foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
        & sc.exe config $name start= delayed-auto | Out-Null
        Assert-Exit 'delayed_autostart'
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Build -lt 19045) { throw 'unsupported_windows' }
if (-not $env:ProgramFiles -or -not $env:ProgramData) { throw 'windows_paths_missing' }
if ($Action -in @('Update','Repair')) {
    if (-not $PackagePath) { throw 'package_path_required' }
    $PackagePath = [IO.Path]::GetFullPath($PackagePath)
    Assert-OrdinaryDirectory $PackagePath
    & (Join-Path $PackagePath 'Verify-KTKPackage.ps1') | Out-Null
    $manifest = Get-Content -LiteralPath (Join-Path $PackagePath 'MANIFEST.json') -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.target -cne 'windows-x64' -or $manifest.package_version -notmatch '^0\.17\.\d+$' -or $manifest.ready_for_installation -ne $false) { throw 'candidate_manifest_invalid' }
    Assert-FileTree $PackagePath $manifest
} elseif ($PackagePath) { throw 'package_not_used_by_action' }
if ($Resume -and $Action -eq 'Uninstall') { throw 'uninstall_cannot_resume' }
if ($CheckOnly) {
    if ($Action -notin @('Update','Repair') -or $Resume) { throw 'check_only_requires_package_and_no_resume' }
    Write-Output 'KTK maintenance candidate OK: offline package manifest and SHA256; no Windows services touched.'
    return
}

if (-not (Test-Administrator)) {
    if ($PSCommandPath.Contains('"') -or $PackagePath.Contains('"')) { throw 'unsafe_script_or_package_path' }
    $args = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $Action
    if ($PackagePath) { $args += ' -PackagePath "' + $PackagePath + '"' }
    if ($Resume) { $args += ' -Resume' }
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $args -Wait -PassThru
    if ($null -eq $child -or $child.ExitCode -ne 0) { throw 'maintenance_elevation_declined_or_failed' }
    return
}

$root = Join-Path $env:ProgramFiles 'KTK\QwenMCP'
$previous = Join-Path $env:ProgramFiles 'KTK\QwenMCP.previous'
$data = Join-Path $env:ProgramData 'KTK\QwenMCP'
$receipt = Join-Path $data 'state\enrollment.json'
$lock = Join-Path $data 'state\emergency.lock'
$rootExists = Test-Path -LiteralPath $root
if ($rootExists) { Assert-OrdinaryDirectory $root }
elseif ($Action -ne 'Rollback') { throw 'installation_root_missing' }
Assert-OrdinaryDirectory $data
Assert-OrdinaryDirectory (Join-Path $data 'state')
Assert-OwnedServices $root
if ($Action -in @('Update','Repair') -and (Test-Path -LiteralPath $previous)) { throw 'previous_version_exists_rollback_first' }
if ($Action -eq 'Rollback') { Assert-OrdinaryDirectory $previous }
if ($Action -in @('Update','Repair')) {
    $oldManifest = Get-Content -LiteralPath (Join-Path $root 'MANIFEST.json') -Raw | ConvertFrom-Json
    if ($oldManifest.schema -ne 1 -or [string]$oldManifest.package_version -notmatch '^0\.\d{2}\.\d+$') { throw 'installed_version_unknown' }
    $fromVersion = [version][string]$oldManifest.package_version
    $toVersion = [version][string]$manifest.package_version
    if ($Action -eq 'Update' -and $toVersion -le $fromVersion) { throw 'update_requires_newer_version' }
    if ($Action -eq 'Repair' -and $toVersion -ne $fromVersion) { throw 'repair_requires_same_version' }
}
if ($Resume) {
    if (Test-Path -LiteralPath $lock) { throw 'resume_refuses_existing_emergency_lock' }
    if (-not (Test-Enrollment)) { throw 'resume_requires_enrollment' }
    foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
        if ((Get-Service -Name $name -ErrorAction Stop).Status -ne 'Running') { throw 'resume_requires_running_services' }
    }
}

# Noninteractive execution is forbidden, even for unattended elevation.
if (-not [Environment]::UserInteractive) { throw 'interactive_session_required' }
$confirmation = Read-Host ("Type {0} to confirm KTK maintenance" -f $Action.ToUpperInvariant())
if ($confirmation -cne $Action.ToUpperInvariant()) { throw 'confirmation_declined' }
if ($Action -eq 'Uninstall') {
    if ((Read-Host 'Type ERASE-KTK-DATA to permanently remove local identity and credentials') -cne 'ERASE-KTK-DATA') { throw 'erase_confirmation_declined' }
    Assert-NoLinks $root
    Assert-NoLinks $data
    if (Test-Path -LiteralPath $previous) { Assert-NoLinks $previous }
}

# Fail closed on interrupted maintenance, regardless of whether services stop.
if (-not (Test-Path -LiteralPath $lock)) { New-Item -ItemType File -Path $lock -ErrorAction Stop | Out-Null }
Set-ManualStopped
if ($Action -eq 'Uninstall') {
    # No local credential deletion if the Worker did not explicitly revoke the pairing.
    if (Test-Path -LiteralPath $receipt -PathType Leaf) {
        & (Join-Path $root 'bin\node.exe') (Join-Path $root 'Revoke-KTKMCP.mjs') (Join-Path $data 'secrets\device-identity.json') $receipt
        Assert-Exit 'remote_revoke_required'
    }
    foreach ($name in @('KTKQwenTunnel','KTKQwenMCP')) {
        & (Join-Path $root ($name + '.exe')) uninstall | Out-Null
        Assert-Exit 'service_uninstall'
    }
    # These exact KTK-owned paths were checked before removal; no wildcard paths.
    if (Test-Path -LiteralPath $previous) { Assert-OrdinaryDirectory $previous; Remove-Item -LiteralPath $previous -Recurse -Force }
    Remove-Item -LiteralPath $root -Recurse -Force
    Remove-Item -LiteralPath $data -Recurse -Force
    Write-Output 'KTK uninstall OK: remote device revoked (if enrolled), own services and local data removed.'
    return
}

$stage = Join-Path $env:ProgramFiles ('KTK\QwenMCP.stage-' + [guid]::NewGuid().ToString('N'))
$failed = Join-Path $env:ProgramFiles ('KTK\QwenMCP.failed-' + [guid]::NewGuid().ToString('N'))
$stageCreated = $false
$oldMoved = $false
$newMoved = $false
try {
    if ($Action -in @('Update','Repair')) {
        New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
        $stageCreated = $true
        foreach ($entry in $manifest.files) {
            $relative = [string]$entry.path
            $sourceFile = Join-Path $PackagePath ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
            $target = Join-Path $stage ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath $sourceFile -Destination $target -ErrorAction Stop
        }
        foreach ($name in @('MANIFEST.json','SHA256SUMS.txt')) { Copy-Item -LiteralPath (Join-Path $PackagePath $name) -Destination $stage }
        & (Join-Path $stage 'Verify-KTKPackage.ps1') | Out-Null
        Copy-Item -LiteralPath (Join-Path $stage 'bin\WinSW.exe') -Destination (Join-Path $stage 'KTKQwenMCP.exe')
        Copy-Item -LiteralPath (Join-Path $stage 'bin\WinSW.exe') -Destination (Join-Path $stage 'KTKQwenTunnel.exe')
        foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) { Copy-Item -LiteralPath (Join-Path $stage ('services\' + $name + '.xml')) -Destination (Join-Path $stage ($name + '.xml')) }
        Set-DeviceXml $stage
        Set-CodeAcl $stage
        [IO.Directory]::Move($root, $previous)
        $oldMoved = $true
        [IO.Directory]::Move($stage, $root)
        $newMoved = $true
    } else {
        # Recover interrupted swaps where the original root was already moved
        # to QwenMCP.previous before a power loss.
        if (Test-Path -LiteralPath $root) {
            [IO.Directory]::Move($root, $failed)
            $oldMoved = $true
        }
        [IO.Directory]::Move($previous, $root)
        $newMoved = $true
    }
    if ($Resume) {
        Assert-RunningHealthy $root
        Write-Output ('KTK {0} OK: local signed self-test, Tunnel HA and delayed autostart passed.' -f $Action)
    } else {
        Write-Output ('KTK {0} prepared. Services Manual/Stopped and emergency-locked.' -f $Action)
    }
    Write-Output 'The previous version is preserved for rollback; no user data was overwritten.'
} catch {
    $failure = $_
    # A failed self-test must lock and stop BOTH services before moving executables.
    if (-not (Test-Path -LiteralPath $lock)) { New-Item -ItemType File -Path $lock -ErrorAction SilentlyContinue | Out-Null }
    try { Set-ManualStopped } catch { }
    if ($newMoved -and (Test-Path -LiteralPath $root)) { [IO.Directory]::Move($root, $failed) }
    if ($oldMoved) {
        if ($Action -eq 'Rollback' -and (Test-Path -LiteralPath $failed)) { [IO.Directory]::Move($failed, $root) }
        if ($Action -ne 'Rollback' -and (Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $root)) { [IO.Directory]::Move($previous, $root) }
    }
    if ($stageCreated -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    throw $failure
}
