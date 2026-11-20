import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const setup = readFileSync(new URL("../../config/KTK-Setup.iss", import.meta.url), "utf8");
const maintenance = readFileSync(new URL("../../scripts/Maintain-KTKMCP.ps1", import.meta.url), "utf8");

test("live installer upgrades only an enrolled existing installation", () => {
  assert.match(setup, /Mode = '-Live'[\s\S]*?QwenMCP\\MANIFEST\.json[\s\S]*?state\\enrollment\.json/);
  assert.match(setup, /Maintain-KTKMCP\.ps1/);
  assert.match(setup, /-Action Update -PackagePath[\s\S]*?-Resume -InstallerApproved/);
  assert.match(setup, /Run-KTKAcceptance\.ps1/);
  assert.match(setup, /Mode := '-Offline'/);
});

test("one-click approval cannot enable unrelated maintenance operations", () => {
  assert.match(maintenance, /\$InstallerApproved -and \(\$Action -ne 'Update' -or -not \$Resume -or \$CheckOnly\)/);
  assert.match(maintenance, /if \(-not \[Environment\]::UserInteractive\)/);
  assert.match(maintenance, /if \(-not \$InstallerApproved\) \{[\s\S]*?Read-Host/);
  assert.match(maintenance, /previous_version_exists_rollback_first/);
  assert.match(maintenance, /Original KTK version restored and healthy after failed update/);
  assert.match(maintenance, /if \(Test-Path -LiteralPath \$lock\) \{ throw 'resume_refuses_existing_emergency_lock' \}/);
});
