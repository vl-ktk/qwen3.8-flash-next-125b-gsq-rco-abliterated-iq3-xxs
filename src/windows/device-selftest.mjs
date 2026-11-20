import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto";
import { decodeGatewayKey } from "./origin-auth.mjs";

const ISSUER = "https://qwen125b-mcp.vl-ktk.workers.dev";
const NAMES = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id", "x-qwen-device-id", "x-qwen-device-nonce"];

export async function selfTestWindowsOrigin({ identity, deviceId, gatewayKey, fetcher = fetch, baseUrl = "http://127.0.0.1:8765" }) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(deviceId ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(identity?.public_key ?? "") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw Error("selftest_invalid_input");
  const key = decodeGatewayKey(gatewayKey);
  const timeout = AbortSignal.timeout(4000);
  const health = await fetcher(`${baseUrl}/healthz`, { redirect: "error", signal: timeout });
  if (!health.ok || (await health.json())?.status !== "ready") throw Error("selftest_health_failed");
  const nonce = randomBytes(32).toString("base64url");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const authNonce = randomBytes(16).toString("base64url");
  const headers = new Headers({ accept: "application/json", "x-qwen-device-id": deviceId, "x-qwen-device-nonce": nonce });
  const binding = NAMES.map(name => `${name}:${headers.get(name) ?? ""}`).join("\n");
  const message = `QWEN-ORIGIN-V1\n${timestamp}\n${authNonce}\nGET\n/device/attest\n${createHash("sha256").update("").digest("hex")}\n${binding}`;
  headers.set("x-qwen-origin-timestamp", timestamp);
  headers.set("x-qwen-origin-nonce", authNonce);
  headers.set("x-qwen-origin-signature", createHmac("sha256", key).update(message).digest("base64url"));
  const response = await fetcher(`${baseUrl}/device/attest`, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(4000) });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) throw Error("selftest_attestation_failed");
  const data = await response.json();
  if (data?.device_id !== deviceId || !/^[A-Za-z0-9_-]{86}$/.test(data.signature ?? "")) throw Error("selftest_attestation_failed");
  const publicKey = await webcrypto.subtle.importKey("raw", Buffer.from(identity.public_key, "base64url"), "Ed25519", false, ["verify"]);
  const challenge = new TextEncoder().encode(`QWEN-MCP-DEVICE-V1\n${ISSUER}\n${deviceId}\n${nonce}`);
  if (!await webcrypto.subtle.verify("Ed25519", publicKey, Buffer.from(data.signature, "base64url"), challenge)) throw Error("selftest_signature_failed");
  return { health: "ready", attestation: "valid" };
}
