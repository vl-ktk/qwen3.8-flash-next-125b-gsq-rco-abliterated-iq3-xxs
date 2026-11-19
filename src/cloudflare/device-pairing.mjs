import { ISSUER, json, readBody, hash, isConfigured, passwordMatches, rateLimit } from "./oauth.mjs";
import { OAuthStorage } from "./storage.mjs";

// This is the cloud half of Windows device enrollment, not a replacement for
// user OAuth. No device private key or long-lived device credential is stored.
export const DEVICE_PATHS = new Set(["/device/pair/start", "/device/pair/status", "/device/pair/manage"]);
const TTL = 600;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const encoder = new TextEncoder();

const random = length => crypto.getRandomValues(new Uint8Array(length));
export const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
export const decode64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
const randomCode = () => [...random(10)].map(b => ALPHABET[b & 31]).join("");
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value);
const validPublic = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const validCode = value => typeof value === "string" && /^[A-HJ-NP-Z2-9]{10}$/.test(value);
const escaped = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = body => new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Qwen — привязка устройства</title>${body}</html>`, {
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
});

async function parseJson(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  try { const body = JSON.parse(await readBody(request, 4096)); return body && typeof body === "object" && !Array.isArray(body) ? body : null; }
  catch { return null; }
}

export async function devicePairRoute(request, env, storage) {
  if (!isConfigured(env)) return json(503, { error: "authorization_not_configured" });
  const path = new URL(request.url).pathname;
  if (new URL(request.url).search) return json(400, { error: "invalid_request" });
  if (path === "/device/pair/start" && request.method === "POST") {
    const body = await parseJson(request);
    if (!body || !validPublic(body.public_key) || typeof body.label !== "string" || body.label.length < 1 || body.label.length > 64 || !/^[\p{L}\p{N} ._-]+$/u.test(body.label)) return json(400, { error: "invalid_request" });
    let key;
    try { key = await crypto.subtle.importKey("raw", decode64(body.public_key), "Ed25519", false, ["verify"]); }
    catch { return json(400, { error: "invalid_public_key" }); }
    if (!key) return json(400, { error: "invalid_public_key" });
    return storage.transaction(async tx => {
      const kv = new OAuthStorage(tx);
      if (!await rateLimit(kv, "device-start", 12, 900)) return json(429, { error: "rate_limited" });
      const requestId = base64url(random(24));
      const code = randomCode();
      const fingerprint = (await hash(body.public_key)).slice(0, 16).toUpperCase();
      const record = { public_key: body.public_key, label: body.label, fingerprint, state: "pending" };
      await kv.put(`device:pending:${await hash(requestId)}`, JSON.stringify(record), { expirationTtl: TTL });
      await kv.put(`device:code:${await hash(code)}`, await hash(requestId), { expirationTtl: TTL });
      return json(201, { request_id: requestId, user_code: code, fingerprint, verification_uri: ISSUER + "/device/pair/manage", expires_in: TTL });
    });
  }
  if (path === "/device/pair/status" && request.method === "POST") {
    const body = await parseJson(request);
    if (!validId(body?.request_id)) return json(400, { error: "invalid_request" });
    return storage.transaction(async tx => {
      const kv = new OAuthStorage(tx);
      if (!await rateLimit(kv, "device-status", 120, 60)) return json(429, { error: "rate_limited" });
      const pending = await kv.get(`device:pending:${await hash(body.request_id)}`, "json");
      if (!pending) return json(404, { error: "pairing_not_found" });
      return json(200, pending.state === "approved" ? { state: "approved", device_id: pending.device_id } : { state: "pending" });
    });
  }
  if (path === "/device/pair/manage" && request.method === "GET") {
    const proof = base64url(random(32));
    await storage.transaction(async tx => new OAuthStorage(tx).put(`device:csrf:${await hash(proof)}`, "1", { expirationTtl: TTL }));
    return html(`<h1>Qwen: разрешить устройство</h1><p>Проверьте код и отпечаток ключа на самом Windows-компьютере.</p><form method="post" action="/device/pair/manage">
