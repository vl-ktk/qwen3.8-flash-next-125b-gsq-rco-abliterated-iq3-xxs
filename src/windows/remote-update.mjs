import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createOriginVerifier, decodeGatewayKey } from "./origin-auth.mjs";

const exec = promisify(execFile);
const VERSION = /^0\.18\.[1-9]\d{0,3}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BUNDLE = 160 * 1024 * 1024;
const MAX_REQUEST = 4096;
const MAX_URL_LENGTH = 2048;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// PowerShell's fixed SYSTEM entrypoint emits only allowlisted diagnostic
// identifiers. Never return its raw stdout/stderr to the MCP caller.
export function classifyUpdateFailure(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const marker = stderr.match(/^KTK_UPDATE_FAILURE:([a-z][a-z_]{2,32}):([a-z][a-z0-9_]{2,63})\r?$/m);
  const context = stderr.match(/^KTK_UPDATE_CONTEXT:(remote|unified|maintain|verify|unknown):([0-9]{1,4}):([a-z]{3,40})\r?$/m);
  const recovered = /^KTK_RECOVERY_OK\r?$/m.test(stdout) ? "healthy" :
    /^KTK_RECOVERY_LOCKED:[a-z][a-z0-9_]{2,63}\r?$/m.test(stdout) ? "locked" : "unknown";
  const code = marker ? `${marker[1]}_${marker[2]}` :
    error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT" ? "maintenance_timeout" :
    error?.code === "ENOENT" ? "powershell_unavailable" : "maintenance_failed";
  return { code, recovery: recovered,
    ...(marker && context ? { diagnostic: { script: context[1], line: Number(context[2]), type: context[3] } } : {}),
  };
}

