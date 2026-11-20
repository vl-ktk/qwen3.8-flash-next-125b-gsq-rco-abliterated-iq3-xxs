# Read-only safety gate for resuming an interrupted FIRST enrollment.
# Never restarts an existing installation or overwrites any credentials.
param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Data)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($folder in @($Root, $Data, (Join-Path $Data 'secrets'), (Join-Path $Data 'state'))) {
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw 'staged_directory_missing' }
    if (([IO.File]::GetAttributes($folder) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staged_directory_link_denied' }
}
$manifest = Join-Path $Root 'MANIFEST.json'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'staged_manifest_missing' }
$version = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).package_version
if ($version -notin @('0.18.2','0.18.3','0.18.4','0.18.5','0.18.6','0.18.7','0.18.8','0.18.9')) { throw 'staged_version_not_resumable' }
# Verify using THIS verified installer script; never execute the installed
# verification script before checking it for tampering.
$checksums = Join-Path $Root 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $checksums -PathType Leaf)) { throw 'staged_checksums_missing' }
if (([IO.File]::GetAttributes($checksums) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staged_file_link_denied' }
$count = 0
foreach ($line in [IO.File]::ReadAllLines($checksums)) {
    if ($line -cnotmatch '^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9_./-]{0,180})$') { throw 'staged_checksums_invalid' }
    $expectedHash = $Matches[1]
    $relative = $Matches[2]
    if ($relative -match '(^|/)\.\.(/|$)|//') { throw 'staged_checksums_invalid' }
    $parts = $relative.Split('/')
    $cursor = $Root
    for ($i=0; $i -lt $parts.Length - 1; $i++) {
        $cursor = Join-Path $cursor $parts[$i]
        if (-not (Test-Path -LiteralPath $cursor -PathType Container)) { throw 'staged_file_missing' }
        if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staged_file_link_denied' }
    }
    $file = Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'staged_file_missing' }
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staged_file_link_denied' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) { throw 'staged_checksum_mismatch' }
    $count++
}
if ($count -lt 34) { throw 'staged_checksums_incomplete' }

foreach ($name in @('KTKQwenMCP','KTKQwenTunnel')) {
    $service = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $name)
    $expected = Join-Path $Root ($name + '.exe')
    if (-not $service -or $service.PathName.Trim().Trim('"') -ine $expected -or $service.StartName -notmatch 'LocalService$') { throw 'staged_service_ownership_mismatch' }
    if ($service.State -ne 'Stopped' -or $service.StartMode -ne 'Manual') { throw 'staged_service_state_mismatch' }
}
foreach ($file in @((Join-Path $Data 'secrets\device-identity.json'), (Join-Path $Data 'state\emergency.lock'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'staged_required_file_missing' }
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staged_file_link_denied' }
}
foreach ($file in @((Join-Path $Data 'secrets\gateway.key'), (Join-Path $Data 'secrets\tunnel.token'), (Join-Path $Data 'state\enrollment.json'))) {
    if (Test-Path -LiteralPath $file) { throw 'staged_partial_enrollment_needs_repair' }
}
Write-Output ('KTK resumable staged enrollment OK: ' + $version)
