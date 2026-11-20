import { randomBytes, webcrypto } from "node:crypto";

const ISSUER = "https://qwen125b-mcp.vl-ktk.workers.dev";
const ID = /^[A-Za-z0-9_-]{32}$/;

export async function signedDeviceRevoke(identity, deviceId, { clock = Date.now } = {}) {
  if (!ID.test(deviceId ?? "") || typeof identity?.private_pkcs8 !== "string") throw Error("invalid_revoke_identity");
  const key = await webcrypto.subtle.importKey("pkcs8", Buffer.from(identity.private_pkcs8, "base64url"), "Ed25519", false, ["sign"]);
  const nonce = randomBytes(16).toString("base64url");
  const timestamp = String(Math.floor(clock() / 1000));
  const message = new TextEncoder().encode(`QWEN-MCP-REVOKE-V1\n${ISSUER}\n${deviceId}\n${nonce}\n${timestamp}`);
  const signature = Buffer.from(await webcrypto.subtle.sign("Ed25519", key, message)).toString("base64url");
  return { device_id: deviceId, nonce, timestamp, signature };
}

export async function revokeDevice(identity, deviceId, { fetcher = fetch } = {}) {
  const proof = await signedDeviceRevoke(identity, deviceId);
  const response = await fetcher(ISSUER + "/device/pair/revoke", {
    method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    body: JSON.stringify(proof), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error(`device_revoke_http_${response.status}`);
  if (!response.headers.get("content-type")?.startsWith("application/json")) throw Error("device_revoke_invalid_response");
  if ((await response.json())?.state !== "revoked") throw Error("device_revoke_invalid_response");
  return true;
}
