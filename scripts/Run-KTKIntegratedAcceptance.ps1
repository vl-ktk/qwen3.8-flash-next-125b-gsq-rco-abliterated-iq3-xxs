# Privileged MCP half of the single Setup.exe. Re-running the SAME candidate
# skips a verified, healthy MCP and proceeds to unfinished per-user AI work.
param([switch]$Live)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $Live) { throw 'integrated_live_explicit_only' }
if (-not [Environment]::Is64BitProcess) { throw 'native_x64_powershell_required' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'integrated_admin_required' }
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $source 'Verify-KTKPackage.ps1') | Out-Null
$candidate = Get-Content -LiteralPath (Join-Path $source 'MANIFEST.json') -Raw | ConvertFrom-Json
if ($candidate.schema -ne 1 -or $candidate.package_version -notmatch '^0\.18\.\d+$') { throw 'integrated_package_invalid' }
$root = Join-Path $env:ProgramFiles 'KTK\QwenMCP'
$data = Join-Path $env:ProgramData 'KTK\QwenMCP'
$installed = Join-Path $root 'MANIFEST.json'
$receipt = Join-Path $data 'state\enrollment.json'
$emergency = Join-Path $data 'state\emergency.lock'

if ((Test-Path -LiteralPath $installed -PathType Leaf) -and (Test-Path -LiteralPath $receipt -PathType Leaf)) {
    $current = Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json
    if ($current.schema -ne 1 -or $current.package_version -notmatch '^0\.18\.\d+$') { throw 'integrated_installed_version_invalid' }
    if ([version]$current.package_version -eq [version]$candidate.package_version) {
        & (Join-Path $root 'Verify-KTKPackage.ps1') | Out-Null
        if (Test-Path -LiteralPath $emergency) { throw 'integrated_existing_mcp_locked' }
        foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
            $service = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $name)
            $expected = Join-Path $root ($name + '.exe')
            if (-not $service -or $service.PathName.Trim().Trim('"') -ine $expected -or $service.StartName -notmatch 'LocalService$' -or $service.State -ne 'Running') { throw 'integrated_existing_mcp_not_healthy' }
        }
        Write-Output 'KTK: verified current MCP version; continue unfinished Local AI setup.'
        return
    }
    & (Join-Path $source 'Maintain-KTKMCP.ps1') -Action Update -PackagePath $source -Resume -InstallerApproved
    if ($LASTEXITCODE -ne 0) { throw 'integrated_mcp_upgrade_failed' }
} else {
    # The existing acceptance entry handles ONLY a truly fresh install or a
    # vetted staged enrollment. It refuses foreign services or unknown data.
    & (Join-Path $source 'Run-KTKAcceptance.ps1') -Live
    if ($LASTEXITCODE -ne 0) { throw 'integrated_mcp_enrollment_failed' }
}
