# One-time privileged bootstrap. Installer UAC approves this exact KTK helper;
# subsequent authenticated KTK releases are applied by its own SYSTEM service.
param([switch]$Live, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([bool]$Live -eq [bool]$CheckOnly) { throw 'choose_live_or_check_only' }
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $source 'Verify-KTKPackage.ps1') | Out-Null
$required = @('bin\node.exe','bin\WinSW.exe','runtime\remote-update.mjs','runtime\origin-auth.mjs',
  'runtime\Run-KTKUpdater.mjs','Run-KTKRemoteUpdate.ps1','services\KTKQwenUpdater.xml')
foreach ($file in $required) { if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw 'updater_payload_incomplete' } }
if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Build -lt 19045) { throw 'updater_windows_10_22h2_required' }
if ($CheckOnly) { Write-Output 'KTK updater payload verified, no Windows service touched.'; return }
if (-not [Environment]::Is64BitProcess) { throw 'updater_native_x64_required' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'updater_admin_required' }
$root = Join-Path $env:ProgramFiles 'KTK\Updater'
$data = Join-Path $env:ProgramData 'KTK\Updater'
$gateway = Join-Path $env:ProgramData 'KTK\QwenMCP\secrets\gateway.key'
if (-not (Test-Path -LiteralPath $gateway -PathType Leaf)) { throw 'updater_requires_enrolled_mcp' }
$existing = Get-CimInstance -ClassName Win32_Service -Filter "Name='KTKQwenUpdater'"
if ($existing) {
    $expected = Join-Path $root 'KTKQwenUpdater.exe'
    if ($existing.PathName.Trim().Trim('"') -ine $expected -or $existing.StartName -notmatch 'LocalSystem$' -or
        -not (Test-Path -LiteralPath (Join-Path $root 'runtime\remote-update.mjs') -PathType Leaf)) { throw 'updater_existing_service_not_owned' }
    if ($existing.State -ne 'Running') { Start-Service -Name 'KTKQwenUpdater' -ErrorAction Stop }
    Write-Output 'KTK updater already installed, no overwrite.'
    return
}
if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $data)) { throw 'unrecognized_updater_directory' }
$stage = Join-Path $env:ProgramFiles ('KTK\Updater.stage-' + [guid]::NewGuid().ToString('N'))
$installed = $false
$activated = $false
try {
    New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force -ErrorAction Stop | Out-Null
    foreach ($file in @('remote-update.mjs','origin-auth.mjs','Run-KTKUpdater.mjs')) {
        Copy-Item -LiteralPath (Join-Path $source ('runtime\' + $file)) -Destination (Join-Path $stage ('runtime\' + $file)) -ErrorAction Stop
    }
    Copy-Item -LiteralPath (Join-Path $source 'bin\node.exe') -Destination (Join-Path $stage 'bin\node.exe') -ErrorAction Stop
    Copy-Item -LiteralPath (Join-Path $source 'bin\WinSW.exe') -Destination (Join-Path $stage 'KTKQwenUpdater.exe') -ErrorAction Stop
    Copy-Item -LiteralPath (Join-Path $source 'services\KTKQwenUpdater.xml') -Destination (Join-Path $stage 'KTKQwenUpdater.xml') -ErrorAction Stop
    Copy-Item -LiteralPath (Join-Path $source 'Run-KTKRemoteUpdate.ps1') -Destination (Join-Path $stage 'Run-KTKRemoteUpdate.ps1') -ErrorAction Stop
    & icacls.exe $stage '/T' '/C' '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'updater_code_acl_failed' }
    New-Item -ItemType Directory -Path $data -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $data 'logs') -ErrorAction Stop | Out-Null
    & icacls.exe $data '/T' '/C' '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'updater_data_acl_failed' }
    [IO.Directory]::Move($stage, $root)
    & (Join-Path $root 'KTKQwenUpdater.exe') install
    if ($LASTEXITCODE -ne 0) { throw ('updater_service_install_failed_exit_{0}' -f $LASTEXITCODE) }
    $installed = $true
    Start-Service -Name 'KTKQwenUpdater' -ErrorAction Stop
    $activated = $true
    & sc.exe config KTKQwenUpdater start= delayed-auto | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'updater_autostart_failed' }
    Write-Output 'KTK restricted SYSTEM updater installed and running on localhost.'
} catch {
    if ($installed) {
        try { Stop-Service -Name 'KTKQwenUpdater' -ErrorAction SilentlyContinue } catch { }
        try { & (Join-Path $root 'KTKQwenUpdater.exe') uninstall | Out-Null } catch { }
    }
    # Only fresh owned directories created by this invocation may be removed.
    foreach ($dir in @($stage,$root,$data)) {
        if (Test-Path -LiteralPath $dir -PathType Container) {
            if (([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    throw
}
