import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const load = path => readFile(new URL(path, import.meta.url), "utf8");

test("step16 Windows service templates run as LocalService and cannot auto-start unprovisioned", async () => {
  for (const service of ["KTKQwenMCP", "KTKQwenTunnel"]) {
    const xml = await load(`../../config/${service}.xml`);
    assert.match(xml, new RegExp(`<id>${service}</id>`));
    assert.match(xml, /<startmode>Manual<\/startmode>/);
    assert.match(xml, /<serviceaccount><domain>NT AUTHORITY<\/domain><user>LocalService<\/user><\/serviceaccount>/);
    assert.match(xml, /<log mode="roll"\s*\/>/);
    assert.doesNotMatch(xml, /<password>|<user>LocalSystem<\/user>|<startmode>Automatic<\/startmode>|<env name=".*TOKEN" value="[A-Za-z0-9_-]{20}/);
  }
  const tunnel = await load("../../config/KTKQwenTunnel.xml");
  assert.match(tunnel, /--token-file/);
  assert.doesNotMatch(tunnel, /--token\s+(?!file)|<env name="TUNNEL_TOKEN"/);
  const origin = await load("../../config/KTKQwenMCP.xml");
  assert.match(origin, /QWEN_MCP_GATEWAY_KEY_PATH/);
  assert.match(origin, /QWEN_MCP_EMERGENCY_LOCK_PATH/);
});

test("step16 installer is first-install-only and transactional with fail-closed activation", async () => {
  const installer = await load("../../scripts/Install-KTKMCP.ps1");
  assert.match(installer, /\[switch\]\$CheckOnly/);
  assert.match(installer, /\[switch\]\$Enroll/);
  assert.match(installer, /Activate-KTKMCP\.ps1/);
  assert.match(installer, /Verify-KTKPackage\.ps1/);
  assert.match(installer, /WindowsIdentity/);
  assert.match(installer, /Start-Process.+-Verb RunAs/);
  assert.match(installer, /windows_x64_required/);
  assert.match(installer, /disk_space_below_600mb/);
  assert.match(installer, /local_mcp_port_8765_busy/);
  assert.match(installer, /existing_install_requires_repair_step_17/);
  assert.match(installer, /source_file_is_link_or_directory/);
  assert.match(installer, /\$manifest\.files/);
  assert.match(installer, /Set-ProtectedAcl/);
  assert.match(installer, /device-identity\.json/);
  assert.match(installer, /emergency\.lock/);
  assert.match(installer, /sc\.exe config \$name start= demand/);
  assert.match(installer, /\$installed\.Count - 1/);
  assert.match(installer, /\$dataCreated -and/);
  assert.doesNotMatch(installer, /(?:Start-Service\s+-Name|&\s*sc\.exe\s+start\b|--token\s+[a-z])/i);
  assert.doesNotMatch(installer, /(?:QWEN_MCP_GATEWAY_KEY|TUNNEL_TOKEN)\s*=/);
});

test("step16 single-action Windows launcher requests enrollment without embedding secrets", async () => {
  const launcher = await load("../../scripts/Start-KTKMCP.cmd");
  assert.match(launcher, /Install-KTKMCP\.ps1" -Enroll/);
  assert.match(launcher, /-ExecutionPolicy Bypass/);
  assert.doesNotMatch(launcher, /TUNNEL_TOKEN|GATEWAY_KEY|--token\s+ey/);
});

test("step16 device identity is written exclusively to protected destination", async () => {
  const script = await load("../../scripts/Generate-KTKIdentity.mjs");
  assert.match(script, /generateDeviceIdentity/);
  assert.match(script, /flag: "wx"/);
  assert.match(script, /device_public_key/);
  assert.match(script, /device_fingerprint/);
  assert.doesNotMatch(script, /process\.stdout\.write\([^;]*private_pkcs8/);
  assert.ok(root.endsWith("/"));
});

test("step16 enrollment activates only after owner approval, self-test and live Tunnel edge connection", async () => {
  const activate = await load("../../scripts/Activate-KTKMCP.ps1");
  assert.match(activate, /Enroll-KTKMCP\.mjs/);
  assert.match(activate, /SelfTest-KTKMCP\.mjs/);
  assert.match(activate, /emergency\.lock/);
  assert.match(activate, /cloudflared_tunnel_ha_connections/);
  assert.match(activate, /start= delayed-auto/);
  assert.match(activate, /start= demand/);
  assert.match(activate, /existing_enrollment_requires_repair_step_17/);
  assert.doesNotMatch(activate, /(?:--token\s+ey|TUNNEL_TOKEN\s*=|Write-Output.*gateway_key)/i);
  const tunnel = await load("../../config/KTKQwenTunnel.xml");
  assert.match(tunnel, /--metrics 127\.0\.0\.1:20241/);
});
