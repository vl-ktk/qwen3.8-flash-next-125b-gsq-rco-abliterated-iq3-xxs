import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile, mkdir, mkdtemp } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { buildSync } from "esbuild";
import { generateDeviceIdentity, signDeviceAttestation } from "../windows/device-identity.mjs";
import { createDeviceBootstrapSession, openBootstrapEnvelope } from "../windows/device-bootstrap.mjs";
import { signedDeviceRevoke, revokeDevice } from "../windows/device-revocation.mjs";
import { listenWindowsMcp } from "../windows/mcp-server.mjs";
import { createWindowsToolRegistry } from "../windows/windows-tools.mjs";

const testBundle = buildSync({
  entryPoints: [fileURLToPath(new URL("./test-runtime.mjs", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], write: false,
}).outputFiles[0].text;

const target = "https://qwen125b-mcp.vl-ktk.workers.dev";
const resource = target + "/mcp";
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const password = randomBytes(32).toString("hex");
const verifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
const gatewayKey = randomBytes(32).toString("base64url");
const tunnelToken = randomBytes(64).toString("base64url");

async function fixture(t, { configured = true, gatewayConfigured = true, tunnelConfigured = false, state = true, upstream, originBackend, ownerPassword = password, persistPath, paired = true, attestation = "valid", deviceIdentity, deviceIdOverride } = {}) {
  const calls = [];
  const identity = deviceIdentity ?? await generateDeviceIdentity();
  const deviceId = deviceIdOverride ?? randomBytes(24).toString("base64url");
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
    name: "qwen-test", modules: true,
    script: testBundle,
    compatibilityDate: "2026-11-17", compatibilityFlags: ["global_fetch_strictly_public"], log: new Log(LogLevel.ERROR),
    outboundService: () => { throw Error("External network forbidden in tests"); },
    durableObjects: state ? { QWEN_OAUTH_STATE: { className: "TestOAuthState", useSQLite: true } } : {},
    bindings: configured ? { QWEN_OAUTH_OWNER_PASSWORD: ownerPassword, QWEN_OAUTH_GENERATION: "1", ...(gatewayConfigured ? { QWEN_MCP_GATEWAY_KEY: gatewayKey } : {}), ...(tunnelConfigured ? { QWEN_TUNNEL_TOKEN: tunnelToken } : {}) } : {},
    serviceBindings: { QWEN_MCP_ORIGIN: async request => {
      if (originBackend) return originBackend(request);
      if (new URL(request.url).pathname === "/device/attest") {
        const mode = typeof attestation === "function" ? attestation(request) : attestation;
        if (mode === "unavailable") throw Error("Host offline");
        if (mode === "forged") return Response.json({ device_id: deviceId, signature: randomBytes(64).toString("base64url") });
        if (mode === "replayed") return Response.json(await signDeviceAttestation(identity, { issuer: target, device_id: deviceId, nonce: "A".repeat(43) }));
        return Response.json(await signDeviceAttestation(identity, { issuer: target, device_id: request.headers.get("x-qwen-device-id"), nonce: request.headers.get("x-qwen-device-nonce") }));
      }
      const body = await request.text();
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
      if (upstream) return upstream(request, body);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    } },
  }), ...(persistPath ? { resourcePersistencePath: persistPath } : {}) });
  let disposed = false;
  const close = async () => { if (!disposed) { disposed = true; await mf.dispose(); } };
  t.after(close);
  const send = (path, init) => mf.dispatchFetch(target + path, { redirect: "manual", ...init });
  const stub = async () => (await mf.getDurableObjectNamespace("QWEN_OAUTH_STATE")).getByName("qwen125b-oauth-v1");
  if (state && paired) await (await stub()).provisionTestDevice({ device_id: deviceId, public_key: identity.public_key, label: "Test Windows" });
  const register = async (extra = {}) => {
    const response = await send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "Test client", token_endpoint_auth_method: "none", ...extra }) });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const begin = async (client, extra = {}) => {
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, resource, scope: "qwen:read", state: "unpredictable-client-state", code_challenge: codeChallenge, code_challenge_method: "S256", ...extra });
    const response = await send("/authorize?" + params);
    const html = await response.text();
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
    return { response, html, cookie, handle, params };
  };
  const approve = async (started, extra = {}, headers = {}) => send("/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: target, cookie: started.cookie ?? "", ...headers },
    body: new URLSearchParams({ handle: started.handle ?? "", decision: "approve", password, scope: "qwen:read", ...extra }).toString(),
  });
  const code = async (client, extra = {}) => {
    const started = await begin(client, extra);
    assert.equal(started.response.status, 200, started.html);
    const response = await approve(started, { scope: extra.scope ?? "qwen:read" });
    assert.equal(response.status, 302, await response.clone().text());
    const location = new URL(response.headers.get("location"));
    assert.equal(location.searchParams.get("state"), "unpredictable-client-state");
    assert.equal(location.searchParams.get("iss"), target);
    return location.searchParams.get("code");
  };
  const token = (client, code, extra = {}) => send("/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirect, resource, ...extra }).toString(),
  });
  const login = async (extra = {}) => {
    const client = await register();
    const response = await token(client, await code(client, extra));
    assert.equal(response.status, 200, await response.clone().text());
    return { client, ...await response.json() };
  };
  const mcp = (token, method = "tools/call", params = { name: "system_info", arguments: {} }, headers = {}) => send("/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { mf, calls, send, register, begin, approve, code, token, login, mcp, stub, close, identity, deviceId };
}

test("original unprovisioned gateway remains locked, including forged credentials", async t => {
  const f = await fixture(t, { state: false });
  const status = await f.send("/__edge_status");
  assert.deepEqual(await status.json(), { state: "locked", endpoint: "mcp" });
  assert.equal(status.headers.get("cache-control"), "no-store, max-age=0");
  for (const method of ["GET", "POST", "DELETE", "PUT", "OPTIONS"]) {
    const response = await f.send("/mcp", { method, headers: { authorization: "Bearer forged", "cf-access-jwt-assertion": "forged", cookie: "access_token=forged" } });
    assert.equal(response.status, 401);
  }
  assert.equal((await f.send("/mcp/tools/call")).status, 401);
  assert.equal((await f.send("/admin")).status, 404);
  assert.equal(f.calls.length, 0);
});

