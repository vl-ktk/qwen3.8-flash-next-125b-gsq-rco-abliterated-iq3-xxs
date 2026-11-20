import { link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDeviceBootstrapSession, openBootstrapEnvelope } from "./device-bootstrap.mjs";

const ISSUER = "https://qwen125b-mcp.vl-ktk.workers.dev";
const ID = /^[A-Za-z0-9_-]{32}$/;
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const FINGERPRINT = /^[A-F0-9]{16}$/;

async function jsonPost(fetcher, url, data) {
  const response = await fetcher(url, {
    method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    body: JSON.stringify(data), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error(`bootstrap_http_${response.status}`);
  if (!response.headers.get("content-type")?.startsWith("application/json")) throw Error("bootstrap_invalid_response");
  // Bound an externally controlled response, even when Content-Length is absent.
  const reader = response.body?.getReader();
  if (!reader) throw Error("bootstrap_invalid_response");
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) throw Error("bootstrap_response_too_large");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = Buffer.concat(chunks);
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw Error("bootstrap_invalid_response"); }
}

export async function requestDeviceBootstrap(identity, { fetcher = fetch, label = "Windows MCP" } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(identity?.public_key ?? "") || typeof label !== "string" || label.length > 64 || !/^[\p{L}\p{N} ._-]+$/u.test(label)) throw Error("bootstrap_invalid_identity");
  const session = await createDeviceBootstrapSession();
  const reply = await jsonPost(fetcher, ISSUER + "/device/pair/start", {
    public_key: identity.public_key, bootstrap_public_key: session.public_key, label,
  });
  if (!ID.test(reply?.request_id ?? "") || !CODE.test(reply?.user_code ?? "") || !FINGERPRINT.test(reply?.fingerprint ?? "")
    || reply?.fingerprint !== identity.fingerprint || reply?.verification_uri !== ISSUER + "/device/pair/manage"
    || !Number.isInteger(reply?.expires_in) || reply.expires_in < 60 || reply.expires_in > 600) throw Error("bootstrap_invalid_response");
  return { session, request_id: reply.request_id, user_code: reply.user_code, fingerprint: reply.fingerprint, verification_uri: reply.verification_uri, expires_in: reply.expires_in };
}

// The short-lived public pairing code belongs in the URL *fragment*, which
// browsers do not send to the server or include in HTTP access logs. The
// installer opens this URL as the original (non-elevated) desktop user.
export function deviceApprovalUrl(started) {
  if (started?.verification_uri !== ISSUER + "/device/pair/manage"
    || !CODE.test(started.user_code ?? "") || !FINGERPRINT.test(started.fingerprint ?? "")) {
    throw Error("bootstrap_invalid_approval_url");
  }
  return `${started.verification_uri}#code=${started.user_code}&fingerprint=${started.fingerprint}`;
}

export async function waitForDeviceBootstrap(started, { fetcher = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 115 } = {}) {
  const count = Math.min(maxPolls, Math.max(0, Math.floor((started.expires_in - 10) / 5)));
  for (let attempt = 0; attempt < count; attempt++) {
    await delay(5000);
    const reply = await jsonPost(fetcher, ISSUER + "/device/pair/status", { request_id: started.request_id });
    if (reply?.state === "pending") continue;
    if (reply?.state !== "approved" || !ID.test(reply.device_id ?? "") || !reply.bootstrap) throw Error("bootstrap_invalid_response");
    return openBootstrapEnvelope(started.session, reply.bootstrap, { requestId: started.request_id, deviceId: reply.device_id });
  }
  throw Error("bootstrap_approval_timeout");
}

export async function saveDeviceBootstrap(destination, payload) {
  const { secretsDir, stateDir } = destination ?? {};
  if (!path.isAbsolute(secretsDir ?? "") || !path.isAbsolute(stateDir ?? "")) throw Error("bootstrap_invalid_paths");
  for (const folder of [secretsDir, stateDir]) {
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("bootstrap_directory_untrusted");
  }
  if (!ID.test(payload?.device_id ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(payload?.gateway_key ?? "") || !/^[A-Za-z0-9+/_=.-]{40,4096}$/.test(payload?.tunnel_token ?? "")) throw Error("bootstrap_invalid_credentials");
  const outputs = [
    [path.join(secretsDir, "gateway.key"), payload.gateway_key],
    [path.join(secretsDir, "tunnel.token"), payload.tunnel_token],
    [path.join(stateDir, "enrollment.json"), JSON.stringify({ schema: 1, device_id: payload.device_id }) + "\n"],
  ];
  const owned = [];
  try {
    // Exclusive creation refuses to replace any previous or concurrent install.
    for (const [file, content] of outputs) {
      const temporary = `${file}.new`;
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      owned.push(temporary);
    }
    for (const [file] of outputs) {
      try { await lstat(file); throw Error("bootstrap_existing_credentials"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    for (const [file] of outputs) {
      // Atomic exclusive hard link: unlike rename(), cannot overwrite a file
      // that was created by another actor after our existence check.
      await link(`${file}.new`, file);
      owned.push(file);
      await rm(`${file}.new`);
    }
  } catch (error) {
    for (const ownedFile of owned) await rm(ownedFile, { force: true }).catch(() => {});
    throw error;
  }
}

export async function enrollDeviceFromDisk({ identityPath, secretsDir, stateDir, fetcher = fetch, print = console.log, delay } = {}) {
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  const label = (process.env.COMPUTERNAME ?? "Windows MCP").slice(0, 64).replace(/[^\p{L}\p{N} ._-]/gu, "").trim() || "Windows MCP";
  const started = await requestDeviceBootstrap(identity, { fetcher, label });
  print(`APPROVAL URL: ${started.verification_uri}`);
  print(`ONE-TIME CODE: ${started.user_code}`);
  print(`DEVICE FINGERPRINT: ${started.fingerprint}`);
  // Machine-readable signal consumed by the one-file Inno Setup UI. Never
  // contains credentials, the private device identity or a bootstrap token.
  print(`KTK_APPROVAL_URL: ${deviceApprovalUrl(started)}`);
  const payload = await waitForDeviceBootstrap(started, { fetcher, ...(delay ? { delay } : {}) });
  await saveDeviceBootstrap({ secretsDir, stateDir }, payload);
  print("DEVICE PROVISIONED. Credentials stored locally under protected ACL.");
  return { device_id: payload.device_id };
}
