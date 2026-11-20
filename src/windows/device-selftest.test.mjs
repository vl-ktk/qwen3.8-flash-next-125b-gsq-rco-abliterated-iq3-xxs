import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { generateDeviceIdentity } from "./device-identity.mjs";
import { selfTestWindowsOrigin } from "./device-selftest.mjs";
import { listenWindowsMcp } from "./mcp-server.mjs";

test("local activation self-test validates signed gateway request and real Ed25519 attestation", async t => {
  const identity = await generateDeviceIdentity();
  const deviceId = randomBytes(24).toString("base64url");
  const gatewayKey = randomBytes(32).toString("base64url");
  const server = await listenWindowsMcp({ port: 0, identity, deviceId, gatewayKey });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await selfTestWindowsOrigin({ identity, deviceId, gatewayKey, baseUrl }), { health: "ready", attestation: "valid" });
  await assert.rejects(() => selfTestWindowsOrigin({ identity, deviceId, gatewayKey: randomBytes(32).toString("base64url"), baseUrl }), /selftest_attestation_failed/);
  await assert.rejects(() => selfTestWindowsOrigin({ identity, deviceId: randomBytes(24).toString("base64url"), gatewayKey, baseUrl }), /selftest_attestation_failed/);
});

test("emergency lock makes activation self-test fail closed", async t => {
  const identity = await generateDeviceIdentity();
  const deviceId = randomBytes(24).toString("base64url"), gatewayKey = randomBytes(32).toString("base64url");
  const server = await listenWindowsMcp({ port: 0, identity, deviceId, gatewayKey, emergencyLocked: async () => true });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(() => selfTestWindowsOrigin({ identity, deviceId, gatewayKey, baseUrl: `http://127.0.0.1:${server.address().port}` }), /selftest_health_failed/);
});
