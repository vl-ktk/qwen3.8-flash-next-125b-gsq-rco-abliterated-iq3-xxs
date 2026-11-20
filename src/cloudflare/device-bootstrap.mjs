// Owner-approved, short-lived provisioning envelope. Never return a cloud
// tunnel token or shared gateway key in plaintext to a public HTTP caller.
const encoder = new TextEncoder();
const to64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const from64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
const valid64 = (value, size) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try { const bytes = from64(value); return bytes.length === size && to64(bytes) === value; }
  catch { return false; }
};

export async function validateTransportPublicKey(value) {
  if (!valid64(value, 65)) return false;
  try { await crypto.subtle.importKey("raw", from64(value), { name: "ECDH", namedCurve: "P-256" }, false, []); return true; }
  catch { return false; }
}

export function bootstrapSecretsReady(env) {
  if (!valid64(env?.QWEN_MCP_GATEWAY_KEY, 32)) return false;
  const token = env?.QWEN_TUNNEL_TOKEN;
  return typeof token === "string" && /^[A-Za-z0-9+/_=.-]{40,4096}$/.test(token);
}

export async function sealBootstrapEnvelope(env, { publicKey, requestId, deviceId }) {
  if (!bootstrapSecretsReady(env) || !await validateTransportPublicKey(publicKey)) throw Error("bootstrap_not_configured");
  if (!/^[A-Za-z0-9_-]{32}$/.test(requestId ?? "") || !/^[A-Za-z0-9_-]{32}$/.test(deviceId ?? "")) throw Error("invalid_bootstrap_context");
  const peer = await crypto.subtle.importKey("raw", from64(publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, ephemeral.privateKey, 256);
  const raw = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const context = encoder.encode(`KTK-QWEN-BOOTSTRAP-V1\n${requestId}\n${deviceId}`);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: context }, raw, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const content = encoder.encode(JSON.stringify({
    schema: 1, device_id: deviceId, gateway_key: env.QWEN_MCP_GATEWAY_KEY, tunnel_token: env.QWEN_TUNNEL_TOKEN,
  }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: context }, key, content);
  return {
    version: 1, ephemeral_public_key: to64(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
    salt: to64(salt), nonce: to64(nonce), ciphertext: to64(new Uint8Array(encrypted)),
  };
}