test("owner password minimum is five characters; shorter passwords leave OAuth locked", async t => {
  const short = await fixture(t, { ownerPassword: "abcd" });
  assert.deepEqual(await (await short.send("/__edge_status")).json(), { state: "locked", endpoint: "mcp" });
  assert.equal((await short.send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
  const accepted = await fixture(t, { ownerPassword: "abcde" });
  assert.deepEqual(await (await accepted.send("/__edge_status")).json(), { state: "protected", endpoint: "mcp" });
  const started = await accepted.begin(await accepted.register());
  const response = await accepted.approve(started, { password: "abcde" });
  assert.equal(response.status, 302, await response.clone().text());
});

test("discovery publishes canonical Qwen resource, DCR and S256 only", async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.send("/__edge_status")).json(), { state: "protected", endpoint: "mcp" });
  const metadata = await (await f.send("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.issuer, target);
  assert.equal(metadata.registration_endpoint, target + "/oauth/register");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.client_id_metadata_document_supported, false);
  const protectedResource = await (await f.send("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(protectedResource.resource, resource);
  assert.deepEqual(protectedResource.authorization_servers, [target]);
  const response = await f.send("/mcp");
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /resource_metadata=/);
  assert.equal(f.calls.length, 0);
});

test("positive code + PKCE flow forwards only to fixed VPC destination and strips credentials", async t => {
  const f = await fixture(t);
  const login = await f.login();
  const response = await f.mcp(login.access_token, undefined, undefined, { cookie: "secret=cookie", "x-qwen-user": "attacker", "x-forwarded-host": "attacker.test", "cf-access-jwt-assertion": "forged" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://127.0.0.1:8765/mcp");
  for (const key of ["authorization", "cookie", "x-qwen-user", "x-forwarded-host", "cf-access-jwt-assertion"]) assert.equal(f.calls[0].headers[key], undefined);
  assert.match(f.calls[0].headers["x-qwen-origin-nonce"], /^[A-Za-z0-9_-]{22}$/);
  assert.match(f.calls[0].headers["x-qwen-origin-signature"], /^[A-Za-z0-9_-]{43}$/);
  const forwarded = f.calls[0];
  const digest = createHash("sha256").update(forwarded.body).digest("hex");
  const { "x-qwen-origin-timestamp": time, "x-qwen-origin-nonce": nonce, "x-qwen-origin-signature": signature } = forwarded.headers;
  const protectedHeaders = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id", "x-qwen-device-id", "x-qwen-device-nonce"];
  const binding = protectedHeaders.map(name => `${name}:${forwarded.headers[name] ?? ""}`).join("\n");
  assert.equal(createHmac("sha256", Buffer.from(gatewayKey, "base64url")).update(`QWEN-ORIGIN-V1\n${time}\n${nonce}\nPOST\n/mcp\n${digest}\n${binding}`).digest("base64url"), signature);
});

test("origin shared key is required before device attestation and MCP forwarding", async t => {
  const f = await fixture(t, { gatewayConfigured: false });
  const login = await f.login();
  const response = await f.mcp(login.access_token);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "origin_auth_not_configured" });
  assert.equal(f.calls.length, 0);
});

test("missing secrets, missing token, forged/foreign/refresh tokens and cookie auth cannot reach VPC", async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const login = await other.login();
  for (const headers of [{}, { authorization: "Bearer attacker" }, { authorization: "Bearer " + login.access_token }, { cookie: "access_token=" + login.access_token }, { authorization: "Basic forged" }]) assert.equal((await f.send("/mcp", { headers })).status, 401);
  const own = await f.login();
  assert.equal((await f.mcp(own.refresh_token)).status, 401);
  const missing = await fixture(t, { configured: false });
  assert.equal((await missing.send("/mcp")).status, 401);
  assert.equal((await missing.send("/oauth/register", { method: "POST" })).status, 503);
  assert.equal(f.calls.length, 0);
});

test("expired access token, expired code and revoked grant fail closed", async t => {
  const f = await fixture(t);
  const login = await f.login();
  await (await f.stub()).expire("token:", "expiresAt");
  assert.equal((await f.mcp(login.access_token)).status, 401);
  const client = await f.register();
  const code = await f.code(client);
  await (await f.stub()).expire("grant:");
  assert.equal((await f.token(client, code)).status, 400);
  assert.equal(f.calls.length, 0);
});

test("wrong PKCE, wrong redirect, wrong client, wrong audience and duplicate parameters are rejected", async t => {
  const f = await fixture(t);
  const client = await f.register();
  const another = await f.register();
  const code = await f.code(client);
  for (const [c, extra] of [[client, { code_verifier: "x".repeat(43) }], [client, { code_verifier: "" }], [client, { redirect_uri: "https://evil.test/" }], [another, {}], [client, { resource: "https://evil.test/mcp" }]]) assert.equal((await f.token(c, code, extra)).status, 400);
  const response = await f.send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&grant_type=refresh_token" });
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);
});

test("authorization validates redirect, resource, scopes and mandatory S256 for every client", async t => {
  const f = await fixture(t);
  const client = await f.register();
  const confidential = await f.register({ token_endpoint_auth_method: "client_secret_basic" });
  for (const extra of [{ redirect_uri: "https://evil.test/" }, { code_challenge: "" }, { code_challenge_method: "plain" }, { scope: "qwen:admin" }, { scope: "" }, { resource: "https://evil.test/mcp" }, { response_type: "token" }]) {
    const started = await f.begin(client, extra);
    assert.equal(started.response.status, 400, JSON.stringify(extra));
    assert.equal(started.response.headers.get("location"), null);
  }
  assert.equal((await f.begin(confidential, { code_challenge: "" })).response.status, 400);
  const bad = await f.send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://example.com/cb#fragment"] }) });
  assert.equal(bad.status, 400);
});

test("consent GET preserves same-origin Origin for browser form POST", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register());
  assert.equal(started.response.status, 200, started.html);
  // Referrer-Policy: no-referrer makes browsers send Origin: null on navigation form POSTs.
  assert.equal(started.response.headers.get("referrer-policy"), "same-origin");
  assert.ok(started.html.includes('<form method="post" action="/authorize?'));
  assert.equal((await f.approve(started, {}, { origin: "null" })).status, 403);
  assert.equal((await f.approve(started)).status, 302);
});

test("consent CSP permits only self and the registered callback origin, including Chrome redirects", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register());
  assert.equal(started.response.headers.get("content-security-policy"),
    "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'");
  const hostile = "https://evil;script-src.test/callback";
  const client = await f.register({ redirect_uris: [hostile] });
  const rejected = await f.begin(client, { redirect_uri: hostile });
  assert.equal(rejected.response.status, 400);
  assert.equal(f.calls.length, 0);
});

test("ChatGPT two-scope browser consent grants a code with an explicit submit button", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register(), { scope: "qwen:read qwen:files:read", ui_locales: "ru-RU" });
  assert.equal(started.response.status, 200, started.html);
  const submitted = new URLSearchParams([
    ["handle", started.handle], ["scope", "qwen:read"], ["scope", "qwen:files:read"],
    ["password", password], ["decision", "approve"],
  ]);
  const response = await f.send("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: target, cookie: started.cookie },
    body: submitted.toString(),
  });
  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(new URL(response.headers.get("location")).searchParams.get("state"), "unpredictable-client-state");
});

