import { webcrypto, createHash } from "node:crypto";

const { subtle } = webcrypto;
const enc = new TextEncoder();
const to64 = bytes => Buffer.from(bytes).toString("base64url");

// Generate this identity ONLY on the Windows PC during installation, never in
// the published archive. Installer must protect the private PKCS#8 using ACLs.
export async function generateDeviceIdentity() {
  const pair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const public_key = to64(await subtle.exportKey("raw", pair.publicKey));
  return {
    public_key,
    fingerprint: createHash("sha256").update(public_key).digest("hex").slice(0, 16).toUpperCase(),
    private_pkcs8: to64(await subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

export async function signDeviceAttestation(identity, { issuer, device_id, nonce }) {
  if (issuer !== "https://qwen125b-mcp.vl-ktk.workers.dev" || !identity || typeof identity.private_pkcs8 !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(device_id ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(nonce ?? "")) {
    throw new Error("invalid_device_challenge");
  }
  const key = await subtle.importKey("pkcs8", Buffer.from(identity.private_pkcs8, "base64url"), "Ed25519", false, ["sign"]);
  const signed = enc.encode(`QWEN-MCP-DEVICE-V1\n${issuer}\n${device_id}\n${nonce}`);
  return { device_id, signature: to64(await subtle.sign("Ed25519", key, signed)) };
}
