import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { request as httpRequest } from "node:http";
import { generateDeviceIdentity } from "./device-identity.mjs";
import { listenWindowsMcp } from "./mcp-server.mjs";

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const info = { name: "test-client", version: "1" };
const baseHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function fixture(t, options = {}) {
  const server = await listenWindowsMcp({ port: 0, originVerifier: () => true, ...options });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (method, params = {}, extra = {}, id = 1) => fetch(`${root}/mcp`, {
    method: "POST",
    headers: { ...baseHeaders, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const modern = (method, params = {}, extra = {}) => post(method, {
    ...params,
    _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": info, "io.modelcontextprotocol/clientCapabilities": {} },
  }, { "mcp-protocol-version": MODERN, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": params.name } : {}), ...extra });
  const legacy = (method, params = {}, sid = null, extra = {}) => post(method, params, { "mcp-protocol-version": LEGACY, ...(sid ? { "mcp-session-id": sid } : {}), ...extra });
  const startLegacy = async () => {
    const response = await legacy("initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: info });
    assert.equal(response.status, 200);
    const sid = response.headers.get("mcp-session-id");
    assert.match(sid, /^[A-Za-z0-9_-]{32}$/);
    return sid;
  };
  return { server, root, post, modern, legacy, startLegacy };
}

test("bind only to localhost; health is transparent about untested model", async t => {
  const f = await fixture(t);
  assert.equal(f.server.address().address, "127.0.0.1");
  assert.deepEqual(await (await fetch(f.root + "/health")).json(), { status: "ready", transport: "streamable-http", model: "not_checked", version: "0.15.2" });
  await assert.rejects(() => listenWindowsMcp({ host: "0.0.0.0", port: 0 }), /invalid_bind_address/);
});

test("host/origin/DNS rebinding rejected even for health and attestation", async t => {
  const f = await fixture(t);
  // undici/fetch rewrites Host; use the raw Node HTTP client to exercise it.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(f.root + "/health", { headers: { host: "attacker.test" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.once("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(f.root + "/health", { headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await fetch(f.root + "/device/attest", { headers: { origin: "null" } })).status, 403);
});

test("paired device attests only for correct ID and nonce, signatures verify", async t => {
  const identity = await generateDeviceIdentity();
  const deviceId = randomBytes(24).toString("base64url");
  const f = await fixture(t, { identity, deviceId });
  const nonce = randomBytes(32).toString("base64url");
  const validHeaders = { "x-qwen-device-id": deviceId, "x-qwen-device-nonce": nonce };
  const resp = await fetch(f.root + "/device/attest", { headers: validHeaders });
  assert.equal(resp.status, 200);
  const proof = await resp.json();
  assert.equal(proof.device_id, deviceId);
  const publicKey = await webcrypto.subtle.importKey("raw", Buffer.from(identity.public_key, "base64url"), "Ed25519", false, ["verify"]);
  const challenge = new TextEncoder().encode(`QWEN-MCP-DEVICE-V1\nhttps://qwen125b-mcp.vl-ktk.workers.dev\n${deviceId}\n${nonce}`);
  assert.equal(await webcrypto.subtle.verify("Ed25519", publicKey, Buffer.from(proof.signature, "base64url"), challenge), true);
  for (const headers of [
    { ...validHeaders, "x-qwen-device-id": randomBytes(24).toString("base64url") },
    { ...validHeaders, "x-qwen-device-nonce": "bad" },
    { "x-qwen-device-id": deviceId },
  ]) assert.equal((await fetch(f.root + "/device/attest", { headers })).status, 403);
});

test("unpaired device cannot attest", async t => {
  const f = await fixture(t);
  const result = await fetch(f.root + "/device/attest", { headers: { "x-qwen-device-id": randomBytes(24).toString("base64url"), "x-qwen-device-nonce": randomBytes(32).toString("base64url") } });
  assert.equal(result.status, 403);
});

test("modern discover, list and errors are stateless with metadata", async t => {
  const f = await fixture(t);
  const discover = await f.modern("server/discover");
  assert.equal(discover.status, 200);
  const d = (await discover.json()).result;
  assert.deepEqual(d.supportedVersions, [MODERN, LEGACY]);
  assert.equal(d.resultType, "complete");
  assert.deepEqual(d._meta["io.modelcontextprotocol/serverInfo"], { name: "qwen125b-windows-mcp", version: "0.15.2" });
  const list = await f.modern("tools/list");
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).result.tools.map(tool => tool.name), ["system_info", "system_monitor", "process_list", "service_status", "app_status", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan", "pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_memory_audit", "pc_install_diagnostics", "pc_readiness_report"]);
  const unknown = await f.modern("tools/call", { name: "powershell", arguments: {} });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, -32602);
  assert.equal((await f.modern("ping")).status, 404);
  assert.equal((await f.modern("initialize")).status, 404);
  assert.equal((await fetch(f.root + "/mcp", { headers: { "mcp-protocol-version": MODERN } })).status, 405);
});

test("modern version, routing headers and body metadata must match", async t => {
  const f = await fixture(t);
  for (const extra of [{ "mcp-method": "tools/call" }, { "mcp-method": "" }, { "mcp-protocol-version": "2025-11-25" }]) {
    const response = await f.modern("tools/list", {}, extra);
    assert.equal(response.status, 400);
  }
  const fakeName = await f.modern("tools/call", { name: "system_info", arguments: {} }, { "mcp-name": "other_tool" });
  assert.equal(fakeName.status, 400);
  assert.equal((await fakeName.json()).error.code, -32020);
  const absentCaps = await f.post("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } }, { "mcp-protocol-version": MODERN, "mcp-method": "server/discover" });
  assert.equal(absentCaps.status, 400);
  const future = await f.post("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } }, { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" });
  assert.equal(future.status, 400);
  assert.equal((await future.json()).error.code, -32022);
});

test("legacy initialize, required session, notification, ping, list, GET SSE, DELETE", async t => {
  const f = await fixture(t);
  const sid = await f.startLegacy();
  assert.equal((await f.legacy("tools/list", {}, null)).status, 404);
  assert.deepEqual((await (await f.legacy("tools/list", {}, sid)).json()).result.tools.map(tool => tool.name), ["system_info", "system_monitor", "process_list", "service_status", "app_status", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan", "pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_memory_audit", "pc_install_diagnostics", "pc_readiness_report"]);
  assert.equal((await f.legacy("ping", {}, sid)).status, 200);
  const notify = await fetch(f.root + "/mcp", { method: "POST", headers: { ...baseHeaders, "mcp-protocol-version": LEGACY, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notify.status, 202);
  assert.equal(await notify.text(), "");
  const controller = new AbortController();
  const stream = await fetch(f.root + "/mcp", { headers: { accept: "text/event-stream", "mcp-session-id": sid }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /: connected/);
  controller.abort();
  const deleted = await fetch(f.root + "/mcp", { method: "DELETE", headers: { "mcp-session-id": sid } });
  assert.equal(deleted.status, 204);
  assert.equal((await f.legacy("tools/list", {}, sid)).status, 404);
});

test("malformed requests: media type, Accept, JSON, batching, excessive body", async t => {
  const f = await fixture(t);
  const json = obj => JSON.stringify(obj);
  assert.equal((await fetch(f.root + "/mcp", { method: "POST", headers: { ...baseHeaders, "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await fetch(f.root + "/mcp", { method: "POST", headers: { ...baseHeaders, accept: "application/json" }, body: "{}" })).status, 406);
  const malformed = await fetch(f.root + "/mcp", { method: "POST", headers: baseHeaders, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  assert.equal((await fetch(f.root + "/mcp", { method: "POST", headers: baseHeaders, body: json([]) })).status, 400);
  assert.equal((await fetch(f.root + "/mcp", { method: "POST", headers: baseHeaders, body: "x".repeat(70000) })).status, 413);
  assert.equal((await fetch(f.root + "/not-a-path")).status, 404);
  assert.equal((await fetch(f.root + "/health?bad=true")).status, 400);
});

test("legacy cannot run any unreviewed tool or arbitrary methods", async t => {
  const f = await fixture(t);
  const sid = await f.startLegacy();
  const tool = await f.legacy("tools/call", { name: "powershell", arguments: { command: "whoami" } }, sid);
  assert.equal(tool.status, 400);
  assert.equal((await tool.json()).error.code, -32602);
  assert.equal((await f.legacy("shell/execute", { command: "whoami" }, sid)).status, 400);
});
