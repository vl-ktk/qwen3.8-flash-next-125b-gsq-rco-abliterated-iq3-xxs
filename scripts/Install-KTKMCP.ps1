# Stage-only, first-install Windows x64 MCP service installer (step 16).
# Intentionally NO cloud/production writes, no secret provisioning, no service start.
# Run from an extracted, independently SHA256-verified package.
param([switch]$CheckOnly, [switch]$Enroll)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($CheckOnly -and $Enroll) { throw 'choose_check_only_or_enroll' }

function Assert-NativeSuccess([string]$Action) {
    if ($LASTEXITCODE -ne 0) { throw ("{0}_failed_exit_{1}" -f $Action, $LASTEXITCODE) }
}
function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Set-ProtectedAcl([string]$Target, [bool]$ServiceWrite) {
    if ($ServiceWrite) {
        & icacls.exe $Target '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
    } else {
        & icacls.exe $Target '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
    }
    Assert-NativeSuccess 'acl'
}
function Assert-OrdinaryDirectory([string]$Target) {
    if (-not (Test-Path -LiteralPath $Target -PathType Container)) { throw 'package_directory_missing' }
    $attrs = [IO.File]::GetAttributes($Target)
    if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse_directory_denied' }
}

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'windows_required' }
if ([Environment]::Is64BitOperatingSystem -ne $true -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'windows_x64_required' }
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19045) { throw 'windows_10_22h2_or_11_required' }
if (-not $env:ProgramFiles -or -not $env:ProgramData) { throw 'windows_paths_missing' }
Assert-OrdinaryDirectory $source
& (Join-Path $source 'Verify-KTKPackage.ps1') | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $source 'MANIFEST.json') -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.target -cne 'windows-x64' -or $manifest.package_version -notmatch '^0\.16\.\d+$') { throw 'package_manifest_invalid' }
foreach ($relative in @('bin','runtime','licenses','config','services')) { Assert-OrdinaryDirectory (Join-Path $source $relative) }

$installRoot = Join-Path $env:ProgramFiles 'KTK\QwenMCP'
$dataRoot = Join-Path $env:ProgramData 'KTK\QwenMCP'
$stage = Join-Path $env:ProgramFiles ("KTK\QwenMCP.stage-{0}" -f ([guid]::NewGuid().ToString('N')))
if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $dataRoot)) { throw 'existing_install_requires_repair_step_17' }
foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'service_name_already_in_use' }
}
if ((Get-PSDrive -Name ([IO.Path]::GetPathRoot($installRoot)).Substring(0,1)).Free -lt 600MB) { throw 'disk_space_below_600mb' }

$listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 8765)
try { $listener.Start() } catch { throw 'local_mcp_port_8765_busy' } finally { $listener.Stop() }
if ($CheckOnly) { Write-Output 'KTK preflight OK: package, OS, x64, free disk, port, service names'; return }

if (-not (Test-Administrator)) {
    # No mutable action occurs until the UAC elevation succeeds.
    if ($PSCommandPath.Contains('"')) { throw 'unsafe_script_path' }
    $argument = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"' + $(if ($Enroll) { ' -Enroll' } else { '' })
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argument -Wait -PassThru
    if ($null -eq $child -or $child.ExitCode -ne 0) { throw 'elevated_installer_failed_or_declined' }
    return
}