<input type="hidden" name="proof" value="${proof}"><label>Код (10 символов) <input name="code" required maxlength="10"></label>
<label>Отпечаток ключа (16 символов) <input name="fingerprint" required maxlength="16"></label>
<label>Пароль владельца <input type="password" name="password" required maxlength="1024" autocomplete="current-password"></label>
<button name="action" value="approve">Разрешить</button>
<p>Для отзыва введите идентификатор устройства вместо кода и отпечатка:</p>
<label>Device ID <input name="device_id" maxlength="32"></label><button name="action" value="revoke" formnovalidate>Отозвать доступ</button></form>`);
  }
  if (path === "/device/pair/manage" && request.method === "POST") {
    if (request.headers.get("origin") !== ISSUER || request.headers.get("sec-fetch-site") !== "same-origin") return json(403, { error: "invalid_origin" });
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return json(415, { error: "invalid_content_type" });
    let form;
    try { form = new URLSearchParams(await readBody(request, 8192)); }
    catch { return json(400, { error: "invalid_request" }); }
    for (const name of ["proof", "password", "action", "code", "fingerprint", "device_id"]) if (form.getAll(name).length > 1) return json(400, { error: "invalid_request" });
    const proof = form.get("proof");
    if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return json(403, { error: "invalid_proof" });
    return storage.transaction(async tx => {
      const kv = new OAuthStorage(tx);
      const proofKey = `device:csrf:${await hash(proof)}`;
      if (!await kv.get(proofKey)) return json(403, { error: "invalid_proof" });
      await kv.delete(proofKey); // one use, including incorrect password
      if (!await rateLimit(kv, "owner-login", 5, 900)) return json(429, { error: "rate_limited" });
      if (!await passwordMatches(form.get("password"), env.QWEN_OAUTH_OWNER_PASSWORD)) return json(403, { error: "access_denied" });
      if (form.get("action") === "revoke") {
        const id = form.get("device_id");
        if (!validId(id)) return json(400, { error: "invalid_request" });
        const active = await kv.get("device:active", "json");
        if (!active || active.device_id !== id) return json(404, { error: "device_not_found" });
        await kv.delete("device:active");
        return html("<h1>Доступ устройства отозван</h1>");
      }
      if (form.get("action") !== "approve") return json(400, { error: "invalid_request" });
      const code = form.get("code")?.toUpperCase();
      const fingerprint = form.get("fingerprint")?.toUpperCase();
      if (!validCode(code) || !/^[A-F0-9]{16}$/.test(fingerprint ?? "")) return json(400, { error: "invalid_request" });
      const codeKey = `device:code:${await hash(code)}`;
      const requestHash = await kv.get(codeKey);
      const pendingKey = `device:pending:${requestHash}`;
      const pending = requestHash ? await kv.get(pendingKey, "json") : null;
      if (!pending || pending.state !== "pending" || pending.fingerprint !== fingerprint) return json(403, { error: "pairing_mismatch" });
      const deviceId = base64url(random(24));
      await kv.put("device:active", JSON.stringify({ device_id: deviceId, public_key: pending.public_key, label: pending.label }));
      pending.device_id = deviceId;
      pending.state = "approved";
      await kv.put(pendingKey, JSON.stringify(pending), { expirationTtl: TTL });
      await kv.delete(codeKey);
      return html(`<h1>Устройство ${escaped(pending.label)} привязано</h1><p>Device ID: <code>${deviceId}</code></p>`);
    });
  }
  return json(405, { error: "method_not_allowed" }, { allow: path === "/device/pair/manage" ? "GET, POST" : "POST" });
}

export async function attestDevice(origin, storage) {
  const kv = new OAuthStorage(storage);
  const active = await kv.get("device:active", "json");
  if (!active) return json(503, { error: "device_not_paired" });
  if (!origin?.fetch) return json(503, { error: "origin_unavailable" });
  const nonce = base64url(random(32));
  let result;
  try {
    const response = await origin.fetch(new Request("http://127.0.0.1:8765/device/attest", {
      method: "GET", headers: { "x-qwen-device-id": active.device_id, "x-qwen-device-nonce": nonce },
      redirect: "manual", signal: AbortSignal.timeout(5000),
    }));
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) return json(503, { error: "device_unavailable" });
    result = JSON.parse(await readBody(response, 512));
  } catch { return json(503, { error: "device_unavailable" }); }
  if (result?.device_id !== active.device_id || !/^[A-Za-z0-9_-]{86}$/.test(result.signature ?? "")) return json(503, { error: "device_untrusted" });
  try {
    const key = await crypto.subtle.importKey("raw", decode64(active.public_key), "Ed25519", false, ["verify"]);
    const data = encoder.encode(`QWEN-MCP-DEVICE-V1\n${ISSUER}\n${active.device_id}\n${nonce}`);
    if (!await crypto.subtle.verify("Ed25519", key, decode64(result.signature), data)) return json(503, { error: "device_untrusted" });
  } catch { return json(503, { error: "device_untrusted" }); }
  const current = await kv.get("device:active", "json");
  if (current?.device_id !== active.device_id || current.public_key !== active.public_key) return json(503, { error: "device_revoked" });
  return null;
}
