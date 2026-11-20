# Owner-approved activation following a successfully staged first install.
# The only network writes are HTTPS enrollment requests to the fixed Worker.
# Changes only the two KTK-owned services; never touches other cloudflared.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-NativeSuccess([string]$Action) {
    if ($LASTEXITCODE -ne 0) { throw ('{0}_exit_{1}' -f $Action, $LASTEXITCODE) }
}
function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'windows_required' }
if (-not (Test-Administrator)) {
    if ($PSCommandPath.Contains('"')) { throw 'unsafe_script_path' }
    $child = Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"') -Verb RunAs -Wait -PassThru
    if ($null -eq $child -or $child.ExitCode -ne 0) { throw 'activation_declined_or_failed' }
    return
}

$app = Join-Path $env:ProgramFiles 'KTK\QwenMCP'
$data = Join-Path $env:ProgramData 'KTK\QwenMCP'
$secrets = Join-Path $data 'secrets'
$state = Join-Path $data 'state'
$identity = Join-Path $secrets 'device-identity.json'
$receipt = Join-Path $state 'enrollment.json'
$gateway = Join-Path $secrets 'gateway.key'
$tunnel = Join-Path $secrets 'tunnel.token'
$lock = Join-Path $state 'emergency.lock'
$xmlFile = Join-Path $app 'KTKQwenMCP.xml'

foreach ($file in @($identity,$lock,$xmlFile)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'staged_install_not_ready' }
}
foreach ($service in @('KTKQwenMCP','KTKQwenTunnel')) {
    $entry = Get-Service -Name $service -ErrorAction SilentlyContinue
    if (-not $entry -or $entry.Status -ne 'Stopped') { throw 'service_not_staged_or_already_running' }
}
if ((Test-Path -LiteralPath $gateway) -or (Test-Path -LiteralPath $tunnel) -or (Test-Path -LiteralPath $receipt)) { throw 'existing_enrollment_requires_repair_step_17' }

# The enrollment process displays ONLY public code, fingerprint and URL; the
# owner approves via Worker page. Secrets are decrypted and saved locally.
& (Join-Path $app 'bin\node.exe') (Join-Path $app 'Enroll-KTKMCP.mjs') $identity $secrets $state
Assert-NativeSuccess 'enrollment'
$record = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
if ($record.schema -ne 1 -or [string]$record.device_id -cnotmatch '^[A-Za-z0-9_-]{32}$') { throw 'invalid_device_receipt' }

$xml = [xml](Get-Content -LiteralPath $xmlFile -Raw)
if ($xml.service.id -cne 'KTKQwenMCP' -or $xml.service.startmode -cne 'Manual' -or $xml.service.serviceaccount.user -cne 'LocalService') { throw 'unsafe_service_xml' }
if (@($xml.service.env | Where-Object { $_.name -eq 'QWEN_DEVICE_ID' }).Count -ne 0) { throw 'device_identity_already_set' }
$envItem = $xml.CreateElement('env')
$envItem.SetAttribute('name', 'QWEN_DEVICE_ID')
$envItem.SetAttribute('value', [string]$record.device_id)
$null = $xml.service.AppendChild($envItem)
$xml.Save($xmlFile)

try {
    # The emergency lock stays present until local credentials and XML exist.
    Remove-Item -LiteralPath $lock -ErrorAction Stop
    Start-Service -Name 'KTKQwenMCP' -ErrorAction Stop
    $healthy = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        try {
            & (Join-Path $app 'bin\node.exe') (Join-Path $app 'SelfTest-KTKMCP.mjs') $identity $receipt $gateway | Out-Null
            if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) { throw 'origin_selftest_failed' }

    Start-Service -Name 'KTKQwenTunnel' -ErrorAction Stop
    $connected = $false
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 2
        try {
            $metrics = (Invoke-WebRequest -Uri 'http://127.0.0.1:20241/metrics' -UseBasicParsing -TimeoutSec 2).Content
            $seen = [regex]::Matches($metrics, '(?m)^cloudflared_tunnel_ha_connections(?:\{[^\r\n}]*\})?\s+([0-9]+)')
            foreach ($match in $seen) { if ([int]$match.Groups[1].Value -gt 0) { $connected = $true; break } }
            if ($connected) { break }
        } catch { }
    }
    if (-not $connected) { throw 'tunnel_has_no_cloudflare_connection' }
    foreach ($service in @('KTKQwenMCP','KTKQwenTunnel')) {
        & sc.exe config $service start= delayed-auto | Out-Null
        Assert-NativeSuccess 'configure_delayed_autostart'
    }
    Write-Output 'KTK activation OK: owner-approved pairing, signed origin self-test, Tunnel edge connection, delayed autostart.'
    Write-Output 'NOTE: full ChatGPT OAuth -> VPC -> Windows live acceptance is still required.'
} catch {
    $failure = $_
    # Default-deny immediately, even if the SCM takes time to stop processes.
    if (-not (Test-Path -LiteralPath $lock)) { New-Item -ItemType File -Path $lock -ErrorAction SilentlyContinue | Out-Null }
    foreach ($service in @('KTKQwenTunnel','KTKQwenMCP')) {
        Stop-Service -Name $service -ErrorAction SilentlyContinue
        & sc.exe config $service start= demand | Out-Null
    }
    throw $failure
}
