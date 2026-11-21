import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const setup = readFileSync(new URL("../../config/KTK-Setup.iss", import.meta.url), "utf8");
const maintenance = readFileSync(new URL("../../scripts/Maintain-KTKMCP.ps1", import.meta.url), "utf8");
const integrated = readFileSync(new URL("../../scripts/Run-KTKIntegratedAcceptance.ps1", import.meta.url), "utf8");
const staged = readFileSync(new URL("../../scripts/Assert-KTKStaged.ps1", import.meta.url), "utf8");
const packageLock = JSON.parse(readFileSync(new URL("../../config/windows-package.lock.json", import.meta.url), "utf8"));
const windowsCi = readFileSync(new URL("../../.github/workflows/windows-package.yml", import.meta.url), "utf8");
const localAiGui = readFileSync(new URL("../../scripts/Show-KTKLocalAI.ps1", import.meta.url), "utf8");
const consent = readFileSync(new URL("../../scripts/Set-KTKLocalAIOptIn.ps1", import.meta.url), "utf8");
const unified = readFileSync(new URL("../../scripts/Apply-KTKUnifiedRelease.ps1", import.meta.url), "utf8");
const userUpdater = readFileSync(new URL("../../scripts/Run-KTKUserUpdate.mjs", import.meta.url), "utf8");