// Never accept a command, executable path, target directory, or arbitrary host
// from an MCP caller. The Worker substitutes this envelope from its own
// protected release catalog, after OAuth scope and device-attestation checks.
export function validateUpdateOffer(offer, { maxUrlLength = MAX_URL_LENGTH } = {}) {
  if (!offer || typeof offer !== "object" || Array.isArray(offer) ||
      Object.keys(offer).sort().join() !== "sha256,url,version" ||
      typeof offer.version !== "string" || !VERSION.test(offer.version) ||
      typeof offer.sha256 !== "string" || !DIGEST.test(offer.sha256) ||
      typeof offer.url !== "string" || offer.url.length > maxUrlLength) fail("invalid_update_offer");
  let url;
  try { url = new URL(offer.url); } catch { fail("invalid_update_offer"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      !["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname) &&
      !url.hostname.endsWith(".blob.core.windows.net") &&
      !url.hostname.endsWith(".oaiusercontent.com")) fail("update_source_denied");
  return { version: offer.version, sha256: offer.sha256, url: url.toString() };
}

export function signUpdateRequest(keyText, method, route, body = "", now = Date.now()) {
  const key = decodeGatewayKey(keyText);
  const timestamp = String(Math.floor(now / 1000));
  const nonce = randomBytes(16).toString("base64url");
  const headers = { accept: "application/json", "content-type": "application/json" };
  const binding = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id", "x-qwen-device-id", "x-qwen-device-nonce"]
    .map(name => `${name}:${headers[name] ?? ""}`).join("\n");
  const hash = createHash("sha256").update(body).digest("hex");
  const payload = `QWEN-ORIGIN-V1\n${timestamp}\n${nonce}\n${method}\n${route}\n${hash}\n${binding}`;
  return { ...headers, "x-qwen-origin-timestamp": timestamp, "x-qwen-origin-nonce": nonce,
    "x-qwen-origin-signature": createHmac("sha256", key).update(payload).digest("base64url") };
}

export async function callLocalUpdater(action, offer, { keyText, fetcher = fetch, port = 18765 } = {}) {
  if (!["update", "status", "resume"].includes(action)) fail("unknown_update_action");
  if (typeof keyText !== "string") fail("updater_not_configured");
  const route = action === "update" ? "/v1/update" : action === "resume" ? "/v1/resume" : "/v1/status";
  const body = action === "update" ? JSON.stringify(validateUpdateOffer(offer)) : "";
  const method = action === "status" ? "GET" : "POST";
  const response = await fetcher(`http://127.0.0.1:${port}${route}`, {
    method, redirect: "error", body: body || undefined,
    headers: signUpdateRequest(keyText, method, route, body), signal: AbortSignal.timeout(4500),
  }).catch(() => fail("updater_unavailable"));
  if (!response.ok) fail("updater_unavailable");
  return response.json().catch(() => fail("updater_unavailable"));
}

export async function downloadVerifiedRelease(offer, outputPath, { fetcher = fetch, maxBytes = MAX_BUNDLE } = {}) {
  validateUpdateOffer(offer);
  let url = offer.url;
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(180000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) fail("update_too_many_redirects");
      const next = new URL(response.headers.get("location") ?? "", url);
      // GitHub's signed binary CDN redirects can be much longer than the
      // short, owner-approved URL stored in the Cloudflare release catalog.
      validateUpdateOffer({ ...offer, url: next.toString() }, { maxUrlLength: 8192 });
      await response.body?.cancel();
      url = next.toString();
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) fail("update_download_unavailable");
  const size = Number(response.headers.get("content-length"));
  if (size > maxBytes) fail("update_too_large");
  const handle = await open(outputPath, "wx", 0o600);
  const digest = createHash("sha256");
  let written = 0;
  try {
    for await (const chunk of response.body) {
      written += chunk.length;
      if (written > maxBytes) fail("update_too_large");
      digest.update(chunk);
      await handle.writeFile(chunk);
    }
  } finally { await handle.close(); }
  if (!written || digest.digest("hex") !== offer.sha256) fail("update_checksum_mismatch");
  return written;
}

// Runs ONLY a packaged, fixed PowerShell maintenance entrypoint. Its SYSTEM
// caller is verified again by the script; no shell, user-chosen arguments or
// user-chosen executable path enter this boundary.
export function createMaintenanceEnvironment(source = process.env) {
  const systemRoot = source.SystemRoot ?? "C:\\Windows";
  return {
    SystemRoot: systemRoot,
    ProgramFiles: source.ProgramFiles ?? "C:\\Program Files",
    ProgramData: source.ProgramData ?? "C:\\ProgramData",
    // execFile replaces the entire child environment. Without a fixed PATH,
    // PowerShell cannot resolve sc.exe, icacls.exe or schtasks.exe; the 0.18.15
    // live failure occurred at the first sc.exe invocation.
    Path: [path.win32.join(systemRoot, "System32"), systemRoot].join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
}

export async function applyVerifiedRelease(offer, { updaterRoot, dataRoot, download = downloadVerifiedRelease, invoke = exec } = {}) {
  validateUpdateOffer(offer);
  const temp = await mkdtemp(path.join(dataRoot, "update-"));
  const bundle = path.join(temp, "artifact.zip");
  try {
    try { await download(offer, bundle); }
    catch (error) {
      if (typeof error?.code === "string" && /^update_[a-z_]+$/.test(error.code)) throw error;
      fail("update_download_failed");
    }
    const childEnv = createMaintenanceEnvironment();
    const native = path.win32.join(childEnv.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    let result;
    try {
      result = await invoke(native, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        path.join(updaterRoot, "Run-KTKRemoteUpdate.ps1"), "-ArtifactPath", bundle, "-Version", offer.version], {
        shell: false, windowsHide: true, timeout: 300000, maxBuffer: 16384,
        env: childEnv,
      });
    } catch (error) {
      const diagnosis = classifyUpdateFailure(error);
      throw Object.assign(new Error(diagnosis.code), diagnosis);
    }
    const output = result?.stdout;
    const aiQueued = typeof output === "string" && output.includes("KTK_USER_UPDATE_QUEUED");
    const mcpOnly = typeof output === "string" && output.includes("KTK_MCP_UPDATE_ONLY");
    if (aiQueued === mcpOnly) fail("update_completion_unconfirmed");
    return { status: aiQueued ? "user_pending" : "updated", version: offer.version };
  } finally {
    // Only this invocation's newly-created private staging folder is removed.
    // Cleanup failure must not hide the primary update/recovery failure.
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export function createUpdaterServer({ keyText, port = 18765, host = "127.0.0.1", apply = applyVerifiedRelease,
  updaterRoot, dataRoot, statusFile = path.join(dataRoot, "status.json"), initialStatus = { status: "idle" },
  checkUser = async () => null, resumeUser = async () => ({ status: "waiting_for_login" }) } = {}) {
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65535) fail("invalid_updater_bind");
  const verify = createOriginVerifier(keyText);
  let state = initialStatus;
  const report = async next => { state = { ...next, at: new Date().toISOString() }; await writeFile(statusFile, JSON.stringify(state), { mode: 0o600 }); };
  const server = createServer(async (req, res) => {
    const reply = (code, data) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin) return reply(403, { error: "forbidden" });
      if (!["/v1/update", "/v1/status", "/v1/resume"].includes(req.url)) return reply(404, { error: "not_found" });
      const method = req.url === "/v1/status" ? "GET" : "POST";
      if (req.method !== method) return reply(405, { error: "method_not_allowed" });
      let size = 0;
      const parts = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_REQUEST) return reply(413, { error: "too_large" }); parts.push(chunk); }
      const raw = Buffer.concat(parts);
      if (!verify(req.headers, method, req.url, raw)) return reply(403, { error: "denied" });
      if (method === "GET") {
        if (state.status === "user_pending") {
          const user = await checkUser().catch(() => null);
          if (user && Date.parse(user.last_run) >= Date.parse(state.started_at ?? state.at) - 5000) {
            if (user.state === "Running") return reply(200, { ...state, user_phase: "running" });
            if (user.state === "Ready" && user.last_result === 0) await report({ status: "updated", version: state.version });
            else if (user.state === "Ready" && Number.isInteger(user.last_result)) await report({ status: "user_failed", version: state.version, code: "local_ai_update_failed" });
          }
        }
        return reply(200, state);
      }
      if (req.url === "/v1/resume") {
        if (raw.length || !["user_pending", "user_failed"].includes(state.status)) return reply(409, { error: "no_user_phase_to_resume" });
        const outcome = await resumeUser();
        await report({ status: "user_pending", version: state.version, started_at: new Date().toISOString() });
        return reply(202, { status: outcome?.status === "queued" ? "queued" : "waiting_for_login", version: state.version });
      }
      if (state.status === "running") return reply(409, { error: "update_running" });
      const offer = validateUpdateOffer(JSON.parse(raw.toString("utf8")));
      // Response first: the updater might restart the caller MCP service.
      await report({ status: "running", version: offer.version });
      const startedAt = state.at;
      reply(202, { status: "accepted", version: offer.version });
      Promise.resolve().then(() => apply(offer, { updaterRoot, dataRoot })).then(
        result => report({ status: result?.status === "user_pending" ? "user_pending" : "updated", version: offer.version, started_at: startedAt }),
        error => report({ status: "failed", version: offer.version,
          code: typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,120}$/.test(error.code) ? error.code : "update_failed",
          recovery: ["healthy", "locked"].includes(error?.recovery) ? error.recovery : "unknown",
          ...(error?.diagnostic && ["remote", "unified", "maintain", "verify", "unknown"].includes(error.diagnostic.script) &&
            Number.isInteger(error.diagnostic.line) && error.diagnostic.line >= 0 && error.diagnostic.line <= 9999 &&
            typeof error.diagnostic.type === "string" && /^[a-z]{3,40}$/.test(error.diagnostic.type)
            ? { diagnostic: error.diagnostic } : {}),
        }),
      ).catch(() => { state = { status: "failed", code: "status_unavailable" }; });
    } catch { if (!res.writableEnded) reply(400, { error: "invalid_request" }); }
  });
  return server;
}

