// Per-request proof that a VPC-origin call came from our authorized Worker.
// This does NOT replace user OAuth, scope checks, or the device Ed25519 proof.
const encoder = new TextEncoder();
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const toBase64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const fromBase64url = text => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));

export async function signedOriginHeaders(keyText, method, path, body = "") {
  if (typeof keyText !== "string" || !keyPattern.test(keyText)) return null;
  const secret = fromBase64url(keyText);
  if (secret.length !== 32 || toBase64url(secret) !== keyText) return null;
  if (!["GET", "POST", "DELETE"].includes(method) || !["/mcp", "/device/attest"].includes(path)) return null;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  const hash = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const payload = `QWEN-ORIGIN-V1\n${timestamp}\n${nonce}\n${method}\n${path}\n${hash}`;
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = toBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
  return { "x-qwen-origin-timestamp": timestamp, "x-qwen-origin-nonce": nonce, "x-qwen-origin-signature": signature };
}
