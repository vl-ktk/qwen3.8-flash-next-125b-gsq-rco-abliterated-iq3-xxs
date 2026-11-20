# Called only by the elevated owner Setup after its explicit installation-mode
# choice. SYSTEM may schedule future user-scoped AI updates only after a
# completed local AI acceptance, never merely because the updater task exists.
param([switch]$Enable, [switch]$Disable, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $CheckOnly -and ([bool]$Enable -eq [bool]$Disable)) { throw 'local_ai_choice_required' }
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $source 'Verify-KTKPackage.ps1') | Out-Null
if ($CheckOnly) { Write-Output 'Local AI owner consent helper verified; no changes.'; return }
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) { throw 'local_ai_consent_requires_x64' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'local_ai_consent_requires_admin' }
$directory = Join-Path $env:ProgramData 'KTK\Updater'
if (-not (Test-Path -LiteralPath $directory -PathType Container) -or
    ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'local_ai_consent_updater_missing' }
$acl = Get-Acl -LiteralPath $directory
if (-not $acl.AreAccessRulesProtected) { throw 'local_ai_consent_acl_untrusted' }
foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $ace.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'local_ai_consent_acl_untrusted' }
}
$target = Join-Path $directory 'local-ai-opt-in.json'
if ((Test-Path -LiteralPath $target) -and
    ((-not (Test-Path -LiteralPath $target -PathType Leaf)) -or
     ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'local_ai_consent_marker_untrusted' }
$enabled = [bool]$Enable
$body = @{schema=1;enabled=$enabled} | ConvertTo-Json -Compress
$temp = Join-Path $directory ('consent-' + [guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($temp, $body, (New-Object System.Text.UTF8Encoding($false)))
if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temp, $target, $null) }
else { [IO.File]::Move($temp, $target) }
# /grant:r only replaces entries for the specified principals; it does NOT
# remove other explicit grants retained by File.Replace from a legacy file.
# Reset the inherited DACL first, then build a protected SYSTEM/Admin-only DACL.
& icacls.exe $target '/reset' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'local_ai_consent_marker_acl_reset_failed' }
& icacls.exe $target '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'local_ai_consent_marker_acl_failed' }
$finalAcl = Get-Acl -LiteralPath $target
if (-not $finalAcl.AreAccessRulesProtected) { throw 'local_ai_consent_marker_acl_untrusted' }
foreach ($ace in $finalAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $ace.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'local_ai_consent_marker_acl_untrusted' }
}
# After closing any legacy write access, ensure the protected file contains
# exactly the owner's intended consent state, not bytes written in a race.
[IO.File]::WriteAllText($target, $body, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $(if ($enabled) { 'KTK local AI future updates approved.' } else { 'KTK local AI future updates disabled.' })