test("cookie-blocked Chrome form uses same-origin one-time proof for ChatGPT OAuth", async t => {
  const f = await fixture(t);
  const client = await f.register();
  const started = await f.begin(client, { scope: "qwen:read qwen:files:read" });
  const formProof = /name="form_proof" value="([a-f0-9]{64})"/.exec(started.html)?.[1];
  assert.match(formProof ?? "", /^[a-f0-9]{64}$/);
  const submitted = new URLSearchParams([
    ["handle", started.handle], ["form_proof", formProof],
    ["scope", "qwen:read"], ["scope", "qwen:files:read"],
    ["password", password], ["decision", "approve"],
  ]);
  const options = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: target,
      "sec-fetch-site": "same-origin" },
    body: submitted.toString(), // Deliberately no Cookie header: reproduce real Chrome failure.
  };
  const approved = await f.send("/authorize", options);
  assert.equal(approved.status, 302, await approved.clone().text());
  const authCode = new URL(approved.headers.get("location")).searchParams.get("code");
  const token = await f.token(client, authCode);
  assert.equal(token.status, 200, await token.clone().text());
  assert.ok((await token.json()).access_token);
  const replay = await f.send("/authorize", options);
  assert.deepEqual(await replay.json(), { error: "invalid_request", reason: "consent_expired" });
});

test("cookie fallback rejects missing, forged, cross-origin or mismatched browser proof", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register());
  const formProof = /name="form_proof" value="([a-f0-9]{64})"/.exec(started.html)?.[1];
  assert.ok(formProof);
  const headers = { cookie: "", "sec-fetch-site": "same-origin" };
  const forged = await f.approve(started, { form_proof: "0".repeat(64) }, headers);
  assert.deepEqual(await forged.json(), { error: "invalid_request", reason: "consent_form_proof_invalid" });
  const notBrowser = await f.approve(started, { form_proof: formProof }, { cookie: "" });
  assert.deepEqual(await notBrowser.json(), { error: "invalid_request", reason: "consent_cookie_missing" });
  assert.equal((await f.approve(started, { form_proof: formProof },
    { ...headers, origin: "https://evil.example" })).status, 403);
  const mismatch = await f.approve(started, { form_proof: formProof },
    { ...headers, cookie: started.cookie.split("=")[0] + "=" + "f".repeat(64) });
  assert.deepEqual(await mismatch.json(), { error: "invalid_request", reason: "consent_cookie_mismatch" });
  assert.equal((await f.approve(started, { form_proof: formProof }, headers)).status, 302);
});

test("expired cookie-free form is classified as expiry, never proof corruption", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register(), { scope: "qwen:read qwen:files:read" });
  const proof = /name="form_proof" value="([a-f0-9]{64})"/.exec(started.html)[1];
  // Model the actual browser at t >= 600 s: cookie omitted, hidden inputs retained,
  // both persisted records expired. v8 returns consent_form_proof_invalid here.
  await (await f.stub()).expire("transaction:");
  await (await f.stub()).expire("consent-proof:");
  const response = await f.approve(started, { form_proof: proof }, { cookie: "", "sec-fetch-site": "same-origin" });
  assert.deepEqual(await response.json(), { error: "invalid_request", reason: "consent_expired" });
  assert.equal(response.headers.get("location"), null);
  assert.equal(f.calls.length, 0);
});

test("expired browser POST starts a fresh GET, never accepts the old password/proof", async t => {
  const f = await fixture(t);
  const client = await f.register();
  const started = await f.begin(client, { scope: "qwen:read qwen:files:read" });
  const proof = /name="form_proof" value="([a-f0-9]{64})"/.exec(started.html)[1];
  await (await f.stub()).expire("transaction:");
  await (await f.stub()).expire("consent-proof:");
  const path = "/authorize?" + started.params;
  const post = await f.send(path, { method: "POST", headers: {
    origin: target, "sec-fetch-site": "same-origin", accept: "text/html", "content-type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ handle: started.handle, form_proof: proof, password, scope: "qwen:read", decision: "approve" }).toString() });
  assert.equal(post.status, 303);
  assert.equal(post.headers.get("location"), path);
  assert.equal(post.headers.get("x-qwen-oauth-stage"), "consent_expired_restart");
  assert.ok(!post.headers.get("location").includes("password"));
  const fresh = await f.begin(client, { scope: "qwen:read qwen:files:read" });
  assert.notEqual(fresh.handle, started.handle);
  assert.ok(!fresh.html.includes(password));
  assert.equal((await f.approve(fresh, { password: "" })).status, 403);
  assert.equal((await f.approve(fresh)).status, 302);
});

test("proof storage absence is distinguished from a mismatching live proof", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register());
  const proof = /name="form_proof" value="([a-f0-9]{64})"/.exec(started.html)[1];
  await (await f.stub()).expire("consent-proof:");
  const response = await f.approve(started, { form_proof: proof }, { cookie: "", "sec-fetch-site": "same-origin" });
  assert.deepEqual(await response.json(), { error: "invalid_request", reason: "consent_form_proof_missing" });
  assert.equal((await f.approve(started)).status, 302); // independent valid cookie path
});

test("consent survives SQLite persistence and a full runtime restart, with both scopes and no cookie", async t => {
  const parent = fileURLToPath(new URL("../../.generated/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const persistPath = await mkdtemp(parent + "consent-persist-");
  const first = await fixture(t, { persistPath });
  const client = await first.register();
  const started = await first.begin(client, { scope: "qwen:read qwen:files:read" });
  const proof = /name="form_proof" value="([a-f0-9]{64})"/.exec(started.html)[1];
  await first.close();
  const second = await fixture(t, { persistPath });
  const response = await second.send("/authorize", { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded", origin: target, "sec-fetch-site": "same-origin",
  }, body: new URLSearchParams([
    ["handle", started.handle], ["form_proof", proof], ["scope", "qwen:read"], ["scope", "qwen:files:read"],
    ["password", password], ["decision", "approve"],
  ]).toString() });
  assert.equal(response.status, 302, await response.clone().text());
  const code = new URL(response.headers.get("location")).searchParams.get("code");
  const token = await second.token(client, code);
  assert.equal(token.status, 200, await token.clone().text());
  assert.equal((await token.json()).scope, "qwen:read qwen:files:read");
  const audit = await (await second.stub()).audit();
  assert.ok(audit.some(row => row.stage === "consent_issued"));
  assert.ok(audit.some(row => row.stage === "code_issued"));
  assert.ok(audit.some(row => row.stage === "token_endpoint_success"));
  const serialized = JSON.stringify(audit);
  for (const secret of [password, started.handle, proof, code, client.client_id]) assert.ok(!serialized.includes(secret));
});

test("consent failures identify only safe stage codes, never cookies or secrets", async t => {
  const f = await fixture(t);
  const client = await f.register();
  const started = await f.begin(client);
  const missingCookie = await f.approve(started, {}, { cookie: "" });
  assert.deepEqual(await missingCookie.json(), { error: "invalid_request", reason: "consent_cookie_missing" });
  const missingDecision = await f.approve(started, { decision: "" });
  assert.deepEqual(await missingDecision.json(), { error: "invalid_request", reason: "consent_decision_missing" });
  const expired = await f.begin(client);
  await (await f.stub()).expire("transaction:");
  const expiredResponse = await f.approve(expired);
  assert.deepEqual(await expiredResponse.json(), { error: "invalid_request", reason: "consent_expired" });
});

test("consent requires same-origin browser binding, owner password and requested scope subset", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register());
  assert.match(started.response.headers.get("set-cookie"), /Secure/);
  assert.match(started.response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await f.approve(started, {}, { origin: "https://evil.test" })).status, 403);
  assert.equal((await f.approve(started, {}, { cookie: "" })).status, 400);
  assert.equal((await f.approve(started, { password: "wrong" })).status, 403);
  assert.equal((await f.approve(started, { scope: "qwen:files:read" })).status, 400);
  assert.equal((await f.approve(started)).status, 302);
  assert.equal((await f.approve(started)).status, 400);
  assert.equal(f.calls.length, 0);
});

