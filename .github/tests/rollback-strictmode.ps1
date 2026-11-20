# Execute the real rolling-backup verification branch of Maintain-KTKMCP.ps1
# under PowerShell 5.1 StrictMode with no native $LASTEXITCODE defined.
# Uses only a disposable checksum fixture; no Windows services or real KTK data.
param(
    [Parameter(Mandatory=$true)][string]$MaintenancePath,
    [Parameter(Mandatory=$true)][string]$VerifierPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $MaintenancePath).Path, [ref]$tokens, [ref]$parseErrors
)
if ($null -ne $parseErrors -and $parseErrors.Count -gt 0) { throw 'maintenance_parse_failed' }

# Reuse the production directory validators, not test replacements.
foreach ($name in @('Assert-OrdinaryDirectory','Assert-NoLinks')) {
    $definitions = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw ('production_validator_missing_' + $name) }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$verifyBlocks = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text -match '^if \(\$rotatePrevious\)' -and
    $node.Extent.Text -match 'Verify-KTKPackage\.ps1'
}, $true))
if ($verifyBlocks.Count -ne 1) { throw 'rolling_backup_verification_branch_missing' }
$verify = [scriptblock]::Create($verifyBlocks[0].Extent.Text)

$previous = Join-Path ([IO.Path]::GetTempPath()) ('ktk-rollback-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $previous -ErrorAction Stop | Out-Null
try {
    Copy-Item -LiteralPath $VerifierPath -Destination (Join-Path $previous 'Verify-KTKPackage.ps1') -ErrorAction Stop
    $checksums = New-Object System.Collections.Generic.List[string]
    $names = @('Verify-KTKPackage.ps1')
    for ($i = 1; $i -le 10; $i++) {
        $name = 'fixture-' + $i + '.txt'
        [IO.File]::WriteAllText((Join-Path $previous $name), ('KTK-' + $i))
        $names += $name
    }
    foreach ($name in $names) {
        $file = Join-Path $previous $name
        $checksums.Add(((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $name))
    }
    [IO.File]::WriteAllLines((Join-Path $previous 'SHA256SUMS.txt'), [string[]]$checksums.ToArray())

    $rotatePrevious = $true
    Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    if ($null -ne (Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue)) { throw 'native_exit_code_not_clear' }
    & $verify
    if (-not $?) { throw 'valid_rolling_backup_rejected' }
    if ($null -ne (Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue)) { throw 'verification_invoked_native_process' }

    # A modified backup must fail closed before rotation.
    [IO.File]::AppendAllText((Join-Path $previous 'fixture-1.txt'), '-corrupted')
    $rejected = $false
    try { & $verify }
    catch {
        if ($_.Exception.Message -notmatch 'package_checksum_mismatch') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'corrupt_rolling_backup_accepted' }
    Write-Output 'KTK verified rollback StrictMode runtime PASS (valid and corrupt backup)'
} finally {
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction Stop }
}
