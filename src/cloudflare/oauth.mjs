import { OAuthAuthorizationServer, AuthorizationError, openTransaction } from "./vendor/oauth-provider.mjs";

export const ISSUER = "https://qwen125b-mcp.vl-ktk.workers.dev";
export const RESOURCE = ISSUER + "/mcp";
export const SCOPES = Object.freeze(["qwen:read", "qwen:files:read", "qwen:update", "qwen:maintenance", "qwen:localai:install"]);
const COOKIE_BASE = "__Host-qwen125b-consent";
const CONSENT_PROOF_TTL = 600;

// Chrome can suppress cookies even on the consent page. A separate one-time,
// same-origin form proof provides a strict CSRF alternative without extending
// an OAuth transaction's lifetime or relaxing Origin / PKCE / password checks.
function digestEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== 64 || b.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
const PUBLIC_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", ...PUBLIC_HEADERS, ...headers,
  } });
}

export function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(PUBLIC_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export function challenge(error = "invalid_token", status = 401) {
  return json(status, { error }, {
    "www-authenticate": `Bearer realm="qwen125b-mcp", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", error="${error}"`,
  });
}

export async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export async function passwordMatches(actual, expected) {
  if (typeof actual !== "string" || actual.length > 1024) return false;
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function readBody(request, limit = 65536) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let total = 0;
  const parts = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error("payload_too_large"); }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const esc = value => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

export const server = new OAuthAuthorizationServer({
  issuer: ISSUER,
  resources: [RESOURCE],
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: [...SCOPES],
  cookiePrefix: "__Host-qwen125b-",
  accessTokenTTL: 600,
  refreshTokenTTL: 86400,
  clientRegistrationTTL: 604800,
  // No remote metadata fetches, social integrations, logging of library details,
  // implicit flow, token exchange, or external-token fallback.
  clientIdMetadataDocumentEnabled: false,
  onError() {},
});

export function isConfigured(env) {
  return typeof env.QWEN_OAUTH_OWNER_PASSWORD === "string" && env.QWEN_OAUTH_OWNER_PASSWORD.length >= 5
    && /^[1-9][0-9]{0,8}$/.test(env.QWEN_OAUTH_GENERATION ?? "");
}

export async function rateLimit(kv, key, limit, seconds) {
  const window = Math.floor(Date.now() / (seconds * 1000));
  const storageKey = `rate:${key}:${window}`;
  const count = Number(await kv.get(storageKey) ?? 0);
  if (count >= limit) return false;
  await kv.put(storageKey, String(count + 1), { expirationTtl: seconds * 2 });
  return true;
}

function assertUnique(params) {
  for (const name of new Set(params.keys())) if (params.getAll(name).length !== 1) {
    throw new AuthorizationError("invalid_request", { description: "Duplicate parameters" });
  }
}

function validateAuthRequest(auth) {
  // Require PKCE for confidential clients too; the provider requires it for public clients.
  if (auth.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(auth.codeChallenge ?? "")) {
    throw new AuthorizationError("invalid_request", { description: "S256 PKCE required" });
  }
  if (auth.resource !== RESOURCE || auth.scope.length === 0 || auth.scope.some(s => !SCOPES.includes(s))) {
    throw new AuthorizationError("invalid_scope", { description: "Unsupported scope or resource" });
  }
}

// Public reason codes intentionally contain no cookie, handle, client or password data.
function consentSessionFailure(error) {
  if (!(error instanceof AuthorizationError) || error.code !== "invalid_request") return null;
  const message = error.description ?? "";
  const reason = message.includes("not started in this browser") ? "consent_cookie_missing"
    : message.includes("different browser session") ? "consent_cookie_mismatch"
    : message.includes("expired or was already used") ? "consent_expired"
    : message.includes("Missing transaction handle") ? "consent_handle_missing"
    : "consent_session_invalid";
  return json(400, { error: "invalid_request", reason });
}

async function authorize(request, env, kv) {
  const api = server.getOAuthApi({ OAUTH_KV: kv });
  if (request.method === "GET") {
    assertUnique(new URL(request.url).searchParams);
    const auth = await api.parseAuthRequest(request);
    validateAuthRequest(auth);
    const client = await api.lookupClient(auth.clientId);
    // Chrome applies form-action to the POST's redirect chain too. 'self' alone
    // permits the POST but blocks the provider's 302 to ChatGPT after consent.
    // Only the already validated, registered callback origin may be added.
    const callbackOrigin = new URL(auth.redirectUri).origin;
    if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?$/i.test(callbackOrigin)) {
      throw new AuthorizationError("invalid_request", { description: "Unsupported redirect origin" });
    }
    const consent = await api.beginConsent(auth);
    const formProof = [...crypto.getRandomValues(new Uint8Array(32))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    await kv.put(`consent-proof:${await hash(consent.handle)}`, await hash(formProof),
      { expirationTtl: CONSENT_PROOF_TTL });
    const headers = new Headers(consent.headers);
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", `default-src 'none'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`);
    headers.set("x-qwen-oauth-stage", "consent_issued");
    const sourceUrl = new URL(request.url);
    const formAction = sourceUrl.pathname + sourceUrl.search;
    const expiresAt = new Date(Date.now() + CONSENT_PROOF_TTL * 1000).toISOString();
    const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Qwen 125B MCP</title>
<h1>Доступ к Qwen 125B MCP</h1><p>Клиент: ${esc(client.clientName || auth.clientId)}</p>
<p>Возврат: ${esc(auth.redirectUri)}</p><p>Разрешайте доступ только после проверки клиента и адреса возврата.</p>
<p>Форма одноразовая и действует 10 минут (до <time datetime="${expiresAt}">${expiresAt}</time>). Если срок истечёт, откроется новая форма; пароль потребуется ввести заново.</p>
<form method="post" action="${esc(formAction)}"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="form_proof" value="${formProof}">
${auth.scope.map(scope => `<p><label><input type="checkbox" name="scope" value="${esc(scope)}" checked>${esc(scope)}</label></p>`).join("")}
<p><label>Пароль владельца <input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label></p>
<button name="decision" value="approve">Разрешить</button><button name="decision" value="deny" formnovalidate>Отказать</button></form></html>`;
    return new Response(html, { headers });
  }
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "GET, POST" });
  if (request.headers.get("origin") !== ISSUER) return json(403, { error: "invalid_origin" });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return json(415, { error: "invalid_content_type" });
  const formBody = await readBody(request, 16384);
  const form = new URLSearchParams(formBody);
  for (const name of ["handle", "password", "decision", "form_proof"]) if (form.getAll(name).length > 1) return json(400, { error: "invalid_request", reason: "consent_duplicate_field" });
  const handle = form.get("handle");
  if (typeof handle !== "string" || handle.length > 128) return json(400, { error: "invalid_request", reason: "consent_handle_invalid" });
  let preview;
  let consentRequest = request;
  const handleDigest = await hash(handle);
  // Cookie Max-Age and both server records expire after 600 s. Check the OAuth
  // transaction first: v8 mistook an absent/expired/consumed proof for a hash
  // mismatch before it ever reached the provider's transaction expiry check.
  if (!await kv.get(`transaction:${handleDigest}`)) {
    const url = new URL(request.url);
    if (request.headers.get("accept")?.includes("text/html")
      && request.headers.get("sec-fetch-site") === "same-origin" && url.search) {
      // This is a NEW GET + consent + password, never acceptance of the old proof.
      // Validate the same-origin restart URL; no submitted password is retained.
      try {
        assertUnique(url.searchParams);
        validateAuthRequest(await api.parseAuthRequest(new Request(url)));
        return new Response(null, { status: 303, headers: {
          location: url.pathname + url.search, "cache-control": "no-store",
          "x-qwen-oauth-stage": "consent_expired_restart",
        } });
      } catch { /* Non-browser or invalid restart parameters fail closed below. */ }
    }
    return json(400, { error: "invalid_request", reason: "consent_expired" });
  }
  try { preview = await openTransaction(kv, consentRequest, COOKIE_BASE, handle, "consent"); }
  catch (error) {
    const failure = consentSessionFailure(error);
    if (failure?.status !== 400 || error.description?.includes("not started in this browser") !== true) {
      if (failure) return failure;
      throw error;
    }
    // Fallback accepts only a form actually served by this host, submitted
    // by a same-origin browser navigation. Other cookie failures still fail closed.
    const proof = form.get("form_proof");
    if (request.headers.get("sec-fetch-site") !== "same-origin" || !/^[a-f0-9]{64}$/.test(proof ?? "")) {
      return json(400, { error: "invalid_request", reason: "consent_cookie_missing" });
    }
    const expected = await kv.get(`consent-proof:${handleDigest}`);
    if (expected === null) return json(400, { error: "invalid_request", reason: "consent_form_proof_missing" });
    if (!digestEquals(await hash(proof), expected)) {
      return json(400, { error: "invalid_request", reason: "consent_form_proof_invalid" });
    }
    const boundHeaders = new Headers(request.headers);
    boundHeaders.set("cookie", `${COOKIE_BASE}-${handleDigest.slice(0, 16)}=${handleDigest}`);
    consentRequest = new Request(request.url, { method: "POST", headers: boundHeaders, body: formBody });
    try { preview = await openTransaction(kv, consentRequest, COOKIE_BASE, handle, "consent"); }
    catch (retryError) {
      const retryFailure = consentSessionFailure(retryError);
      if (retryFailure) return retryFailure;
      throw retryError;
    }
  }
  try { validateAuthRequest(preview.record.request); }
  catch (error) { if (error instanceof AuthorizationError) return json(400, { error: "invalid_request", reason: "consent_auth_record_invalid" }); throw error; }
  if (form.get("decision") === "deny") {
    const denied = await api.denyConsent(consentRequest, handle);
    await kv.delete(`consent-proof:${handleDigest}`);
    const headers = new Headers(denied.headers);
    headers.set("location", denied.redirectTo);
    headers.set("x-qwen-oauth-stage", "consent_denied");
    return new Response(null, { status: 302, headers });
  }
  if (form.get("decision") !== "approve") return json(400, { error: "invalid_request", reason: "consent_decision_missing" });
  if (!await rateLimit(kv, "owner-login", 5, 900)) return json(429, { error: "rate_limited" });
  if (!await passwordMatches(form.get("password"), env.QWEN_OAUTH_OWNER_PASSWORD)) return json(403, { error: "access_denied" });
  const scopes = [...new Set(form.getAll("scope"))];
  if (!scopes.length || scopes.some(s => !preview.record.request.scope.includes(s))) return json(400, { error: "invalid_scope" });
  let approved, done;
  try {
    approved = await api.approveConsent(consentRequest, handle, { scope: scopes });
    await kv.delete(`consent-proof:${handleDigest}`);
    done = await api.completeAuthorization({
      request: approved.request, userId: "qwen-owner", metadata: {}, scope: scopes,
      props: { project: "qwen125b-mcp", generation: env.QWEN_OAUTH_GENERATION },
      revokeExistingGrants: true,
    });
  } catch (error) {
    if ((error instanceof AuthorizationError && error.code === "invalid_request") || error instanceof SyntaxError || error instanceof URIError) {
      return json(400, { error: "invalid_request", reason: "consent_completion_invalid" });
    }
    throw error;
  }
  const headers = new Headers(approved.headers);
  headers.set("location", done.redirectTo);
  headers.set("x-qwen-oauth-stage", "code_issued");
  return new Response(null, { status: 302, headers });
}

export async function oauthRequest(request, env, kv) {
  const url = new URL(request.url);
  if (!isConfigured(env)) return json(503, { error: "authorization_not_configured" });
  if (!await rateLimit(kv, "protocol", 180, 60)) return json(429, { error: "rate_limited" });
  if (url.pathname === "/authorize") return authorize(request, env, kv);
  if (url.pathname === "/oauth/register" && request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json(415, { error: "invalid_content_type" });
    if (!await rateLimit(kv, "registration", 30, 3600)) return json(429, { error: "rate_limited" });
    const text = await readBody(request, 16384);
    const registration = JSON.parse(text);
    if (!registration || typeof registration !== "object" || Array.isArray(registration)) return json(400, { error: "invalid_client_metadata" });
    if (registration.scope !== undefined && (typeof registration.scope !== "string"
      || registration.scope.split(" ").some(s => !SCOPES.includes(s)))) return json(400, { error: "invalid_scope" });
    request = new Request(request.url, { method: "POST", headers: request.headers, body: text });
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return json(415, { error: "invalid_content_type" });
    const text = await readBody(request, 16384);
    const form = new URLSearchParams(text);
    assertUnique(form);
    if (form.has("code") || form.get("grant_type") === "authorization_code") {
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(form.get("code_verifier") ?? "")) return json(400, { error: "invalid_grant" });
      if (!form.get("redirect_uri")) return json(400, { error: "invalid_request" });
    }
    // The copied provider intentionally allows the previous refresh token for retries.
    // Qwen requires strict rotation: reuse of that previous token revokes this grant.
    if (form.get("grant_type") === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const [user, grant, secret, extra] = token.split(":");
      if (!user || !grant || !secret || extra) return json(400, { error: "invalid_grant" });
      const record = await kv.get(`grant:${user}:${grant}`, "json");
      const digest = await hash(token);
      if (record?.previousRefreshTokenId === digest) {
        await server.getOAuthApi({ OAUTH_KV: kv }).revokeGrant(grant, user);
        return json(400, { error: "invalid_grant" });
      }
    }
    request = new Request(request.url, { method: "POST", headers: request.headers, body: text });
  }
  const response = await server.fetch(request, { OAUTH_KV: kv }, {});
  if (url.pathname === "/oauth/token" && request.method === "POST" && response.ok) {
    const headers = new Headers(response.headers);
    headers.set("x-qwen-oauth-stage", "token_endpoint_success");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

export async function verify(request, env, kv) {
  if (!isConfigured(env)) return null;
  const match = /^Bearer ([A-Za-z0-9:_-]{1,512})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return null;
  const verified = await server.validateToken(RESOURCE, match[1], { OAUTH_KV: kv });
  if (!verified || verified.expiresAt <= Date.now() / 1000 || verified.userId !== "qwen-owner"
    || verified.props?.project !== "qwen125b-mcp" || verified.props?.generation !== env.QWEN_OAUTH_GENERATION
    || !Array.isArray(verified.scope) || !verified.scope.length || verified.scope.some(s => !SCOPES.includes(s))) return null;
  const [user, grantId] = match[1].split(":");
  const grant = await kv.get(`grant:${user}:${grantId}`, "json");
  if (!grant || grant.clientId !== verified.clientId || grant.resource !== RESOURCE) return null;
  return { ...verified, sessionOwner: await hash(`${user}:${grantId}:${verified.clientId}:${[...verified.scope].sort().join(" ")}`) };
}