test("authorization code is consumed exactly once under concurrent exchanges", async t => {
  const f = await fixture(t);
  const client = await f.register();
  const code = await f.code(client);
  const responses = await Promise.all([f.token(client, code), f.token(client, code)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  const winner = await responses.find(r => r.status === 200).json();
  // Provider revokes a grant when its authorization code is replayed.
  assert.equal((await f.mcp(winner.access_token)).status, 401);
});

test("strict refresh rotation and revocation invalidate issued access tokens", async t => {
  const f = await fixture(t);
  const login = await f.login();
  const refresh = token => f.send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: login.client.client_id, refresh_token: token, resource }).toString() });
  const response = await refresh(login.refresh_token);
  assert.equal(response.status, 200, await response.clone().text());
  const rotated = await response.json();
  assert.notEqual(rotated.refresh_token, login.refresh_token);
  assert.equal((await refresh(login.refresh_token)).status, 400);
  assert.equal((await f.mcp(rotated.access_token)).status, 401);
  assert.equal((await refresh(rotated.refresh_token)).status, 400);
});

test("scope gate blocks file reads, mutations, unknown methods, batches and route/header bypasses", async t => {
  const f = await fixture(t);
  const login = await f.login();
  for (const name of ["file_read", "powershell", "reboot", "file_write", "service_start", "service_stop", "configure_recovery", "unknown", "__proto__", "constructor"]) assert.equal((await f.mcp(login.access_token, "tools/call", { name })).status, 403, name);
  assert.equal((await f.mcp(login.access_token, "tools/call", { name: "admin_status", arguments: {} })).status, 200);
  assert.equal((await f.mcp(login.access_token, "resources/read")).status, 403);
  assert.equal((await f.send("/mcp/tools/call", { headers: { authorization: "Bearer " + login.access_token } })).status, 404);
  assert.equal((await f.mcp(login.access_token, undefined, undefined, { origin: "https://evil.test" })).status, 403);
  assert.equal((await f.mcp(login.access_token, undefined, undefined, { "mcp-session-id": "forged" })).status, 403);
  assert.equal((await f.mcp(login.access_token, undefined, undefined, { "last-event-id": "forged" })).status, 403);
  assert.equal((await f.mcp(login.access_token, "tools/call", { name: ["system_info"] })).status, 400);
  assert.equal((await f.send("/mcp?access_token=" + login.access_token)).status, 401);
  assert.equal((await f.send("/mcp", { method: "POST", headers: { authorization: "Bearer " + login.access_token, "content-type": "application/json" }, body: "[]" })).status, 400);
  assert.equal(f.calls.length, 1); // The explicitly allowed read-only admin_status call above.
});

test("tools list is filtered by scopes and explicit file-read consent works", async t => {
  const f = await fixture(t, { upstream: () => Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "system_info" }, { name: "file_read" }, { name: "powershell" }, { name: "constructor" }] } }) });
  const login = await f.login();
  const list = await (await f.mcp(login.access_token, "tools/list")).json();
  assert.deepEqual(list.result.tools.map(t => t.name), ["system_info"]);
  const files = await f.login({ scope: "qwen:files:read" });
  assert.equal((await f.mcp(files.access_token, "tools/call", { name: "file_read" })).status, 200);
  assert.equal((await f.mcp(files.access_token, "tools/call", { name: "system_info" })).status, 403);
});

test("limits reject oversized payloads and owner password brute force", async t => {
  const f = await fixture(t);
  const started = await f.begin(await f.register());
  for (let i = 0; i < 5; i++) assert.equal((await f.approve(started, { password: "wrong" })).status, 403);
  assert.equal((await f.approve(started)).status, 429);
  const response = await f.send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(17000) });
  assert.equal(response.status, 413);
});

test("upstream redirects and failures are contained and sensitive errors are redacted", async t => {
  for (const upstream of [() => new Response(null, { status: 302, headers: { location: "https://evil.test" } }), () => { throw Error("sensitive-origin-secret"); }]) {
    const f = await fixture(t, { upstream });
    const login = await f.login();
    const response = await f.mcp(login.access_token);
    assert.ok([502, 503].includes(response.status));
    assert.equal(response.headers.get("location"), null);
    assert.doesNotMatch(await response.text(), /sensitive-origin-secret/);
  }
});

test("expired consent and explicit denial cannot issue authorization codes", async t => {
  const f = await fixture(t);
  const client = await f.register();
  const expired = await f.begin(client);
  await (await f.stub()).expire("transaction:");
  assert.equal((await f.approve(expired)).status, 400);
  const fresh = await f.begin(client);
  const denied = await f.approve(fresh, { decision: "deny", password: "" });
  assert.equal(denied.status, 302);
  const location = new URL(denied.headers.get("location"));
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "unpredictable-client-state");
  assert.equal(location.searchParams.has("code"), false);
});

test("revocation endpoint and generation changes immediately reject existing access", async t => {
  const f = await fixture(t);
  const login = await f.login();
  const revoke = await f.send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: login.client.client_id, token: login.refresh_token, token_type_hint: "refresh_token" }).toString() });
  assert.equal(revoke.status, 200, await revoke.clone().text());
  assert.equal((await f.mcp(login.access_token)).status, 401);
  const next = await f.login();
  await (await f.stub()).bumpGeneration();
  assert.equal((await f.mcp(next.access_token)).status, 401);
  assert.equal(f.calls.length, 0);
});

