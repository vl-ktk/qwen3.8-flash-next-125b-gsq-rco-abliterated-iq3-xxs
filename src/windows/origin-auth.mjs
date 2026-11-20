import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const TIMESTAMP = /^\d{10}$/;
const MAX_SKEW_SECONDS = 45;
const MAX_USED_NONCES = 2048;
const protectedHeaders = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id", "x-qwen-device-id", "x-qwen-device-nonce"];

export function decodeGatewayKey(value) {
  if (typeof value !== "string" || !SECRET.test(value)) throw Error("invalid_gateway_key");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw Error("invalid_gateway_key");
  return bytes;
}

// Use one verifier per listening server, so a nonce cannot be reused across
// device attestation and MCP calls. Never record a credential or request body.
export function createOriginVerifier(keyText, { clock = Date.now } = {}) {
  const key = decodeGatewayKey(keyText);
  const used = new Map();
  return (headers, method, path, rawBody) => {
    const timestamp = headers["x-qwen-origin-timestamp"];
    const nonce = headers["x-qwen-origin-nonce"];
    const signature = headers["x-qwen-origin-signature"];
    if (typeof timestamp !== "string" || !TIMESTAMP.test(timestamp) || typeof nonce !== "string" || !NONCE.test(nonce) || typeof signature !== "string" || !SIGNATURE.test(signature)) return false;
    const seconds = Number(timestamp);
    const now = Math.floor(clock() / 1000);
    if (Math.abs(seconds - now) > MAX_SKEW_SECONDS) return false;
    for (const [value, expiresAt] of used) if (expiresAt < now) used.delete(value);
    if (used.has(nonce) || used.size >= MAX_USED_NONCES) return false;
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const binding = protectedHeaders.map(name => `${name}:${headers[name] ?? ""}`).join("\n");
    const payload = `QWEN-ORIGIN-V1\n${timestamp}\n${nonce}\n${method}\n${path}\n${bodyHash}\n${binding}`;
    const expected = createHmac("sha256", key).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || received.toString("base64url") !== signature || !timingSafeEqual(expected, received)) return false;
    used.set(nonce, now + MAX_SKEW_SECONDS * 2);
    return true;
  };
}
