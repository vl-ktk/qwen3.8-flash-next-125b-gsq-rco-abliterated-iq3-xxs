import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateDeviceIdentity } from "./device-identity.mjs";
import { createDeviceBootstrapSession, openBootstrapEnvelope } from "./device-bootstrap.mjs";
import { requestDeviceBootstrap, waitForDeviceBootstrap, saveDeviceBootstrap } from "./device-enrollment.mjs";
import { sealBootstrapEnvelope } from "../cloudflare/device-bootstrap.mjs";

const randomId = () => randomBytes(24).toString("base64url");
const gatewayKey = randomBytes(32).toString("base64url");
const tunnelToken = randomBytes(64).toString("base64url");

test("bootstrap client sends public keys only, and decrypts approved bound envelope", async () => {
  const identity = await generateDeviceIdentity();
  const requestId = randomId(), deviceId = randomId(), code = "ABCDEFGHJK";
  const seen = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, redirect: init.redirect });
    if (url.endsWith("/start")) return Response.json({ request_id: requestId, user_code: code, fingerprint: identity.fingerprint, verification_uri: "https://qwen125b-mcp.vl-ktk.workers.dev/device/pair/manage", expires_in: 600 }, { status: 201 });
    if (seen.length === 2) return Response.json({ state: "pending" });
    const envelope = await sealBootstrapEnvelope({ QWEN_MCP_GATEWAY_KEY: gatewayKey, QWEN_TUNNEL_TOKEN: tunnelToken }, { publicKey: seen[0].body.bootstrap_public_key, requestId, deviceId });
    return Response.json({ state: "approved", device_id: deviceId, bootstrap: envelope });
  };
  const started = await requestDeviceBootstrap(identity, { fetcher });
  assert.equal(seen[0].body.public_key, identity.public_key);
  assert.match(seen[0].body.bootstrap_public_key, /^[A-Za-z0-9_-]{87}$/);
  assert.equal(seen[0].redirect, "error");
  assert.doesNotMatch(JSON.stringify(seen), /private_pkcs8|gateway_key|tunnel_token/);
  const receipt = await waitForDeviceBootstrap(started, { fetcher, delay: async () => {} });
  assert.deepEqual(receipt, { device_id: deviceId, gateway_key: gatewayKey, tunnel_token: tunnelToken });
  assert.equal(seen.filter(x => x.url.endsWith("/status")).length, 2);
});

test("bootstrap sealed material rejects tampering, foreign session and wrong device", async () => {
  const session = await createDeviceBootstrapSession();
  const requestId = randomId(), deviceId = randomId();
  const envelope = await sealBootstrapEnvelope({ QWEN_MCP_GATEWAY_KEY: gatewayKey, QWEN_TUNNEL_TOKEN: tunnelToken }, { publicKey: session.public_key, requestId, deviceId });
  assert.equal((await openBootstrapEnvelope(session, envelope, { requestId, deviceId })).gateway_key, gatewayKey);
  await assert.rejects(() => openBootstrapEnvelope(session, envelope, { requestId, deviceId: randomId() }), /bootstrap_decryption_failed/);
  await assert.rejects(() => openBootstrapEnvelope(session, { ...envelope, ciphertext: "A".repeat(envelope.ciphertext.length) }, { requestId, deviceId }), /bootstrap_decryption_failed/);
});

test("protected secret-file creation refuses overwrite or symlink directory", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktk-bootstrap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secretsDir = path.join(root, "secrets"), stateDir = path.join(root, "state");
  await mkdir(secretsDir); await mkdir(stateDir);
  const payload = { device_id: randomId(), gateway_key: gatewayKey, tunnel_token: tunnelToken };
  await saveDeviceBootstrap({ secretsDir, stateDir }, payload);
  assert.equal(await readFile(path.join(secretsDir, "gateway.key"), "utf8"), gatewayKey);
  assert.equal(await readFile(path.join(secretsDir, "tunnel.token"), "utf8"), tunnelToken);
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, "enrollment.json"), "utf8")), { schema: 1, device_id: payload.device_id });
  await assert.rejects(() => saveDeviceBootstrap({ secretsDir, stateDir }, { ...payload, gateway_key: "Z".repeat(43) }), /bootstrap_existing_credentials/);
  assert.equal(await readFile(path.join(secretsDir, "gateway.key"), "utf8"), gatewayKey);
  const linkedDir = path.join(root, "linked");
  await symlink(secretsDir, linkedDir);
  await assert.rejects(() => saveDeviceBootstrap({ secretsDir: linkedDir, stateDir }, payload), /bootstrap_directory_untrusted/);
});