test("concurrent refreshes admit only one exchange, and replay revokes the family", async t => {
  const f = await fixture(t);
  const login = await f.login();
  const init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: login.client.client_id, refresh_token: login.refresh_token, resource }).toString() };
  const responses = await Promise.all([f.send("/oauth/token", init), f.send("/oauth/token", init)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  assert.equal((await f.mcp((await responses.find(r => r.ok).json()).access_token)).status, 401);
});

test("MCP sessions bind to grants; GET/DELETE preserve transport and cannot reuse another grant", async t => {
  const f = await fixture(t, { upstream: request => request.method === "DELETE"
    ? new Response(null, { status: 204 })
    : new Response('data: {"jsonrpc":"2.0","method":"notifications/test"}\n\n', { headers: { "content-type": "text/event-stream", "mcp-session-id": "safe-session", "set-cookie": "origin-secret=hidden" } }) });
  const a = await f.login();
  const initialized = await f.mcp(a.access_token, "initialize");
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get("mcp-session-id"), "safe-session");
  assert.equal(initialized.headers.get("set-cookie"), null);
  const headers = { authorization: "Bearer " + a.access_token, "mcp-session-id": "safe-session", "last-event-id": "event-1" };
  const stream = await f.send("/mcp", { headers });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /notifications\/test/);
  const b = await f.login();
  const before = f.calls.length;
  assert.equal((await f.send("/mcp", { headers: { ...headers, authorization: "Bearer " + b.access_token } })).status, 403);
  assert.equal(f.calls.length, before);
  assert.equal((await f.send("/mcp", { method: "DELETE", headers })).status, 204);
  assert.equal((await f.send("/mcp", { headers })).status, 403);
});

test("tools/list SSE responses are filtered; malformed responses fail closed", async t => {
  const tools = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "system_info" }, { name: "powershell" }, { name: "file_read" }] } };
  const f = await fixture(t, { upstream: () => new Response("event: message\r\ndata: " + JSON.stringify(tools) + "\r\n\r\n", { headers: { "content-type": "text/event-stream" } }) });
  const login = await f.login();
  const response = await f.mcp(login.access_token, "tools/list");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual((await response.json()).result.tools.map(t => t.name), ["system_info"]);
  const bad = await fixture(t, { upstream: () => new Response("data: invalid\n\n", { headers: { "content-type": "text/event-stream" } }) });
  assert.equal((await bad.mcp((await bad.login()).access_token, "tools/list")).status, 502);
});

test("vendored provider matches the exact source extraction and recorded SHA-256", async () => {
  const source = await readFile(new URL("./vendor/oauth-provider.mjs", import.meta.url), "utf8");
  const provenance = JSON.parse(await readFile(new URL("./vendor/provenance.json", import.meta.url), "utf8"));
  const sha = value => createHash("sha256").update(value).digest("hex");
  assert.equal(sha(source), provenance.vendored_sha256);
  assert.equal(sha(source.slice(0, provenance.extracted_provider_characters)), provenance.extracted_provider_sha256);
  assert.doesNotMatch(source, /instagram|tiktok|facebook|threads-mcp|OAUTH_V1_KV|OAUTH_ADMIN_PASSWORD/i);
});

test("MCP payload limits, malformed JSON, unsupported methods and host aliases never forward", async t => {
  const f = await fixture(t);
  const login = await f.login();
  for (const [body, status] of [["x".repeat(65537), 413], ["{", 400]]) {
    assert.equal((await f.send("/mcp", { method: "POST", headers: { authorization: "Bearer " + login.access_token, "content-type": "application/json" }, body })).status, status);
  }
  assert.equal((await f.send("/mcp", { method: "PUT", headers: { authorization: "Bearer " + login.access_token } })).status, 400);
  assert.equal((await f.mf.dispatchFetch("https://evil.test/mcp", { redirect: "manual", headers: { authorization: "Bearer " + login.access_token } })).status, 404);
  assert.equal(f.calls.length, 0);
});

test("denied MCP method is auditable by name without recording request content", async t => {
  const f = await fixture(t);
  const login = await f.login();
  const denied = await f.mcp(login.access_token, "resources/read", { private_data: "never-log-this" });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "method_not_allowed" });
  const rows = await (await f.stub()).audit();
  assert.ok(rows.some(row => row.path === "/mcp" && row.status === 403
    && row.stage === "mcp_rpc:resources/read" && row.reason === "method_not_allowed"));
  assert.doesNotMatch(JSON.stringify(rows), /never-log-this|Bearer |access_token|refresh_token/);
  assert.equal(f.calls.length, 0);
});

test("MCP server/discover is permitted after OAuth and forwards modern routing headers only", async t => {
  const f = await fixture(t);
  const login = await f.login();
  const response = await f.mcp(login.access_token, "server/discover", {}, {
    "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover",
    "cookie": "secret=do-not-forward", "x-forwarded-host": "attacker.test",
  });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://127.0.0.1:8765/mcp");
  assert.equal(JSON.parse(f.calls[0].body).method, "server/discover");
  assert.equal(f.calls[0].headers["mcp-protocol-version"], "2026-07-28");
  assert.equal(f.calls[0].headers["mcp-method"], "server/discover");
  for (const name of ["authorization", "cookie", "x-forwarded-host"]) assert.equal(f.calls[0].headers[name], undefined);
  assert.ok((await (await f.stub()).audit()).some(row => row.stage === "mcp_rpc:server/discover" && row.status === 200));
});

test("modern MCP header mismatches are rejected and do not reach Windows origin", async t => {
  const f = await fixture(t);
  const login = await f.login();
  assert.equal((await f.mcp(login.access_token, "server/discover", {}, { "mcp-method": "tools/call" })).status, 400);
  assert.equal((await f.mcp(login.access_token, "tools/call", { name: "system_info" }, { "mcp-name": "file_read" })).status, 400);
  assert.equal((await f.mcp(login.access_token, "server/discover", {}, { "mcp-name": "system_info" })).status, 400);
  assert.equal((await f.mcp("forged", "server/discover", {}, { "mcp-method": "server/discover" })).status, 401);
  assert.equal(f.calls.length, 0);
});

test("discovery does not invent tools if Windows origin is down", async t => {
  const f = await fixture(t, { upstream: () => { throw new Error("Windows offline"); } });
  const login = await f.login();
  const response = await f.mcp(login.access_token, "server/discover", {}, { "mcp-method": "server/discover" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "origin_unavailable" });
});

