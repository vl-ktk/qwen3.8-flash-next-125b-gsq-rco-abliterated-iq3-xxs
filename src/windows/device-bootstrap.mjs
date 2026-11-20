import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const to64 = bytes => Buffer.from(bytes).toString("base64url");
const valid64 = (value, size) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === size && to64(Buffer.from(value, "base64url")) === value;

// Private transport key is kept only in volatile memory during enrollment.
// It is never written to the distributable, logs, or public status response.
export async function createDeviceBootstrapSession() {
  const keys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { privateKey: keys.privateKey, public_key: to64(await subtle.exportKey("raw", keys.publicKey)) };
}

export async function openBootstrapEnvelope(session, envelope, { requestId, deviceId }) {
  if (!session?.privateKey || envelope?.version !== 1 || !valid64(envelope.ephemeral_public_key, 65)
      || !valid64(envelope.salt, 32) || !valid64(envelope.nonce, 12)
      || typeof envelope.ciphertext !== "string" || !/^[A-Za-z0-9_-]{50,8192}$/.test(envelope.ciphertext)
      || !/^[A-Za-z0-9_-]{32}$/.test(requestId ?? "") || !/^[A-Za-z0-9_-]{32}$/.test(deviceId ?? "")) throw Error("invalid_bootstrap_envelope");
  try {
    const peer = await subtle.importKey("raw", Buffer.from(envelope.ephemeral_public_key, "base64url"), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = await subtle.deriveBits({ name: "ECDH", public: peer }, session.privateKey, 256);
    const shared = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    const context = new TextEncoder().encode(`KTK-QWEN-BOOTSTRAP-V1\n${requestId}\n${deviceId}`);
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: Buffer.from(envelope.salt, "base64url"), info: context }, shared, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const clear = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.nonce, "base64url"), additionalData: context }, key, Buffer.from(envelope.ciphertext, "base64url"));
    const data = JSON.parse(new TextDecoder().decode(clear));
    const token = data?.tunnel_token;
    if (data?.schema !== 1 || data.device_id !== deviceId || !valid64(data.gateway_key, 32)
      || typeof token !== "string" || !/^[A-Za-z0-9+/_=.-]{40,4096}$/.test(token)) throw Error("invalid_bootstrap_payload");
    return { device_id: data.device_id, gateway_key: data.gateway_key, tunnel_token: token };
  } catch { throw Error("bootstrap_decryption_failed"); }
}
