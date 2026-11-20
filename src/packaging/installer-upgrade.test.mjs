import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const setup = readFileSync(new URL("../../config/KTK-Setup.iss", import.meta.url), "utf8");
const maintenance = readFileSync(new URL("../../scripts/Maintain-KTKMCP.ps1", import.meta.url), "utf8");
const integrated = readFileSync(new URL("../../scripts/Run-KTKIntegratedAcceptance.ps1", import.meta.url), "utf8");
const staged = readFileSync(new URL("../../scripts/Assert-KTKStaged.ps1", import.meta.url), "utf8");
const packageLock = JSON.parse(readFileSync(new URL("../../config/windows-package.lock.json", import.meta.url), "utf8"));

test("integrated live installer updates enrolled MCP, then runs AI under original user", () => {
  assert.match(setup, /Mode = '-Live'[\s\S]*?Run-KTKIntegratedAcceptance\.ps1/);
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
});

test("one-click approval cannot enable unrelated maintenance operations", () => {
  assert.match(maintenance, /\$InstallerApproved -and \(\$Action -ne 'Update' -or -not \$Resume -or \$CheckOnly\)/);
  assert.match(maintenance, /if \(-not \$UpdaterApproved -and -not \[Environment\]::UserInteractive\)/);
  assert.match(maintenance, /if \(-not \$InstallerApproved -and -not \$UpdaterApproved\) \{[\s\S]*?Read-Host/);
  assert.match(maintenance, /previous_version_exists_rollback_first/);
  assert.match(maintenance, /Original KTK version restored and healthy after failed update/);
  assert.match(maintenance, /if \(Test-Path -LiteralPath \$lock\) \{ throw 'resume_refuses_existing_emergency_lock' \}/);
});

test("Windows recovery gate accepts the current packaged installer version", () => {
  assert.ok(staged.includes(`'${packageLock.package_version}'`));
});

test("one-time user task runs only in the original non-elevated login without passwords", () => {
  const script = readFileSync(new URL("../../scripts/Install-KTKUserUpdater.ps1", import.meta.url), "utf8");
  assert.match(script, /S-1-5-18/);
  assert.match(script, /Principal\.RunLevel = 0/);
  assert.match(script, /Principal\.LogonType = 3/);
  assert.match(script, /RegisterTaskDefinition\(\$taskName,\$definition,6,\$sid,\$null,3\)/);
  assert.doesNotMatch(script, /-Verb RunAs|Get-Credential|Read-Host|Invoke-Expression/i);
});
