import { OAuthAuthorizationServer, AuthorizationError, openTransaction } from "./vendor/oauth-provider.mjs";

export const ISSUER = "https://qwen125b-mcp.vl-ktk.workers.dev";
export const RESOURCE = ISSUER + "/mcp";
export const SCOPES = Object.freeze(["qwen:read", "qwen:files:read"]);
const COOKIE_BASE = "__Host-qwen125b-consent";
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

async function passwordMatches(actual, expected) {
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

async function authorize(request, env, kv) {
  const api = server.getOAuthApi({ OAUTH_KV: kv });
  if (request.method === "GET") {
    assertUnique(new URL(request.url).searchParams);
    const auth = await api.parseAuthRequest(request);
    validateAuthRequest(auth);
    const client = await api.lookupClient(auth.clientId);
    const consent = await api.beginConsent(auth);
    const headers = new Headers(consent.headers);
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Qwen 125B MCP</title>
<h1>Доступ к Qwen 125B MCP</h1><p>Клиент: ${esc(client.clientName || auth.clientId)}</p>
<p>Возврат: ${esc(auth.redirectUri)}</p><p>Разрешайте доступ только после проверки клиента и адреса возврата.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(consent.handle)}">
${auth.scope.map(scope => `<p><label><input type="checkbox" name="scope" value="${esc(scope)}" checked>${esc(scope)}</label></p>`).join("")}
<p><label>Пароль владельца <input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label></p>
<button name="decision" value="approve">Разрешить</button><button name="decision" value="deny" formnovalidate>Отказать</button></form></html>`;
    return new Response(html, { headers });
  }
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "GET, POST" });
  if (request.headers.get("origin") !== ISSUER) return json(403, { error: "invalid_origin" });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return json(415, { error: "invalid_content_type" });
  const form = new URLSearchParams(await readBody(request, 16384));
  for (const name of ["handle", "password", "decision"]) if (form.getAll(name).length > 1) return json(400, { error: "invalid_request" });
  const handle = form.get("handle");
  if (typeof handle !== "string" || handle.length > 128) return json(400, { error: "invalid_request" });
  const preview = await openTransaction(kv, request, COOKIE_BASE, handle, "consent");
  validateAuthRequest(preview.record.request);
  if (form.get("decision") === "deny") {
    const denied = await api.denyConsent(request, handle);
    const headers = new Headers(denied.headers);
    headers.set("location", denied.redirectTo);
    return new Response(null, { status: 302, headers });
  }
  if (form.get("decision") !== "approve") return json(400, { error: "invalid_request" });
  if (!await rateLimit(kv, "owner-login", 5, 900)) return json(429, { error: "rate_limited" });
  if (!await passwordMatches(form.get("password"), env.QWEN_OAUTH_OWNER_PASSWORD)) return json(403, { error: "access_denied" });
  const scopes = [...new Set(form.getAll("scope"))];
  if (!scopes.length || scopes.some(s => !preview.record.request.scope.includes(s))) return json(400, { error: "invalid_scope" });
  const approved = await api.approveConsent(request, handle, { scope: scopes });
  const done = await api.completeAuthorization({
    request: approved.request, userId: "qwen-owner", metadata: {}, scope: scopes,
    props: { project: "qwen125b-mcp", generation: env.QWEN_OAUTH_GENERATION },
    revokeExistingGrants: true,
  });
  const headers = new Headers(approved.headers);
  headers.set("location", done.redirectTo);
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
  return server.fetch(request, { OAUTH_KV: kv }, {});
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