$stageCreated = $false
$installed = New-Object System.Collections.Generic.List[string]
$installMoved = $false
$dataCreated = $false
try {
    # Refuse to overwrite installations introduced between preflight and elevation.
    if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $dataRoot)) { throw 'existing_install_requires_repair_step_17' }
    foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'service_name_already_in_use' }
    }
    New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
    $stageCreated = $true
    # Strict manifest allowlist. Extra source files, links or junctions are not copied.
    foreach ($record in $manifest.files) {
        $relative = [string]$record.path
        if ($relative -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_./-]{0,180}$' -or $relative -match '(^|/)\.\.(/|$)|//') { throw 'unsafe_manifest_path' }
        $parts = $relative.Split('/')
        $cursor = $source
        for ($i = 0; $i -lt $parts.Length - 1; $i++) {
            $cursor = Join-Path $cursor $parts[$i]
            Assert-OrdinaryDirectory $cursor
        }
        $sourceFile = Join-Path $source ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $attributes = [IO.File]::GetAttributes($sourceFile)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw 'source_file_is_link_or_directory' }
        $targetFile = Join-Path $stage ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $parent = Split-Path -Parent $targetFile
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath $sourceFile -Destination $targetFile -ErrorAction Stop
    }
    foreach ($relative in @('MANIFEST.json','SHA256SUMS.txt')) {
        Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $stage -ErrorAction Stop
    }
    & (Join-Path $stage 'Verify-KTKPackage.ps1') | Out-Null
    Copy-Item -LiteralPath (Join-Path $stage 'bin\WinSW.exe') -Destination (Join-Path $stage 'KTKQwenMCP.exe')
    Copy-Item -LiteralPath (Join-Path $stage 'bin\WinSW.exe') -Destination (Join-Path $stage 'KTKQwenTunnel.exe')
    Copy-Item -LiteralPath (Join-Path $stage 'services\KTKQwenMCP.xml') -Destination (Join-Path $stage 'KTKQwenMCP.xml')
    Copy-Item -LiteralPath (Join-Path $stage 'services\KTKQwenTunnel.xml') -Destination (Join-Path $stage 'KTKQwenTunnel.xml')
    # Only SYSTEM/Administrators may alter the code; LocalService can read it.
    Set-ProtectedAcl $stage $false
    & icacls.exe $stage '/T' '/C' '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:RX' | Out-Null
    Assert-NativeSuccess 'acl_recursive'

    # Never force-merge a newly appeared destination: catch races without deleting user data.
    if (Test-Path -LiteralPath $dataRoot) { throw 'existing_install_requires_repair_step_17' }
    New-Item -ItemType Directory -Path $dataRoot -ErrorAction Stop | Out-Null
    $dataCreated = $true
    Set-ProtectedAcl $dataRoot $false
    foreach ($leaf in @('secrets','state','logs')) {
        $folder = New-Item -ItemType Directory -Path (Join-Path $dataRoot $leaf) -ErrorAction Stop
        Set-ProtectedAcl $folder.FullName ($leaf -eq 'logs')
    }
    $identityPath = Join-Path $dataRoot 'secrets\device-identity.json'
    & (Join-Path $stage 'bin\node.exe') (Join-Path $stage 'Generate-KTKIdentity.mjs') $identityPath
    Assert-NativeSuccess 'device_identity'
    & icacls.exe $identityPath '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:R' | Out-Null
    Assert-NativeSuccess 'identity_acl'
    # New instances remain emergency-locked until owner-approved remote provisioning.
    New-Item -ItemType File -Path (Join-Path $dataRoot 'state\emergency.lock') -ErrorAction Stop | Out-Null
    [IO.Directory]::Move($stage, $installRoot)
    $installMoved = $true
    foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
        & (Join-Path $installRoot ($name + '.exe')) install
        Assert-NativeSuccess 'service_install'
        $installed.Add($name)
        & sc.exe config $name start= demand | Out-Null
        Assert-NativeSuccess 'service_manual_start'
    }
    # Validate no service unexpectedly started by installation.
    foreach ($name in $installed) {
        if ((Get-Service -Name $name).Status -ne 'Stopped') { throw 'service_started_without_owner_provisioning' }
    }
    Write-Output 'KTK staged installation OK: services Manual/Stopped; emergency lock present.'
    Write-Output 'PENDING: owner must provision Worker HMAC + Tunnel token and approve device before activation.'
} catch {
    $failure = $_
    # Roll back ONLY this fresh attempt. No generic cloudflared or other service is touched.
    for ($i = $installed.Count - 1; $i -ge 0; $i--) {
        $name = $installed[$i]
        $wrapper = Join-Path $installRoot ($name + '.exe')
        if (Test-Path -LiteralPath $wrapper) { & $wrapper uninstall | Out-Null }
    }
    if ($installMoved -and (Test-Path -LiteralPath $installRoot)) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
    if ($stageCreated -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if ($dataCreated -and (Test-Path -LiteralPath $dataRoot)) { Remove-Item -LiteralPath $dataRoot -Recurse -Force }
    throw $failure
}

if ($Enroll) {
    # Activation runs AFTER the staged-install rollback boundary. A failed
    # network enrollment leaves the new instance Manual/Stopped + locked,
    # not an unprotected partially configured service.
    & (Join-Path $installRoot 'Activate-KTKMCP.ps1')
}