// Only the fixed, password-free Task Scheduler action may run as the current
// interactive user. SYSTEM never accepts a user account or command from MCP.
export async function runFixedUserTask({ invoke = exec, read = readFile, write = writeFile,
  programData = process.env.ProgramData ?? "C:\\ProgramData" } = {}) {
  const jobPath = path.win32.join(programData, "KTK", "Updater", "public", "job.json");
  let job;
  try { job = JSON.parse(await read(jobPath, "utf8")); }
  catch { fail("user_update_job_unavailable"); }
  if (!job || job.schema !== 1 || !VERSION.test(job.version ?? "") || !DIGEST.test(job.manifest_sha256 ?? "") ||
      typeof job.attempt !== "string" || !/^[a-f0-9]{32}$/.test(job.attempt)) fail("user_update_job_invalid");
  job.attempt = randomBytes(16).toString("hex");
  await write(jobPath, JSON.stringify(job), { mode: 0o600 });
  const native = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
  try {
    await invoke(native, ["/run", "/tn", "KTKQwenUserUpdater"], {
      shell: false, windowsHide: true, timeout: 15000, maxBuffer: 8192,
    });
    return { status: "queued" };
  } catch { return { status: "waiting_for_login" }; }
}

export async function inspectFixedUserTask({ invoke = exec } = {}) {
  const native = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$t=Get-ScheduledTask -TaskName 'KTKQwenUserUpdater' -ErrorAction Stop; $i=Get-ScheduledTaskInfo -TaskName 'KTKQwenUserUpdater' -ErrorAction Stop; @{state=[string]$t.State;last_result=[int64]$i.LastTaskResult;last_run=$i.LastRunTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress";
  try {
    const { stdout } = await invoke(native, ["-NoProfile", "-NonInteractive", "-Command", script], {
      shell: false, windowsHide: true, timeout: 15000, maxBuffer: 8192,
    });
    const result = JSON.parse(stdout);
    return typeof result?.state === "string" && typeof result?.last_run === "string" && Number.isInteger(result?.last_result) ? result : null;
  } catch { return null; }
}

export async function runUpdaterService() {
  if (process.platform !== "win32" || process.arch !== "x64") fail("windows_updater_only");
  const updaterRoot = path.win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "KTK", "Updater");
  const dataRoot = path.win32.join(process.env.ProgramData ?? "C:\\ProgramData", "KTK", "Updater");
  await mkdir(dataRoot, { recursive: true });
  const keyText = (await readFile(path.win32.join(process.env.ProgramData ?? "C:\\ProgramData", "KTK", "QwenMCP", "secrets", "gateway.key"), "utf8")).trim();
  let initialStatus;
  try { initialStatus = JSON.parse(await readFile(path.win32.join(dataRoot, "status.json"), "utf8")); } catch { initialStatus = { status: "idle" }; }
  if (!initialStatus || typeof initialStatus !== "object" || !["idle", "failed", "updated", "user_pending", "user_failed"].includes(initialStatus.status)) {
    initialStatus = { status: "failed", code: "updater_interrupted" };
  }
  const server = createUpdaterServer({ keyText, updaterRoot, dataRoot, initialStatus,
    checkUser: inspectFixedUserTask, resumeUser: runFixedUserTask });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(18765, "127.0.0.1", resolve); });
  process.stdout.write("KTK update service ready on loopback\n");
}
