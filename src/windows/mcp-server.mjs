import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { signDeviceAttestation } from "./device-identity.mjs";
import { createWindowsToolRegistry } from "./windows-tools.mjs";
import { createOriginVerifier } from "./origin-auth.mjs";

// This is the loopback transport, not a remotely exposed HTTP service. The
// Cloudflare gateway enforces OAuth + scopes and a fresh signed device proof.
// Only read-only, parameter-validated Windows tools are registered in step 11.
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const SUPPORTED = [MODERN, LEGACY];
const SERVER_INFO = Object.freeze({ name: "qwen125b-windows-mcp", version: "0.15.1" });
const INSTRUCTIONS = "Read-only system tools and a narrowly scoped KTK-only updater. No arbitrary PowerShell, file writes, unrelated process controls or OS reboot. Update packages require a gateway-approved release catalog and checksum.";
const MAX_BODY = 64 * 1024;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 256;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const ATTEST_NONCE = /^[A-Za-z0-9_-]{43}$/;

const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

function send(res, code, data, extra = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(code, { ...headers, ...(data === null ? {} : { "content-type": "application/json; charset=utf-8" }), ...extra });
  res.end(data === null ? undefined : JSON.stringify(data));
}

function metaResult(result) {
  return { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } };
}

function headerValue(raw) {
  if (!raw?.startsWith("=?base64?")) return raw;
  if (!/^=\?base64\?[A-Za-z0-9+/]+={0,2}\?=$/.test(raw)) return null;
  try {
    const b64 = raw.slice(9, -2);
    const value = Buffer.from(b64, "base64");
    if (value.toString("base64") !== b64) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch { return null; }
}

async function readRawBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY) throw Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requireMeta(body, req) {
  const metadata = body.params?._meta;
  if (!record(metadata)) return false;
  if (metadata["io.modelcontextprotocol/protocolVersion"] !== MODERN || req.headers["mcp-protocol-version"] !== MODERN) return false;
  const capabilities = metadata["io.modelcontextprotocol/clientCapabilities"];
  if (!record(capabilities)) return false;
  const client = metadata["io.modelcontextprotocol/clientInfo"];
  return client === undefined || (record(client) && typeof client.name === "string" && typeof client.version === "string");
}

