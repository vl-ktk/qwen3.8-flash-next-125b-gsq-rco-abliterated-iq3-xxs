# Offline integrity check; never elevates, downloads or installs anything.
$ErrorActionPreference = 'Stop'
$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $folder 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'missing_package_checksums' }
$count = 0
foreach ($line in [IO.File]::ReadAllLines($manifest)) {
    if ($line -cnotmatch '^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9_./-]{0,180})$') { throw 'invalid_package_checksums' }
    $expected = $Matches[1]
    $relative = $Matches[2]
    if ($relative -match '(^|/)\.\.(/|$)' -or $relative.Contains('//')) { throw 'invalid_package_path' }
    $target = Join-Path $folder ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'package_file_missing' }
    $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $expected) { throw 'package_checksum_mismatch' }
    $count++
}
if ($count -lt 10) { throw 'incomplete_package' }
Write-Output ("KTK package integrity OK: {0} files" -f $count)
