# Invoked only from the KTKQwenUpdater LocalSystem service after a gateway-
# approved offer and whole-artifact SHA-256 check. No interactive UAC.
param([Parameter(Mandatory=$true)][string]$ArtifactPath,
      [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$phase = 'preflight'
try {
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne 'S-1-5-18') { throw 'updater_requires_localsystem' }
if ($Version -cnotmatch '^0\.18\.[1-9][0-9]{0,3}$') { throw 'invalid_release_version' }
$data = Join-Path $env:ProgramData 'KTK\Updater'
$staged = [IO.Path]::GetFullPath($ArtifactPath)
$relative = $staged.Substring($data.Length).TrimStart('\')
if (-not $staged.StartsWith($data + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $relative -cnotmatch '^update-[A-Za-z0-9_-]{6,}\\artifact\.zip$') { throw 'untrusted_artifact_path' }
if (-not (Test-Path -LiteralPath $staged -PathType Leaf) -or
    ([IO.File]::GetAttributes($staged) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'untrusted_artifact_file' }
$work = Split-Path -Parent $staged
$outer = Join-Path $work 'outer'
$payload = Join-Path $work 'payload'
$phase = 'outer_archive'
New-Item -ItemType Directory -Path $outer -ErrorAction Stop | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($staged)
try {
    $allowed = @("KTK-Windows-MCP-$Version-win-x64.zip", "KTK-Windows-MCP-$Version-win-x64.zip.sha256")
    $entries = @($zip.Entries | ForEach-Object { $_.FullName })
    if ($entries.Count -ne 2 -or @($entries | Where-Object { $allowed -cnotcontains $_ }).Count -ne 0) { throw 'artifact_contents_unexpected' }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $staged -DestinationPath $outer -ErrorAction Stop
$phase = 'inner_checksum'
$inner = Join-Path $outer "KTK-Windows-MCP-$Version-win-x64.zip"
$checksum = (Get-Content -LiteralPath ($inner + '.sha256') -Raw).Trim()
$expected = '^([a-f0-9]{64})  ' + [regex]::Escape([IO.Path]::GetFileName($inner)) + '$'
if ($checksum -cmatch $expected) { $expectedHash = $Matches[1] } else { throw 'inner_checksum_format_invalid' }
if ((Get-FileHash -LiteralPath $inner -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) { throw 'inner_checksum_mismatch' }
$phase = 'payload_verification'
Expand-Archive -LiteralPath $inner -DestinationPath $payload -ErrorAction Stop
& (Join-Path $payload 'Verify-KTKPackage.ps1') | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $payload 'MANIFEST.json') -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.package_version -cne $Version -or $manifest.target -cne 'windows-x64') { throw 'release_manifest_mismatch' }
if (-not (Test-Path -LiteralPath (Join-Path $payload 'Apply-KTKUnifiedRelease.ps1') -PathType Leaf)) { throw 'unified_update_entrypoint_missing' }
$phase = 'maintenance'
& (Join-Path $payload 'Apply-KTKUnifiedRelease.ps1') -PackagePath $payload -Version $Version
} catch {
    # Machine-readable bounded diagnostics. No exception text, paths, tokens,
    # installation data or untrusted PowerShell output leave this boundary.
    $code = [string]$_.Exception.Message
    if ($code -cnotmatch '^[a-z][a-z0-9_]{2,63}$') { $code = 'powershell_exception' }
    [Console]::Error.WriteLine(('KTK_UPDATE_FAILURE:{0}:{1}' -f $phase, $code))
    # Record only the known KTK script category, line and .NET exception type.
    # Raw messages/paths are deliberately never exposed over MCP.
    $scriptName = [IO.Path]::GetFileName([string]$_.InvocationInfo.ScriptName)
    $scriptKey = switch -CaseSensitive ($scriptName) {
        'Run-KTKRemoteUpdate.ps1' { 'remote' }
        'Apply-KTKUnifiedRelease.ps1' { 'unified' }
        'Maintain-KTKMCP.ps1' { 'maintain' }
        'Verify-KTKPackage.ps1' { 'verify' }
        default { 'unknown' }
    }
    $line = [int]$_.InvocationInfo.ScriptLineNumber
    if ($line -lt 1 -or $line -gt 9999) { $line = 0 }
    $type = [string]$_.Exception.GetType().Name
    if ($type -cnotmatch '^[A-Za-z]{3,40}$') { $type = 'exception' }
    [Console]::Error.WriteLine(('KTK_UPDATE_CONTEXT:{0}:{1}:{2}' -f $scriptKey, $line, $type.ToLowerInvariant()))
    exit 1
}