const formProof = html => /name="proof" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
async function deviceForm(f, fields, headers = {}) {
  const page = await f.send("/device/pair/manage");
  assert.equal(page.status, 200);
  const proof = formProof(await page.text());
  assert.ok(proof);
  return f.send("/device/pair/manage", { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded", "origin": target, "sec-fetch-site": "same-origin", ...headers,
  }, body: new URLSearchParams({ proof, password, ...fields }).toString() });
}
const pairStart = (f, identity, label = "Windows Test", bootstrapPublicKey) => f.send("/device/pair/start", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ public_key: identity.public_key, label, ...(bootstrapPublicKey ? { bootstrap_public_key: bootstrapPublicKey } : {}) }),
});

test("owner-approved bootstrap delivers secrets encrypted to the Windows ephemeral key once", async t => {
  const f = await fixture(t, { paired: false, tunnelConfigured: true });
  const recipient = await createDeviceBootstrapSession();
  const startedResponse = await pairStart(f, f.identity, "Windows Test", recipient.public_key);
  assert.equal(startedResponse.status, 201);
  const started = await startedResponse.json();
  const poll = () => f.send("/device/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: started.request_id }) });
  assert.deepEqual(await (await poll()).json(), { state: "pending" });
  assert.equal((await deviceForm(f, { action: "approve", code: started.user_code, fingerprint: "A".repeat(16) })).status, 403);
  assert.deepEqual(await (await poll()).json(), { state: "pending" });
  assert.equal((await deviceForm(f, { action: "approve", code: started.user_code, fingerprint: started.fingerprint })).status, 200);
  const reply = await (await poll()).json();
  assert.equal(reply.state, "approved");
  assert.equal(reply.bootstrap.version, 1);
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(gatewayKey));
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(tunnelToken));
  const clear = await openBootstrapEnvelope(recipient, reply.bootstrap, { requestId: started.request_id, deviceId: reply.device_id });
  assert.deepEqual(clear, { device_id: reply.device_id, gateway_key: gatewayKey, tunnel_token: tunnelToken });
  const otherSession = await createDeviceBootstrapSession();
  await assert.rejects(() => openBootstrapEnvelope(otherSession, reply.bootstrap, { requestId: started.request_id, deviceId: reply.device_id }), /bootstrap_decryption_failed/);
  await assert.rejects(() => openBootstrapEnvelope(recipient, { ...reply.bootstrap, nonce: "A".repeat(16) }, { requestId: started.request_id, deviceId: reply.device_id }), /bootstrap_decryption_failed/);
  await assert.rejects(() => openBootstrapEnvelope(recipient, reply.bootstrap, { requestId: "B".repeat(32), deviceId: reply.device_id }), /bootstrap_decryption_failed/);
  const again = await (await poll()).json();
  assert.deepEqual(again, { state: "approved", device_id: reply.device_id });
  const audit = await (await f.stub()).audit();
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(tunnelToken));
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(gatewayKey));
});

test("bootstrap is unavailable without both cloud secrets; invalid transport key refused", async t => {
  const f = await fixture(t, { paired: false, tunnelConfigured: false });
  const session = await createDeviceBootstrapSession();
  const unavailable = await pairStart(f, f.identity, "Windows Test", session.public_key);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "bootstrap_not_configured" });
  const invalid = await pairStart(f, f.identity, "Windows Test", "A".repeat(87));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_bootstrap_key" });
  // The legacy approval flow remains available for existing tests/clients,
  // but it never returns a tunnel token or shared gateway secret.
  assert.equal((await pairStart(f, f.identity)).status, 201);
});

test("device pairing demands owner approval, fingerprint and proof of Ed25519 possession", async t => {
  const f = await fixture(t, { paired: false });
  const own = await f.login();
  assert.deepEqual(await (await f.mcp(own.access_token)).json(), { error: "device_not_paired" });
  assert.equal(f.calls.length, 0);
  const startedResponse = await pairStart(f, f.identity);
  assert.equal(startedResponse.status, 201, await startedResponse.clone().text());
  const started = await startedResponse.json();
  assert.match(started.request_id, /^[A-Za-z0-9_-]{32}$/);
  assert.match(started.user_code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.match(started.fingerprint, /^[A-F0-9]{16}$/);
  assert.equal(started.fingerprint, f.identity.fingerprint);
  const poll = async () => f.send("/device/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: started.request_id }) });
  assert.deepEqual(await (await poll()).json(), { state: "pending" });
  const approve = { action: "approve", code: started.user_code, fingerprint: started.fingerprint };
  const wrongFp = await deviceForm(f, { ...approve, fingerprint: "F".repeat(16) });
  assert.equal(wrongFp.status, 403);
  assert.deepEqual(await (await poll()).json(), { state: "pending" });
  const correct = await deviceForm(f, approve);
  assert.equal(correct.status, 200, await correct.clone().text());
  const bound = await (await poll()).json();
  assert.equal(bound.state, "approved");
  assert.match(bound.device_id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await f.mcp(own.access_token)).status, 200);
  assert.equal(f.calls.length, 1);
  const replay = await deviceForm(f, approve);
  assert.equal(replay.status, 403);
  const revoke = await deviceForm(f, { action: "revoke", device_id: bound.device_id, code: "", fingerprint: "" });
  assert.equal(revoke.status, 200);
  assert.deepEqual(await (await f.mcp(own.access_token)).json(), { error: "device_not_paired" });
  assert.equal(f.calls.length, 1);
  const audit = await (await f.stub()).audit();
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(started.request_id));
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(started.user_code));
  assert.doesNotMatch(JSON.stringify(audit), /private_pkcs8|access_token/);
});

