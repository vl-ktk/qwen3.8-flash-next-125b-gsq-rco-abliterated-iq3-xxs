import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { buildSync } from "esbuild";

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

async function fixture(t, { configured = true, state = true, upstream, ownerPassword = password } = {}) {
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "qwen-test", modules: true,
    script: testBundle,
    compatibilityDate: "2026-11-17", compatibilityFlags: ["global_fetch_strictly_public"], log: new Log(LogLevel.ERROR),
    outboundService: () => { throw Error("External network forbidden in tests"); },
    durableObjects: state ? { QWEN_OAUTH_STATE: { className: "TestOAuthState", useSQLite: true } } : {},
    bindings: configured ? { QWEN_OAUTH_OWNER_PASSWORD: ownerPassword, QWEN_OAUTH_GENERATION: "1" } : {},
    serviceBindings: { QWEN_MCP_ORIGIN: async request => {
      const body = await request.text();
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
      if (upstream) return upstream(request, body);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    } },
  }));
  t.after(() => mf.dispose());
  const send = (path, init) => mf.dispatchFetch(target + path, { redirect: "manual", ...init });
  const stub = async () => (await mf.getDurableObjectNamespace("QWEN_OAUTH_STATE")).getByName("qwen125b-oauth-v1");
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
  return { mf, calls, send, register, begin, approve, code, token, login, mcp, stub };
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
  assert.ok(started.html.includes('<form method="post" action="/authorize">'));
  assert.equal((await f.approve(started, {}, { origin: "null" })).status, 403);
  assert.equal((await f.approve(started)).status, 302);
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
  assert.deepEqual(await replay.json(), { error: "invalid_request", reason: "consent_form_proof_invalid" });
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
  for (const name of ["file_read", "powershell", "reboot", "file_write", "unknown", "__proto__", "constructor"]) assert.equal((await f.mcp(login.access_token, "tools/call", { name })).status, 403, name);
  assert.equal((await f.mcp(login.access_token, "resources/read")).status, 403);
  assert.equal((await f.send("/mcp/tools/call", { headers: { authorization: "Bearer " + login.access_token } })).status, 404);
  assert.equal((await f.mcp(login.access_token, undefined, undefined, { origin: "https://evil.test" })).status, 403);
  assert.equal((await f.mcp(login.access_token, undefined, undefined, { "mcp-session-id": "forged" })).status, 403);
  assert.equal((await f.mcp(login.access_token, undefined, undefined, { "last-event-id": "forged" })).status, 403);
  assert.equal((await f.mcp(login.access_token, "tools/call", { name: ["system_info"] })).status, 400);
  assert.equal((await f.send("/mcp?access_token=" + login.access_token)).status, 401);
  assert.equal((await f.send("/mcp", { method: "POST", headers: { authorization: "Bearer " + login.access_token, "content-type": "application/json" }, body: "[]" })).status, 400);
  assert.equal(f.calls.length, 0);
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