export function createWindowsMcpServer({
  port = 8765, host = "127.0.0.1", identity = null, deviceId = null,
  toolRegistry = createWindowsToolRegistry(), gatewayKey,
  // Injection for isolated transport tests. Runtime always requires gatewayKey.
  originVerifier = gatewayKey ? createOriginVerifier(gatewayKey) : () => false,
  emergencyLocked = async () => false,
  auditEvent = () => {},
} = {}) {
  // Do not let configuration expose this origin on a LAN. Tunnel connects to loopback.
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65535) throw Error("invalid_bind_address");
  const sessions = new Map();
  const streams = new Map();
  const audit = event => { try { auditEvent({ at: new Date().toISOString(), event }); } catch { /* auditing cannot disclose details */ } };

  const session = id => {
    if (!id || !SESSION_PATTERN.test(id)) return null;
    const value = sessions.get(id);
    if (!value) return null;
    if (value.expiresAt <= Date.now()) { sessions.delete(id); return null; }
    value.expiresAt = Date.now() + SESSION_TTL;
    return value;
  };
  const dropSession = id => {
    sessions.delete(id);
    for (const res of streams.get(id) ?? []) if (!res.destroyed) res.end();
    streams.delete(id);
  };

  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const actualPort = typeof address === "object" ? address.port : port;
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!allowedHosts.has(req.headers.host) || req.headers.origin) return send(res, 403, { error: "forbidden_origin" });
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.search || url.hash) return send(res, 400, { error: "invalid_request" });

      // Emergency lock is checked per-request: revocation takes effect without
      // a service restart and fail-closes if the lock state cannot be read.
      let locked;
      try { locked = await emergencyLocked(); } catch { locked = true; }
      if (locked) { audit("emergency_locked"); return send(res, 503, { error: "emergency_locked" }); }

      if ((url.pathname === "/healthz" || url.pathname === "/health") && req.method === "GET") {
        return send(res, 200, { status: "ready", transport: "streamable-http", model: "not_checked", version: SERVER_INFO.version });
      }
      if (url.pathname !== "/device/attest" && url.pathname !== "/mcp") return send(res, 404, { error: "not_found" });
      let rawBody;
      try { rawBody = await readRawBody(req); }
      catch (error) { return send(res, error.message === "body_too_large" ? 413 : 400, { error: "invalid_request" }); }
      if (!originVerifier(req.headers, req.method, url.pathname, rawBody)) { audit("origin_auth_denied"); return send(res, 403, { error: "origin_auth_denied" }); }
      if (url.pathname === "/device/attest" && req.method === "GET") {
        const id = req.headers["x-qwen-device-id"];
        const nonce = req.headers["x-qwen-device-nonce"];
        if (!identity || !deviceId || !SESSION_PATTERN.test(deviceId) || id !== deviceId || !ATTEST_NONCE.test(nonce ?? "")) {
          return send(res, 403, { error: "unpaired_device" });
        }
        const proof = await signDeviceAttestation(identity, { issuer: "https://qwen125b-mcp.vl-ktk.workers.dev", device_id: id, nonce });
        return send(res, 200, proof);
      }
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not_found" });

      const modern = req.headers["mcp-protocol-version"] === MODERN;
      if (req.method === "GET" || req.method === "DELETE") {
        if (modern) return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
        const id = req.headers["mcp-session-id"];
        if (!session(id)) return send(res, 404, rpcError(null, -32001, "Session not found"));
        if (req.method === "DELETE") { dropSession(id); return send(res, 204, null); }
        if (!req.headers.accept?.includes("text/event-stream") || req.headers["last-event-id"]) {
          return send(res, 400, rpcError(null, -32600, "Invalid stream request"));
        }
        res.writeHead(200, { ...headers, "content-type": "text/event-stream", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(": connected\n\n");
        if (!streams.has(id)) streams.set(id, new Set());
        streams.get(id).add(res);
        const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": keep-alive\n\n"); }, 15000);
        res.once("close", () => { clearInterval(heartbeat); streams.get(id)?.delete(res); });
        return;
      }
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "GET, POST, DELETE" });
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "unsupported_media_type" });
      if (!req.headers.accept?.includes("application/json") || !req.headers.accept?.includes("text/event-stream")) {
        return send(res, 406, { error: "not_acceptable" });
      }
      let body;
      try { body = JSON.parse(rawBody.toString("utf8")); }
      catch (error) { return send(res, error.message === "body_too_large" ? 413 : 400, rpcError(null, -32700, "Invalid JSON request")); }
      if (!record(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || body.method.length > 128 || (own(body, "id") && !(typeof body.id === "string" || (typeof body.id === "number" && Number.isSafeInteger(body.id))))) {
        return send(res, 400, rpcError(null, -32600, "Invalid request"));
      }
      const id = own(body, "id") ? body.id : null;
      const version = req.headers["mcp-protocol-version"];
      const declared = body.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
      if (modern || declared !== undefined) {
        if (version !== declared || !req.headers["mcp-method"] || req.headers["mcp-method"] !== body.method) {
          return send(res, 400, rpcError(id, -32020, "Header mismatch"));
        }
        if (version !== MODERN) return send(res, 400, rpcError(id, -32022, "Unsupported protocol version", { requested: version, supported: SUPPORTED }));
        if (!requireMeta(body, req)) return send(res, 400, rpcError(id, -32602, "Invalid request metadata"));
        if (body.method === "tools/call" && (!req.headers["mcp-name"] || headerValue(req.headers["mcp-name"]) !== body.params?.name)) {
          return send(res, 400, rpcError(id, -32020, "Header mismatch"));
        }
        if (body.method !== "tools/call" && req.headers["mcp-name"]) return send(res, 400, rpcError(id, -32020, "Header mismatch"));
      } else {
        if (version && version !== LEGACY) return send(res, 400, rpcError(id, -32022, "Unsupported protocol version", { requested: version, supported: SUPPORTED }));
        if (req.headers["mcp-method"] && req.headers["mcp-method"] !== body.method) return send(res, 400, rpcError(id, -32600, "Method header mismatch"));
        if (body.method === "tools/call" && req.headers["mcp-name"] && headerValue(req.headers["mcp-name"]) !== body.params?.name) {
          return send(res, 400, rpcError(id, -32600, "Tool header mismatch"));
        }
        if (body.method !== "initialize" && !session(req.headers["mcp-session-id"])) {
          return send(res, 404, rpcError(id, -32001, "Session not found"));
        }
      }

      if (id === null) {
        if (!modern && ["notifications/initialized", "notifications/cancelled"].includes(body.method)) return send(res, 202, null);
        return send(res, 400, rpcError(null, -32600, "Unsupported notification"));
      }
      if (body.method === "initialize" && !modern) {
        if (!record(body.params) || !record(body.params.capabilities) || !record(body.params.clientInfo) || typeof body.params.clientInfo.name !== "string") {
          return send(res, 400, rpcError(id, -32602, "Invalid initialize parameters"));
        }
        if (sessions.size >= MAX_SESSIONS) {
          for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) dropSession(key);
          if (sessions.size >= MAX_SESSIONS) return send(res, 503, rpcError(id, -32000, "Session capacity reached"));
        }
        const sid = randomBytes(24).toString("base64url");
        sessions.set(sid, { expiresAt: Date.now() + SESSION_TTL });
        return send(res, 200, rpcResult(id, { protocolVersion: LEGACY, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }), { "mcp-session-id": sid, "mcp-protocol-version": LEGACY });
      }
      if (body.method === "server/discover" && modern) {
        return send(res, 200, rpcResult(id, metaResult({ supportedVersions: SUPPORTED, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, cacheScope: "private", ttlMs: 0 })));
      }
      if (body.method === "ping" && !modern) return send(res, 200, rpcResult(id, {}));
      if (body.method === "tools/list") {
        if (body.params?.cursor) return send(res, 400, rpcError(id, -32602, "Invalid cursor"));
        const result = { tools: toolRegistry.list() };
        return send(res, 200, rpcResult(id, modern ? metaResult({ ...result, cacheScope: "private", ttlMs: 0 }) : result));
      }
      if (body.method === "tools/call") {
        if (!record(body.params) || typeof body.params.name !== "string" || !record(body.params.arguments ?? {})) {
          return send(res, 400, rpcError(id, -32602, "Invalid tool parameters"));
        }
        if (!toolRegistry.has(body.params.name)) { audit("tool_denied"); return send(res, 400, rpcError(id, -32602, "Unknown or disabled tool")); }
        try {
          const output = await toolRegistry.call(body.params.name, body.params.arguments ?? {});
          audit("tool_executed");
          const result = { content: [{ type: "text", text: JSON.stringify(output) }], isError: false };
          return send(res, 200, rpcResult(id, modern ? metaResult(result) : result));
        } catch (error) {
          audit("tool_failed");
          if (error?.code === "invalid_arguments") return send(res, 400, rpcError(id, -32602, "Invalid tool arguments"));
          // Never send child-process stderr, file contents or stack traces.
          const result = { content: [{ type: "text", text: "Tool execution unavailable or denied" }], isError: true };
          return send(res, 200, rpcResult(id, modern ? metaResult(result) : result));
        }
      }
      return send(res, modern ? 404 : 400, rpcError(id, -32601, "Method not found"));
    } catch {
      return send(res, 500, { error: "internal_error" });
    }
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  // Stop long-lived legacy event streams before draining the HTTP server.
  server.endMcpStreams = () => {
    for (const id of [...streams.keys()]) {
      for (const res of streams.get(id)) if (!res.destroyed && !res.writableEnded) res.end();
      streams.delete(id);
    }
  };
  server.on("close", () => {
    for (const id of [...sessions.keys()]) dropSession(id);
  });
  return server;
}

export async function listenWindowsMcp(options = {}) {
  const server = createWindowsMcpServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8765, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}
