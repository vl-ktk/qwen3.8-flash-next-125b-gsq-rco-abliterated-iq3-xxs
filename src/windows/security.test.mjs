import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listenWindowsMcp } from "./mcp-server.mjs";
import { createOriginVerifier, decodeGatewayKey } from "./origin-auth.mjs";
import { createEmergencyLock } from "./emergency-lock.mjs";
import { runAdminCli } from "./admin-cli.mjs";

const gatewayKey = randomBytes(32).toString("base64url");
const protectedHeaders = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id", "x-qwen-device-id", "x-qwen-device-nonce"];
function signed(method, route, body = "", { key = gatewayKey, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url"), headers = {} } = {}) {
  const digest = createHash("sha256").update(body).digest("hex");
  const binding = protectedHeaders.map(name => `${name}:${headers[name] ?? ""}`).join("\n");
  const payload = `QWEN-ORIGIN-V1\n${timestamp}\n${nonce}\n${method}\n${route}\n${digest}\n${binding}`;
  return {
    ...headers,
    "x-qwen-origin-timestamp": timestamp,
    "x-qwen-origin-nonce": nonce,
    "x-qwen-origin-signature": createHmac("sha256", Buffer.from(key, "base64url")).update(payload).digest("base64url"),
  };
}

test("strict gateway verification rejects missing, forged, old, replayed and modified proofs", async () => {
  assert.throws(() => decodeGatewayKey("short"), /invalid_gateway_key/);
  assert.throws(() => decodeGatewayKey("x".repeat(43)), /invalid_gateway_key/);
  const verify = createOriginVerifier(gatewayKey);
  const content = Buffer.from('{"jsonrpc":"2.0"}');
  const valid = signed("POST", "/mcp", content);
  assert.equal(verify({}, "POST", "/mcp", content), false);
  assert.equal(verify(signed("POST", "/mcp", content, { key: randomBytes(32).toString("base64url") }), "POST", "/mcp", content), false);
  assert.equal(verify(signed("POST", "/mcp", content, { timestamp: String(Math.floor(Date.now() / 1000) - 46) }), "POST", "/mcp", content), false);
  assert.equal(verify(valid, "POST", "/mcp", Buffer.from("changed")), false);
  assert.equal(verify(valid, "GET", "/mcp", content), false);
  assert.equal(verify(valid, "POST", "/device/attest", content), false);
  assert.equal(verify({ ...valid, "mcp-session-id": "another-session" }, "POST", "/mcp", content), false);
  assert.equal(verify(valid, "POST", "/mcp", content), true);
  assert.equal(verify(valid, "POST", "/mcp", content), false);
});

test("Windows loopback rejects unsigned MCP and attestation before reaching tools", async t => {
  let calls = 0;
  const audit = [];
  const server = await listenWindowsMcp({ port: 0, gatewayKey, toolRegistry: {
    list: () => [], has: () => true, call: async () => { calls++; return {}; },
  }, auditEvent: event => audit.push(event) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system_info", arguments: {}, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
  } } });
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "system_info" };
  const post = headers => fetch(root + "/mcp", { method: "POST", headers: { ...base, ...headers }, body });
  assert.equal((await post({})).status, 403);
  assert.equal((await fetch(root + "/device/attest")).status, 403);
  assert.equal((await post(signed("POST", "/mcp", "forged"))).status, 403);
  const one = signed("POST", "/mcp", body, { headers: base });
  assert.equal((await post(one)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await post(one)).status, 403);
  assert.equal(calls, 1);
  assert.deepEqual(audit.map(e => e.event), ["origin_auth_denied", "origin_auth_denied", "origin_auth_denied", "tool_executed", "origin_auth_denied"]);
  assert.doesNotMatch(JSON.stringify(audit), /"arguments"|"system_info"|x-qwen-origin-signature|forged/);
  assert.equal((await fetch(root + "/device/attest", { headers: signed("GET", "/device/attest", "", { headers: { accept: "*/*" } }) })).status, 403); // no paired identity
});

test("emergency lock activates immediately, including health and valid signed calls", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qwen-gateway-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = createEmergencyLock(path.join(dir, "gateway.disabled"));
  const server = await listenWindowsMcp({ port: 0, gatewayKey, emergencyLocked: () => marker.isLocked() });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await marker.isLocked(), false);
  assert.equal((await fetch(root + "/healthz")).status, 200);
  assert.deepEqual(await marker.lock(), { status: "locked" });
  assert.equal(await marker.isLocked(), true);
  assert.equal((await fetch(root + "/healthz")).status, 503);
  assert.equal((await fetch(root + "/device/attest", { headers: signed("GET", "/device/attest", "", { headers: { accept: "*/*" } }) })).status, 503);
  assert.equal((await fetch(root + "/mcp", { headers: signed("GET", "/mcp", "", { headers: { accept: "*/*" } }) })).status, 503);
  assert.deepEqual(await marker.unlock(), { status: "unlocked" });
  assert.equal((await fetch(root + "/healthz")).status, 200);
  const missing = createEmergencyLock(path.join(dir, "removed", "flag"));
  await assert.rejects(() => missing.isLocked(), /emergency_lock_unavailable/);
  const errorServer = await listenWindowsMcp({ port: 0, gatewayKey, emergencyLocked: () => { throw Error("PRIVATE-PATH"); } });
  t.after(() => new Promise(resolve => errorServer.close(resolve)));
  const denied = await fetch(`http://127.0.0.1:${errorServer.address().port}/healthz`);
  assert.equal(denied.status, 503);
  assert.doesNotMatch(await denied.text(), /PRIVATE-PATH/);
});

test("emergency CLI is local, interactive, explicitly confirmed and never available via MCP", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qwen-admin-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const emergencyPath = path.join(dir, "disabled");
  const lines = [];
  const args = { platform: "win32", emergencyPath, write: line => lines.push(line), ask: async prompt => prompt.includes("CONFIRM UNLOCK") ? "CONFIRM UNLOCK KTKQwenMCP" : "CONFIRM LOCK KTKQwenMCP" };
  assert.equal(await runAdminCli({ ...args, args: ["lock"], interactive: false }), 2);
  assert.equal(await runAdminCli({ ...args, args: ["lock"], interactive: true, makeEmergencyLock: () => createEmergencyLock(emergencyPath) }), 0);
  assert.equal(await createEmergencyLock(emergencyPath).isLocked(), true);
  assert.equal(await runAdminCli({ ...args, args: ["unlock"], interactive: true, ask: async () => "wrong", makeEmergencyLock: () => createEmergencyLock(emergencyPath) }), 2);
  assert.equal(await createEmergencyLock(emergencyPath).isLocked(), true);
  assert.equal(await runAdminCli({ ...args, args: ["unlock"], interactive: true, makeEmergencyLock: () => createEmergencyLock(emergencyPath) }), 0);
  assert.equal(await createEmergencyLock(emergencyPath).isLocked(), false);
});