test("integrated live installer defaults to MCP-only and requires explicit AI selection", () => {
  assert.match(setup, /Mode = '-Live'[\s\S]*?Run-KTKIntegratedAcceptance\.ps1/);
  assert.match(setup, /CreateInputOptionPage\(wpWelcome/);
  assert.match(setup, /InstallModePage\.Values\[0\] := True/);
  assert.match(setup, /if InstallModePage\.Values\[1\] then begin[\s\S]*?Show-KTKLocalAI\.ps1/);
  assert.match(setup, /ExitCode = 2 then[\s\S]*?Owner cancelled local AI safely/);
  assert.match(setup, /ExecAsOriginalUser\(UserPowerShell[\s\S]*?ewWaitUntilTerminated/);
  assert.match(setup, /Show-KTKLocalAI\.ps1/);
  assert.match(setup, /Install-KTKUserUpdater\.ps1/);
  assert.match(setup, /ExecAsOriginalUser\(UserPowerShell[\s\S]*?Local AI installation incomplete/);
  assert.match(integrated, /state\\enrollment\.json/);
  assert.match(integrated, /Maintain-KTKMCP\.ps1/);
  assert.match(integrated, /-Action Update -PackagePath \$source -Resume -InstallerApproved/);
  assert.match(integrated, /if \(\[version\]\$current\.package_version -eq \[version\]\$candidate\.package_version\)/);
  assert.match(integrated, /Verify-KTKPackage\.ps1/);
  assert.match(setup, /Run-KTKAcceptance\.ps1/);
  assert.match(setup, /Mode := '-Offline'/);
  assert.match(localAiGui, /cancel-request\.txt/);
  assert.match(localAiGui, /localai_user_cancelled/);
  assert.match(localAiGui, /\$result\.runtime_state -eq 'stopped'/);
  assert.match(localAiGui, /if \(\$script:cancelled\) \{ exit 2 \}/);
});

test("remote MCP updates never start local model download without completed owner opt-in", () => {
  assert.match(setup, /Set-KTKLocalAIOptIn\.ps1/);
  assert.match(setup, /LocalAIConsent \+ '" -Disable'/);
  assert.match(setup, /if ExitCode <> 0 then[\s\S]*?LocalAIConsent \+ '" -Enable'/);
  assert.match(consent, /Verify-KTKPackage\.ps1/);
  assert.match(consent, /local-ai-opt-in\.json/);
  assert.match(consent, /AreAccessRulesProtected/);
  assert.match(unified, /\$doLocalAI = \$false/);
  assert.match(unified, /local-ai-opt-in\.json/);
  assert.match(unified, /if \(\$doLocalAI\) \{[\s\S]*?KTK_USER_UPDATE_QUEUED/);
  assert.match(unified, /KTK_MCP_UPDATE_ONLY/);
});

test("untrusted local AI consent never blocks an authorized MCP-only update", () => {
  // Live 0.18.13 acceptance found a pre-existing opt-in ACL that the old
  // elevated writer did not fully normalize. An untrusted marker must NEVER
  // be interpreted as model-download consent, but must not brick MCP updates.
  assert.match(unified, /if \(Test-Path -LiteralPath \$optInFile\) \{\s*try \{/);
  assert.match(unified, /unified_update_local_ai_acl_untrusted/);
  assert.match(unified, /catch \{[\s\S]*?\$doLocalAI = \$false\s*Write-Output 'KTK_LOCAL_AI_OPT_IN_IGNORED_MCP_ONLY'/);
  assert.match(unified, /if \(\$doLocalAI\) \{[\s\S]*?KTK_USER_UPDATE_QUEUED/);
  assert.match(unified, /\} else \{\s*Write-Output 'KTK_MCP_UPDATE_ONLY'/);
  assert.match(consent, /icacls\.exe \$target '\/reset'/);
  assert.match(consent, /\[IO\.File\]::Replace\(\$temp, \$target, \$backup\)/);
  assert.doesNotMatch(consent, /\[IO\.File\]::Replace\(\$temp, \$target, \$null\)/);
  assert.match(consent, /\$finalAcl = Get-Acl -LiteralPath \$target/);
  assert.match(consent, /\$ace\.IdentityReference\.Value -notin @\('S-1-5-18','S-1-5-32-544'\)/);
  assert.match(windowsCi, /Injected untrusted local AI grant was not removed/);
});

test("unattended updates never call first-install inference, including with an obsolete user runner", () => {
  assert.doesNotMatch(userUpdater, /await invoke\(command, \[script, "--install", "--installer-approved"\]/);
  assert.match(userUpdater, /\["Install-KTKStrata\.mjs", \["--install", "--installer-approved"\]/);
  assert.match(userUpdater, /\["Prepare-KTKSC117\.mjs", \["--prepare", "--installer-approved"\]/);
  assert.match(unified, /\$safeRunner = Join-Path \$PackagePath 'Run-KTKUserUpdate\.mjs'/);
  assert.match(unified, /Get-FileHash -LiteralPath \$expectedUserScript -Algorithm SHA256/);
  assert.match(unified, /if \(-not \$runnerReady\) \{\s*\$doLocalAI = \$false/);
  assert.match(unified, /KTK_LOCAL_AI_USER_RUNNER_NEEDS_SETUP_MCP_ONLY/);
  assert.match(setup, /if InstallModePage\.Values\[1\] then begin[\s\S]*?Show-KTKLocalAI\.ps1/);
  assert.match(localAiGui, /--install', '--installer-approved'/);
});

test("one-click approval cannot enable unrelated maintenance operations", () => {
  assert.match(maintenance, /\$InstallerApproved -and \(\$Action -ne 'Update' -or -not \$Resume -or \$CheckOnly\)/);
  assert.match(maintenance, /if \(-not \$UpdaterApproved -and -not \[Environment\]::UserInteractive\)/);
  assert.match(maintenance, /if \(-not \$InstallerApproved -and -not \$UpdaterApproved\) \{[\s\S]*?Read-Host/);
  assert.match(maintenance, /previous_version_exists_rollback_first/);
  assert.match(maintenance, /Original KTK version restored and healthy after failed update/);
  assert.match(maintenance, /if \(Test-Path -LiteralPath \$lock\) \{ throw 'resume_refuses_existing_emergency_lock' \}/);
});

test("owner-run live upgrade rotates a preexisting verified rollback only after staging the replacement", () => {
  assert.match(maintenance, /\$approvedRollingUpdate = \$Action -eq 'Update' -and \$Resume -and \(\$InstallerApproved -or \$UpdaterApproved\)/);
  assert.match(maintenance, /if \(-not \$approvedRollingUpdate -and \$Action -in @\('Update','Repair'\) -and \(Test-Path -LiteralPath \$previous\)\) \{ throw 'previous_version_exists_rollback_first' \}/);
  assert.match(maintenance, /\$rotatePrevious = \$approvedRollingUpdate -and \(Test-Path -LiteralPath \$previous\)/);
  const verifies = maintenance.indexOf("if ($rotatePrevious) {");
  const checksBackup = maintenance.indexOf("Assert-NoLinks $previous", verifies);
  const verifiesBackup = maintenance.indexOf("& (Join-Path $previous 'Verify-KTKPackage.ps1')", verifies);
  // Service stop is inside the guarded transaction, so it can recover too.
  const stopsServices = maintenance.indexOf("    Set-ManualStopped\n    if ($Action -in @('Update','Repair'))");
  const stagesReplacement = maintenance.indexOf("Set-CodeAcl $stage", stopsServices);
  const rotates = maintenance.indexOf("Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction Stop", stagesReplacement);
  const preservesCurrent = maintenance.indexOf("[IO.Directory]::Move($root, $previous)", rotates);
  assert.ok(verifies !== -1 && verifies < checksBackup && checksBackup < verifiesBackup);
  assert.ok(verifiesBackup < stopsServices && stopsServices < stagesReplacement);
  assert.ok(stagesReplacement < rotates && rotates < preservesCurrent);
  assert.match(maintenance, /if \(\$Action -eq 'Update' -and \$Resume -and \(Test-Path -LiteralPath \$root\) -and \(Test-Enrollment\)\)/);
});

test("PowerShell script calls never rely on stale or undefined native LASTEXITCODE", () => {
  assert.doesNotMatch(integrated, /if \(\$LASTEXITCODE/);
  assert.match(integrated, /Maintain-KTKMCP\.ps1'\) -Action Update[^\n]*\n[\s\S]*?if \(-not \$\?\)/);
  assert.match(integrated, /Run-KTKAcceptance\.ps1'\) -Live[\s\S]*?if \(-not \$\?\)/);
  assert.match(maintenance, /Verify-KTKPackage\.ps1'\) \| Out-Null[\s\S]*?if \(-not \$\?\)/);
  assert.match(windowsCi, /Exercise real rollback verification under StrictMode without LASTEXITCODE/);
  assert.match(windowsCi, /rollback-strictmode\.ps1/);
});

test("Windows recovery gate accepts the current packaged installer version", () => {
  assert.ok(staged.includes(`'${packageLock.package_version}'`));
  assert.ok(setup.includes(`AppVersion=${packageLock.package_version}`));
  assert.ok(setup.includes(`OutputBaseFilename=KTK-Qwen-MCP-Setup-${packageLock.package_version}-TEST-UNSIGNED`));
});

test("one-time user task runs only in the original non-elevated login without passwords", () => {
  const script = readFileSync(new URL("../../scripts/Install-KTKUserUpdater.ps1", import.meta.url), "utf8");
  assert.match(script, /S-1-5-18/);
  assert.match(script, /Principal\.RunLevel = 0/);
  assert.match(script, /Principal\.LogonType = 3/);
  assert.match(script, /RegisterTaskDefinition\(\$taskName,\$definition,6,\$sid,\$null,3\)/);
  assert.doesNotMatch(script, /-Verb RunAs|Get-Credential|Read-Host|Invoke-Expression/i);
});
