import { DurableObject } from "cloudflare:workers";
import { OAuthStorage } from "./storage.mjs";
import { ISSUER, RESOURCE, SCOPES, json, secure, challenge, readBody, oauthRequest, verify, isConfigured } from "./oauth.mjs";
import { DEVICE_PATHS, devicePairRoute, attestDevice } from "./device-pairing.mjs";
import { signedOriginHeaders } from "./origin-auth.mjs";

// Explicitly scoped KTK release updates and tightly allowlisted KTK service
// maintenance are the only mutations. Arbitrary commands, PC-wide admin,
// reboots and unknown tools are denied.
export const TOOL_SCOPES = Object.freeze({
  system_info: "qwen:read", system_monitor: "qwen:read", process_list: "qwen:read",
  service_status: "qwen:read", app_status: "qwen:read", file_read: "qwen:files:read",
  admin_status: "qwen:read",
  pc_preflight: "qwen:read", storage_check: "qwen:read",
  runtime_check: "qwen:read", installation_plan: "qwen:read",
  pc_full_audit: "qwen:read", pc_gpu_audit: "qwen:read",
  pc_storage_audit: "qwen:read", pc_memory_audit: "qwen:read",
  pc_install_diagnostics: "qwen:read", pc_readiness_report: "qwen:read",
  pc_performance_advice: "qwen:read",
  pc_maintenance_preview: "qwen:read", pc_maintenance_status: "qwen:read",
  pc_maintenance_apply: "qwen:maintenance",
  update_status: "qwen:read", update_apply: "qwen:update", update_resume: "qwen:update",
});
const VERSION = /^0\.18\.[1-9]\d{0,3}$/;
const DIGEST = /^[a-f0-9]{64}$/;
// Catalog is populated by a separately verified CI release operation. The
// assistant cannot pick a URL or hash in a tool call. No catalog = no updates.
export function approvedRelease(env, version) {
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (typeof env?.QWEN_UPDATE_RELEASES_JSON !== "string" || env.QWEN_UPDATE_RELEASES_JSON.length > 16384) return null;
  let catalog;
  try { catalog = JSON.parse(env.QWEN_UPDATE_RELEASES_JSON); } catch { return null; }
  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") return null;
  const entry = Object.hasOwn(catalog, version) ? catalog[version] : null;
  if (!entry || Array.isArray(entry) || Object.keys(entry).sort().join() !== "sha256,url") return null;
  if (typeof entry.sha256 !== "string" || !DIGEST.test(entry.sha256) || typeof entry.url !== "string" || entry.url.length > 2048) return null;
  let url;
  try { url = new URL(entry.url); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      !(["github.com", "api.github.com"].includes(url.hostname) || url.hostname.endsWith(".blob.core.windows.net") || url.hostname.endsWith(".oaiusercontent.com"))) return null;
  return { version, url: url.toString(), sha256: entry.sha256 };
}
const PROTOCOL_PATHS = new Set(["/authorize", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server"]);
const RESOURCE_PATHS = new Set(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]);

function publicRoute(request, env) {
  const url = new URL(request.url);
  if (url.origin !== ISSUER) return json(404, { error: "not_found" });
  if (request.method === "GET" && url.pathname === "/__edge_status") return json(200, {
    state: env?.QWEN_OAUTH_STATE && isConfigured(env) ? "protected" : "locked", endpoint: "mcp",
  });
  if (RESOURCE_PATHS.has(url.pathname)) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) return json(405, { error: "method_not_allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    const response = json(200, { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: SCOPES, bearer_methods_supported: ["header"] });
    return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
  }
  if (!PROTOCOL_PATHS.has(url.pathname) && !DEVICE_PATHS.has(url.pathname) && url.pathname !== "/mcp") return json(404, { error: "not_found" });
  return null;
}

function errorResponse(error) {
  if (error?.message === "payload_too_large") return json(413, { error: "payload_too_large" });
  if (error?.name === "AuthorizationError" || error instanceof SyntaxError || error instanceof URIError) return json(400, { error: "invalid_request" });
  return json(503, { error: "authorization_unavailable" });
}

export default {
  async fetch(request, env) {
    const direct = publicRoute(request, env);
    // Preserve the original locked gateway when OAuth is not provisioned.
    if (direct && !(new URL(request.url).pathname.startsWith("/mcp/") && !env?.QWEN_OAUTH_STATE)) return direct;
    if (!env?.QWEN_OAUTH_STATE) {
      return new URL(request.url).pathname.startsWith("/mcp")
        ? json(401, { error: "authorization_not_configured" }, { "www-authenticate": 'Bearer realm="qwen125b-mcp"' })
        : json(503, { error: "authorization_not_configured" });
    }
    try { return secure(await env.QWEN_OAUTH_STATE.getByName("qwen125b-oauth-v1").fetch(request)); }
    catch { return json(503, { error: "authorization_unavailable" }); }
  },
};

export class QwenOAuthState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Owner-readable operational evidence, with no cookies, handles, proofs,
    // passwords, codes, tokens, client IDs or request bodies. Existing KV is untouched.
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS qwen_oauth_audit_v1 (
      at_ms INTEGER NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL,
      stage TEXT NOT NULL, reason TEXT NOT NULL
    )`);
  }

  async recordResult(request, response, rpcMethod = "") {
    const path = new URL(request.url).pathname;
    let reason = "";
    if (response.status >= 400 && response.headers.get("content-type")?.startsWith("application/json")) {
      const error = await response.clone().json().catch(() => ({}));
      const candidate = error.reason ?? error.error;
      if (typeof candidate === "string" && /^[a-z_]{1,80}$/.test(candidate)) reason = candidate;
    }
    // Store only a bounded JSON-RPC method name, never the request body, tool
    // name/arguments, credentials, or authorization headers. A live client can
    // otherwise produce method_not_allowed without showing which protocol
    // method its capability negotiation attempted.
    const stage = path === "/mcp" && rpcMethod ? `mcp_rpc:${rpcMethod}`
      : response.headers.get("x-qwen-oauth-stage") ?? (path === "/mcp" ? "mcp" : "protocol");
    this.ctx.storage.sql.exec("INSERT INTO qwen_oauth_audit_v1 VALUES (?, ?, ?, ?, ?)", Date.now(), path, response.status, stage, reason);
    return response;
  }

  async fetch(request) {
    const direct = publicRoute(request, this.env);
    if (direct) return direct;
    try {
      if (new URL(request.url).pathname === "/mcp") {
        const audit = { method: "" };
        return await this.recordResult(request, await this.mcp(request, audit), audit.method);
      }
      if (DEVICE_PATHS.has(new URL(request.url).pathname)) {
        return this.recordResult(request, await devicePairRoute(request, this.env, this.ctx.storage));
      }
      const response = await this.ctx.storage.transaction(tx => oauthRequest(request.clone(), this.env, new OAuthStorage(tx)));
      // Expiry is enforced on every read; the alarm also reclaims old records.
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600000);
      return secure(await this.recordResult(request, response));
    } catch (error) { return this.recordResult(request, errorResponse(error)); }
  }

  async alarm() {
    this.ctx.storage.sql.exec("DELETE FROM qwen_oauth_audit_v1 WHERE at_ms < ?", Date.now() - 7 * 86400000);
    const cursor = await this.ctx.storage.get("cleanup-cursor");
    const records = await this.ctx.storage.list({ limit: 256, ...(cursor ? { startAfter: cursor } : {}) });
    const expired = [...records.entries()].filter(([, r]) => r?.expiration && r.expiration <= Date.now() / 1000).map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
    if (records.size === 256) {
      await this.ctx.storage.put("cleanup-cursor", [...records.keys()].at(-1));
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    } else {
      await this.ctx.storage.delete("cleanup-cursor");
      await this.ctx.storage.setAlarm(Date.now() + 3600000);
    }
  }

  async mcp(request, audit = { method: "" }) {
    const auth = await this.ctx.storage.transaction(tx => verify(request, this.env, new OAuthStorage(tx)));
    if (!auth) return challenge();
    if (new URL(request.url).searchParams.size || !["GET", "POST", "DELETE"].includes(request.method)) return json(400, { error: "invalid_request" });
    const origin = request.headers.get("origin");
    if (origin && ![ISSUER, "https://chatgpt.com", "https://chat.openai.com"].includes(origin)) return json(403, { error: "invalid_origin" });
    const kv = new OAuthStorage(this.ctx.storage);
    const incomingSession = request.headers.get("mcp-session-id");
    if (request.headers.has("last-event-id") && !incomingSession) return json(403, { error: "invalid_session" });
    if (incomingSession) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(incomingSession)) return json(400, { error: "invalid_session" });
      if (await kv.get(`session:${incomingSession}`) !== auth.sessionOwner) return json(403, { error: "invalid_session" });
    }
    let body, message;
    if (request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) return json(415, { error: "invalid_content_type" });
      body = await readBody(request);
      try { message = JSON.parse(body); } catch { return json(400, { error: "invalid_request" }); }
      if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return json(400, { error: "invalid_request" });
      audit.method = message.method.length <= 80 && /^[a-z][a-z0-9_.-]*(?:\/[a-z][a-z0-9_.-]*)*$/.test(message.method)
        ? message.method : "nonstandard";
      // The 2026-07-28 MCP transport carries the RPC method and (for tool
      // calls) tool name in headers. Never forward conflicting routing hints.
      const methodHeader = request.headers.get("mcp-method");
      if (methodHeader && methodHeader !== message.method) return json(400, { error: "mcp_header_mismatch" });
      const toolHeader = request.headers.get("mcp-name");
      if (toolHeader && (message.method !== "tools/call" || toolHeader !== message.params?.name))
        return json(400, { error: "mcp_header_mismatch" });
      if (message.method === "tools/call") {
        if (!message.params || Array.isArray(message.params) || typeof message.params.name !== "string") return json(400, { error: "invalid_request" });
        const scope = Object.hasOwn(TOOL_SCOPES, message.params?.name) ? TOOL_SCOPES[message.params.name] : null;
        if (!scope || !auth.scope.includes(scope)) return challenge("insufficient_scope", 403);
        if (message.params.name === "pc_maintenance_apply") {
          const args = message.params.arguments;
          if (!args || typeof args !== "object" || Array.isArray(args) ||
              Object.keys(args).sort().join() !== "confirmation,plan_id" ||
              typeof args.plan_id !== "string" || !/^[a-f0-9]{32}$/.test(args.plan_id) ||
              args.confirmation !== `CONFIRM KTK MAINTENANCE ${args.plan_id}`)
            return json(400, { error: "invalid_maintenance_request" });
        }
        if (message.params.name === "pc_maintenance_preview") {
          const args = message.params.arguments;
          if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).join() !== "action" ||
              !["start_ktk_tunnel", "rollback_ktk_tunnel", "enable_ktk_tunnel_autostart", "rollback_ktk_tunnel_autostart"].includes(args.action))
            return json(400, { error: "invalid_maintenance_request" });
        }
        if (message.params.name === "update_apply") {
          const args = message.params.arguments;
          if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).join() !== "version") return json(400, { error: "invalid_update_request" });
          const approved = approvedRelease(this.env, args.version);
          if (!approved) return json(409, { error: "release_not_approved" });
          message.params.arguments = approved;
          body = JSON.stringify(message);
        }
      } else if (!["initialize", "server/discover", "notifications/initialized", "notifications/cancelled", "ping", "tools/list"].includes(message.method)) return json(403, { error: "method_not_allowed" });
    }
    const deviceFailure = await attestDevice(this.env.QWEN_MCP_ORIGIN, this.ctx.storage, this.env.QWEN_MCP_GATEWAY_KEY);
    if (deviceFailure) return deviceFailure;
    // Fixed destination and header allowlist. Never send caller credentials or claims.
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id"]) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    // Avoid fetch() silently inserting an unsigned Accept: */* header.
    if (!headers.has("accept")) headers.set("accept", "*/*");
    const signed = await signedOriginHeaders(this.env.QWEN_MCP_GATEWAY_KEY, request.method, "/mcp", body ?? "", headers);
    if (!signed) return json(503, { error: "origin_auth_not_configured" });
    for (const [name, value] of Object.entries(signed)) headers.set(name, value);
    let upstream;
    try {
      upstream = await this.env.QWEN_MCP_ORIGIN.fetch(new Request("http://127.0.0.1:8765/mcp", {
        method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30000),
      }));
    } catch { return json(503, { error: "origin_unavailable" }); }
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return json(502, { error: "invalid_origin_response" }); }
    if (!upstream.ok) { await upstream.body?.cancel(); return json(upstream.status >= 500 ? 503 : 502, { error: "origin_unavailable" }); }
    const outgoingSession = upstream.headers.get("mcp-session-id");
    if (outgoingSession) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(outgoingSession)) { await upstream.body?.cancel(); return json(502, { error: "invalid_origin_response" }); }
      const accepted = await this.ctx.storage.transaction(async tx => {
        const sessions = new OAuthStorage(tx);
        const owner = await sessions.get(`session:${outgoingSession}`);
        if (owner && owner !== auth.sessionOwner) return false;
        await sessions.put(`session:${outgoingSession}`, auth.sessionOwner, { expirationTtl: 86400 });
        return true;
      });
      if (!accepted) { await upstream.body?.cancel(); return json(502, { error: "invalid_origin_response" }); }
    }
    if (request.method === "DELETE" && upstream.ok && incomingSession) await kv.delete(`session:${incomingSession}`);
    const responseHeaders = new Headers();
    for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"]) {
      if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name));
    }
    if (message?.method === "tools/list" && upstream.ok) {
      try {
        const text = await readBody(upstream, 1048576);
        let result;
        if (upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
          const messages = text.replace(/\r\n/g, "\n").split("\n\n").map(event => event.split("\n")
            .filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"))
            .filter(Boolean).map(data => JSON.parse(data)).filter(data => data.id === message.id);
          if (messages.length !== 1) throw Error("Invalid tools response");
          result = messages[0];
        } else result = JSON.parse(text);
        if (!Array.isArray(result.result?.tools)) throw Error("Invalid tools response");
        result.result.tools = result.result.tools.filter(tool => Object.hasOwn(TOOL_SCOPES, tool.name) && auth.scope.includes(TOOL_SCOPES[tool.name]));
        responseHeaders.set("content-type", "application/json; charset=utf-8");
        return json(upstream.status, result, Object.fromEntries(responseHeaders));
      } catch { return json(502, { error: "invalid_origin_response" }); }
    }
    return secure(new Response(upstream.body, { status: upstream.status, headers: responseHeaders }));
  }
}