test("step17 Ed25519 device revocation requires fresh proof, stops MCP and invalidates pending delivery", async t => {
  const f = await fixture(t, { paired: false });
  const started = await (await pairStart(f, f.identity)).json();
  assert.equal((await deviceForm(f, { action: "approve", code: started.user_code, fingerprint: started.fingerprint })).status, 200);
  const status = () => f.send("/device/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: started.request_id }) });
  const deviceId = (await (await status()).json()).device_id;
  const sendProof = data => f.send("/device/pair/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const foreign = await signedDeviceRevoke(await generateDeviceIdentity(), deviceId);
  assert.equal((await sendProof(foreign)).status, 403);
  const expired = await signedDeviceRevoke(f.identity, deviceId, { clock: () => Date.now() - 120000 });
  assert.equal((await sendProof(expired)).status, 400);
  const approval = await signedDeviceRevoke(f.identity, deviceId);
  assert.deepEqual(await (await sendProof(approval)).json(), { state: "revoked" });
  assert.equal((await sendProof(approval)).status, 404);
  assert.equal((await status()).status, 404);
  const own = await f.login();
  assert.deepEqual(await (await f.mcp(own.access_token)).json(), { error: "device_not_paired" });
  assert.equal(f.calls.length, 0);
});

test("step17 Windows revoke helper accepts only confirmed Worker response", async t => {
  const f = await fixture(t, { paired: false });
  const started = await (await pairStart(f, f.identity)).json();
  await deviceForm(f, { action: "approve", code: started.user_code, fingerprint: started.fingerprint });
  const deviceId = (await (await f.send("/device/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: started.request_id }) })).json()).device_id;
  const fetcher = (url, args) => f.send(new URL(url).pathname, args);
  assert.equal(await revokeDevice(f.identity, deviceId, { fetcher }), true);
  await assert.rejects(() => revokeDevice(f.identity, deviceId, { fetcher }), /device_revoke_http_404/);
});

test("pairing management blocks forged origins, CSRF replay and incorrect owner password", async t => {
  const f = await fixture(t, { paired: false });
  const browser = await f.send("/device/pair/manage");
  assert.equal(browser.headers.get("referrer-policy"), "same-origin");
  const page = await browser.text();
  const csp = browser.headers.get("content-security-policy");
  const nonce = page.match(/<script nonce="([A-Za-z0-9_-]{32})">/);
  assert.ok(nonce);
  assert.equal(csp, `default-src 'none'; script-src 'nonce-${nonce[1]}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  const script = page.match(/<script nonce="[A-Za-z0-9_-]{32}">([\s\S]+?)<\/script>/)?.[1];
  assert.ok(script);
  assert.match(page, /type="hidden" name="code"/);
  assert.match(page, /type="hidden" name="fingerprint"/);
  assert.doesNotMatch(page, /Код \(10 символов\)|Отпечаток ключа \(16 символов\)/);
  assert.match(page, /name="action" value="approve" disabled/);
  for (const fragment of ["#code=ABCDEFGHJK&fingerprint=0123456789ABCDEF", "#code=bad&fingerprint=0123456789ABCDEF"]) {
    const input = { code: { value: "" }, fingerprint: { value: "" } };
    const approveButton = { disabled: true };
    const help = { textContent: "" };
    let replaced = false;
    runInNewContext(script, { location: { hash: fragment, pathname: "/device/pair/manage" },
      history: { replaceState: (_, __, path) => { assert.equal(path, "/device/pair/manage"); replaced = true; } },
      document: { querySelector: selector => input[selector.match(/name="([^"]+)"/)[1]],
        getElementById: id => id === "pair-approve" ? approveButton : help } });
    assert.equal(input.code.value, fragment.startsWith("#code=ABCDEFGHJK") ? "ABCDEFGHJK" : "");
    assert.equal(input.fingerprint.value, fragment.startsWith("#code=ABCDEFGHJK") ? "0123456789ABCDEF" : "");
    assert.equal(approveButton.disabled, !fragment.startsWith("#code=ABCDEFGHJK"));
    assert.equal(replaced, true); // Even a malformed fragment is removed.
  }
  const started = await (await pairStart(f, f.identity)).json();
  const approve = { action: "approve", code: started.user_code, fingerprint: started.fingerprint };
  assert.equal((await deviceForm(f, approve, { origin: "https://evil.test" })).status, 403);
  assert.equal((await deviceForm(f, approve, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await deviceForm(f, { ...approve, password: "wrong" })).status, 403);
  const before = await f.send("/device/pair/manage");
  const proof = formProof(await before.text());
  const headers = { "content-type": "application/x-www-form-urlencoded", origin: target, "sec-fetch-site": "same-origin" };
  const input = new URLSearchParams({ proof, password, ...approve });
  assert.equal((await f.send("/device/pair/manage", { method: "POST", headers, body: input.toString() })).status, 200);
  assert.equal((await f.send("/device/pair/manage", { method: "POST", headers, body: input.toString() })).status, 403);
  assert.equal((await f.send("/device/pair/manage", { method: "POST", headers, body: new URLSearchParams({ ...approve, proof: "A".repeat(43), password }).toString() })).status, 403);
});

test("public device pairing resists bad input, wrong IDs and expired pending records", async t => {
  const f = await fixture(t, { paired: false });
  assert.equal((await f.send("/device/pair/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_key: "bad", label: "Test" }) })).status, 400);
  assert.equal((await pairStart(f, f.identity, "<script>bad</script>")).status, 400);
  assert.equal((await f.send("/device/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: "bad" }) })).status, 400);
  assert.equal((await f.send("/device/pair/manage?code=secret")).status, 400);
  const started = await (await pairStart(f, f.identity)).json();
  await (await f.stub()).expire("device:pending:");
  const poll = await f.send("/device/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: started.request_id }) });
  assert.equal(poll.status, 404);
  assert.equal((await deviceForm(f, { action: "approve", code: started.user_code, fingerprint: started.fingerprint })).status, 403);
});

test("device proof rejects forged signatures, replayed challenges and offline Windows without forwarding", async t => {
  for (const attestation of ["forged", "replayed", "unavailable"]) {
    const f = await fixture(t, { attestation });
    const login = await f.login();
    const response = await f.mcp(login.access_token, "server/discover", {});
    assert.equal(response.status, 503, attestation);
    assert.equal(f.calls.length, 0, attestation);
  }
});

test("approved Ed25519 identity survives Durable Object SQLite restart without re-pairing", async t => {
  const persistPath = await mkdtemp("/tmp/qwen-device-sqlite-");
  const first = await fixture(t, { paired: false, persistPath });
  const started = await (await pairStart(first, first.identity)).json();
  assert.equal((await deviceForm(first, { action: "approve", code: started.user_code, fingerprint: started.fingerprint })).status, 200);
  const polled = await first.send("/device/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: started.request_id }) });
  const device = await polled.json();
  await first.close();
  const next = await fixture(t, { paired: false, persistPath, deviceIdentity: first.identity, deviceIdOverride: device.device_id });
  const login = await next.login();
  assert.equal((await next.mcp(login.access_token)).status, 200);
});

test("step 9: Windows origin outage and reconnect preserve existing OAuth and device trust", async t => {
  let attestation = "unavailable";
  let originOnline = false;
  const f = await fixture(t, { attestation: () => attestation, upstream: () => {
    if (!originOnline) throw new Error("Cloudflare Tunnel disconnected");
    return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  } });
  const login = await f.login();
  const before = await f.mcp(login.access_token, "server/discover", {});
  assert.equal(before.status, 503);
  assert.deepEqual(await before.json(), { error: "device_unavailable" });
  assert.equal(before.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(f.calls.length, 0);

  attestation = "valid";
  const tunnelDown = await f.mcp(login.access_token, "server/discover", {});
  assert.equal(tunnelDown.status, 503);
  assert.deepEqual(await tunnelDown.json(), { error: "origin_unavailable" });
  assert.equal(f.calls.length, 1);

  originOnline = true;
  const recovered = await f.mcp(login.access_token, "server/discover", {});
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(recovered.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(f.calls.length, 2);

  attestation = "forged";
  assert.equal((await f.mcp(login.access_token, "server/discover", {})).status, 503);
  assert.equal(f.calls.length, 2);
  attestation = "valid";
  assert.equal((await f.mcp(login.access_token, "server/discover", {})).status, 200);
  assert.equal(f.calls.length, 3);
  const audit = await (await f.stub()).audit();
  assert.ok(audit.filter(row => row.stage === "mcp_rpc:server/discover" && row.status === 503).length >= 3);
  assert.ok(audit.filter(row => row.stage === "mcp_rpc:server/discover" && row.status === 200).length >= 2);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(login.access_token));
});

test("step 9: invalid OAuth token and forbidden tool cannot reach recovering Tunnel", async t => {
  let online = false;
  const f = await fixture(t, { upstream: () => {
    if (!online) throw new Error("Host offline");
    return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  } });
  const one = await f.login();
  for (const candidate of ["forged", one.refresh_token, ""]) {
    const response = await f.mcp(candidate, "tools/call", { name: "system_info", arguments: {} });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  }
  assert.equal((await f.mcp(one.access_token, "tools/call", { name: "file_read", arguments: { path: "C:\\private" } })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.mcp(one.access_token)).status, 503);
  online = true;
  assert.equal((await f.mcp(one.access_token)).status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.mcp("forged")).status, 401);
  assert.equal((await f.mcp(one.access_token, "tools/call", { name: "file_read" })).status, 403);
  assert.equal(f.calls.length, 2);
});

test("step 9: MCP session survives temporary outage and is deletable after reconnect", async t => {
  let online = true;
  const session = "session-Step9SafeReconnect";
  const f = await fixture(t, { attestation: () => online ? "valid" : "unavailable", upstream: request => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method === "GET") return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "ping" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }), { headers: { "content-type": "application/json", "mcp-session-id": session } });
  } });
  const login = await f.login();
  const initialized = await f.mcp(login.access_token, "initialize", {});
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get("mcp-session-id"), session);
  online = false;
  const down = await f.send("/mcp", { method: "GET", headers: { authorization: `Bearer ${login.access_token}`, "mcp-session-id": session, accept: "text/event-stream" } });
  assert.equal(down.status, 503);
  assert.equal(f.calls.length, 1);
  online = true;
  const resumed = await f.send("/mcp", { method: "GET", headers: { authorization: `Bearer ${login.access_token}`, "mcp-session-id": session, accept: "text/event-stream" } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.headers.get("content-type"), "text/event-stream");
  assert.equal((await resumed.text()).includes("ping"), true);
  const closed = await f.send("/mcp", { method: "DELETE", headers: { authorization: `Bearer ${login.access_token}`, "mcp-session-id": session } });
  assert.equal(closed.status, 204);
  assert.equal((await f.send("/mcp", { method: "GET", headers: { authorization: `Bearer ${login.access_token}`, "mcp-session-id": session } })).status, 403);
});

test("step 9: one-time OAuth code cannot replay after Windows outage", async t => {
  let online = false;
  const f = await fixture(t, { upstream: () => online ? Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }) : Promise.reject(Error("Offline")) });
  const client = await f.register();
  const oneTimeCode = await f.code(client);
  const first = await f.token(client, oneTimeCode);
  assert.equal(first.status, 200);
  const token = (await first.json()).access_token;
  assert.equal((await f.mcp(token)).status, 503);
  online = true;
  assert.equal((await f.token(client, oneTimeCode)).status, 400);
  // The OAuth provider intentionally revokes the entire grant on code replay.
  // Reconnection alone cannot resurrect an explicitly revoked grant.
  assert.equal((await f.mcp(token)).status, 401);
  const renewed = await f.login();
  assert.equal((await f.mcp(renewed.access_token)).status, 200);
});

test("step 10: real loopback Windows server interoperates with OAuth gateway and Ed25519 VPC proof", async t => {
  const identity = await generateDeviceIdentity();
  const deviceId = randomBytes(24).toString("base64url");
  const server = await listenWindowsMcp({ port: 0, identity, deviceId, gatewayKey, toolRegistry: createWindowsToolRegistry({
    runWindowsQuery: async (name, args) => ({ query: name, params: args, source: "windows-test-double" }),
  }) });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  const loopback = `http://127.0.0.1:${server.address().port}`;
  let attests = 0;
  let calls = 0;
  const f = await fixture(t, {
    deviceIdentity: identity,
    deviceIdOverride: deviceId,
    originBackend: async request => {
      const path = new URL(request.url).pathname;
      if (path === "/device/attest") attests++;
      if (path === "/mcp") calls++;
      // Simulate Workers VPC service binding from the actual HTTP Windows
      // implementation, not a stubbed JSON-RPC response.
      const copyHeaders = new Headers(request.headers);
      copyHeaders.delete("host");
      return fetch(loopback + path, {
        method: request.method,
        headers: copyHeaders,
        ...(request.method === "POST" ? { body: await request.text() } : {}),
      });
    },
  });
  const { access_token } = await f.login();
  const modernParams = { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "integration-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } };
  const modernHeaders = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" };
  const discover = await f.mcp(access_token, "server/discover", modernParams, modernHeaders);
  assert.equal(discover.status, 200, await discover.clone().text());
  assert.deepEqual((await discover.json()).result.supportedVersions, ["2026-07-28", "2025-11-25"]);
  const listed = await f.mcp(access_token, "tools/list", modernParams, { ...modernHeaders, "mcp-method": "tools/list" });
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.deepEqual((await listed.json()).result.tools.map(tool => tool.name), ["system_info", "system_monitor", "process_list", "service_status", "app_status", "admin_status"]);
  const called = await f.mcp(access_token, "tools/call", { ...modernParams, name: "system_info", arguments: {} }, { ...modernHeaders, "mcp-method": "tools/call", "mcp-name": "system_info" });
  assert.equal(called.status, 200, await called.clone().text());
  assert.equal(JSON.parse((await called.json()).result.content[0].text).source, "windows-test-double");
  const initialize = await f.mcp(access_token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }, { "mcp-protocol-version": "2025-11-25", accept: "application/json, text/event-stream" });
  assert.equal(initialize.status, 200, await initialize.clone().text());
  const sid = initialize.headers.get("mcp-session-id");
  assert.match(sid, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await f.send("/mcp", { method: "DELETE", headers: { authorization: `Bearer ${access_token}`, "mcp-session-id": sid } })).status, 204);
  assert.equal(attests, 5);
  assert.equal(calls, 5);
});
