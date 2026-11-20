import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import lock from "./strata-runtime.lock.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const MIN_FREE_BYTES = 2_500_000_000; // Terminal + largest Windows CUDA engine + staging headroom; not model space.
const MAX_SCRIPT_BYTES = 32768;
const ROOT_MARKER = "ktk-strata-install.json";
const RELEASE_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function validateStrataRelease(config = lock) {
  if (config?.schema !== 1 || config.upstream !== "Niko1221/Strata" || config.app_version !== "0.2.17" || config.control_version !== "0.1.63") fail("strata_release_untrusted");
  if (config.feed !== "https://github.com/Niko1221/Strata/releases/download/v0.2.17" || config.script?.url !== `${config.feed}/install.ps1`) fail("strata_release_untrusted");
  if (config.script.name !== "install.ps1" || config.script.bytes !== 16171 || config.script.sha256 !== "2dfcaabadae42e1f66ac821244db1dfbef5832b3e9711842ed55ae50163837d8") fail("strata_release_untrusted");
  if (config.terminal?.sha256 !== "2d7cb26aa0c36db65e0d71eafa048227a4098c4b0dd70423d507cdf8f7cba44d" || config.engines?.cuda12?.sha256 !== "8f214b7f7de11c67f91a604c4066a48c4fb282ad3b51e0e970e30ada846fe6ed" || config.engines?.cuda13?.sha256 !== "fc9864851a3f76855f25ba5f5ff1eb42d46c3c6ed45c22534dc9910f20d9dc0f") fail("strata_release_untrusted");
  return config;
}

// A separate KTK-owned per-user tree. Never install into somebody else's
// existing Strata desktop/terminal directory or the MCP LocalService profile.
export function strataInstallRoot(localAppData = process.env.LOCALAPPDATA) {
  if (typeof localAppData !== "string" || !path.win32.isAbsolute(localAppData) || !/^[a-z]:\\[^\\/]/i.test(localAppData)) fail("invalid_local_user_profile");
  if (/\\windows\\(?:serviceprofiles\\|system32\\config\\systemprofile(?:\\|$))/i.test(localAppData)) fail("strata_interactive_user_required");
  return path.win32.join(localAppData, "KTK", "Strata");
}

export function strataInstallPlan(config = lock) {
  validateStrataRelease(config);
  return {
    status: "planned_no_changes",
    version: config.app_version, control_version: config.control_version,
    execution: "interactive_windows_user_only",
    install_root: "%LOCALAPPDATA%\\KTK\\Strata",
    feed: config.feed, required_free_bytes: MIN_FREE_BYTES,
    steps: ["check_unowned_directory_and_disk", "download_and_verify_pinned_official_script", "install_self_contained_terminal", "signed_feed_engine_update", "check_cli_and_engine_status"],
    permissions: "local_installer_approval_required; never exposed as a remote MCP write tool",
    warnings: ["Strata's signed updater selects an NVIDIA CUDA 12/13 package; actual compatibility and inference are not verified.", "A later combined Setup must launch this routine as the interactive Windows user; an MCP LocalService cannot install into that user's profile."],
  };
}

export async function fetchPinnedStrataScript({ config = lock, fetchImpl = fetch } = {}) {
  validateStrataRelease(config);
  let response;
  try { response = await fetchImpl(config.script.url, { redirect: "follow", signal: AbortSignal.timeout(120000) }); }
  catch { fail("strata_download_failed"); }
  if (!response?.ok || !response.body) fail("strata_download_failed");
  // HTTPS GitHub release redirects to GitHub's static release-asset hosts.
  if (response.url) {
    let url;
    try { url = new URL(response.url); } catch { fail("strata_download_redirect_denied"); }
    if (url.protocol !== "https:" || !RELEASE_HOSTS.has(url.hostname)) fail("strata_download_redirect_denied");
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const part of response.body) {
      total += part.byteLength;
      if (total > MAX_SCRIPT_BYTES || total > config.script.bytes) fail("strata_download_size_mismatch");
      chunks.push(Buffer.from(part));
    }
  } catch (error) {
    if (error?.code === "strata_download_size_mismatch") throw error;
    fail("strata_download_failed");
  }
  const body = Buffer.concat(chunks);
  if (body.length !== config.script.bytes || createHash("sha256").update(body).digest("hex") !== config.script.sha256) fail("strata_download_hash_mismatch");
  return body;
}

const readState = async location => {
  try { return JSON.parse(await readFile(location, "utf8")); }
  catch { fail("strata_existing_install_unrecognized"); }
};
const regular = async file => {
  try { return (await stat(file)).isFile(); } catch { return false; }
};
const safeCall = async (invoke, executable, args, env, cwd, timeout) => {
  try {
    const result = await invoke(executable, args, { env, cwd, windowsHide: true, shell: false, timeout, maxBuffer: 256 * 1024, encoding: "utf8" });
    if (result?.exitCode && result.exitCode !== 0) fail("strata_command_failed");
    return result;
  } catch { fail("strata_command_failed"); }
};

export function verifyStrataEngineInventory(stdout, config = lock) {
  let result;
  try { result = JSON.parse(stdout); } catch { fail("strata_engine_unverified"); }
  if (result?.schema_version !== 1 || result.ok !== true || !Array.isArray(result.families)) fail("strata_engine_unverified");
  const active = result.families.filter(family => family?.family === "qwen" || family?.family === "flash_next")
    .flatMap(family => Array.isArray(family.engines) ? family.engines : [])
    .find(engine => engine?.active === true && engine?.fits === true && engine?.version === config.control_version && engine?.backend === "cuda" && ["cuda12", "cuda13"].includes(engine?.variant));
  if (!active) fail("strata_engine_unverified");
  return { version: active.version, backend: active.backend, variant: active.variant, inference_tested: false };
}

export async function installStrata({ ownerApproved = false, platform = process.platform, arch = process.arch,
  root = null, localAppData = process.env.LOCALAPPDATA, config = lock,
  fetchImpl = fetch, getScript = fetchPinnedStrataScript, invoke = execFileAsync, availableBytes = null, now = () => new Date(), onStage = null } = {}) {
  validateStrataRelease(config);
  if (!ownerApproved) fail("strata_owner_approval_required");
  if (platform !== "win32" || arch !== "x64") fail("strata_windows_x64_required");
  const installRoot = root ?? strataInstallRoot(localAppData);
  if (typeof installRoot !== "string" || installRoot.length < 8 || !path.isAbsolute(installRoot)) fail("invalid_strata_install_root");
  const stateFile = path.join(installRoot, ROOT_MARKER);
  const bin = path.join(installRoot, "terminal", "current");
  const py = path.join(bin, "python", "python.exe");
  const entry = path.join(bin, "strata.py");
  const rootStat = await lstat(installRoot).catch(error => error?.code === "ENOENT" ? null : fail("strata_install_root_unavailable"));
  if (rootStat) {
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("strata_install_root_untrusted");
    const state = await readState(stateFile);
    if (state.schema !== 1 || state.version !== config.app_version || state.status !== "ready" || !(await regular(py)) || !(await regular(entry))) fail("strata_existing_install_unrecognized");
    if (onStage) await onStage("already_installed");
    return { status: "already_installed", version: config.app_version, engine: "previously_recorded_not_retested", location: installRoot };
  }
  let free;
  try {
    if (availableBytes !== null) free = availableBytes;
    else { const disk = await statfs(localAppData || path.dirname(path.dirname(installRoot))); free = disk.bavail * disk.bsize; }
  } catch { fail("strata_disk_unavailable"); }
  if (!Number.isSafeInteger(free) || free < MIN_FREE_BYTES) fail("strata_disk_insufficient");

  // Exclusive mkdir is a lock: a competing or pre-existing install aborts.
  await mkdir(path.dirname(installRoot), { recursive: true });
  try { await mkdir(installRoot); }
  catch { fail("strata_install_root_exists"); }
  const nonce = randomBytes(16).toString("hex");
  let owned = false;
  try {
    await writeFile(stateFile, JSON.stringify({ schema: 1, status: "installing", version: config.app_version, nonce }), { flag: "wx", mode: 0o600 });
    owned = true;
    if (onStage) await onStage("downloading_terminal");
    const script = await getScript({ config, fetchImpl });
    const scriptPath = path.join(installRoot, "verified-install.ps1");
    await writeFile(scriptPath, script, { flag: "wx", mode: 0o600 });
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const env = {
      SystemRoot: systemRoot, WINDIR: systemRoot,
      PATH: `${path.win32.join(systemRoot, "System32")};${systemRoot}`,
      LOCALAPPDATA: localAppData ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "",
      PROCESSOR_ARCHITECTURE: "AMD64", PSModulePath: process.env.PSModulePath ?? "",
      STRATA_DATA_DIR: installRoot, STRATA_NO_PATH: "1", STRATA_FEED: config.feed,
      PYTHONNOUSERSITE: "1", PYTHONHOME: "", PYTHONPATH: "",
    };
    const ps = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (onStage) await onStage("installing_terminal");
    await safeCall(invoke, ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], env, installRoot, 900000);
    if (!(await regular(py)) || !(await regular(entry))) fail("strata_terminal_incomplete");
    const pythonEnv = { ...env, STRATA_HOME: path.join(installRoot, "home") };
    const version = await safeCall(invoke, py, [entry, "--version"], pythonEnv, bin, 30000);
    if (typeof version?.stdout !== "string" || !/\b0\.2\.17\b/.test(version.stdout)) fail("strata_version_mismatch");
    // The upstream updater verifies its signed feed and each engine manifest.
    // No model weights are acquired; engine selection follows the GPU/driver.
    if (onStage) await onStage("installing_cuda_engine");
    await safeCall(invoke, py, [entry, "update", "--no-control", "--feed", config.feed, "--output", "json"], pythonEnv, bin, 1800000);
    const engineResult = await safeCall(invoke, py, [entry, "components", "engines", "--output", "json"], pythonEnv, bin, 30000);
    const engine = verifyStrataEngineInventory(engineResult.stdout, config);
    await writeFile(stateFile, JSON.stringify({ schema: 1, status: "ready", version: config.app_version, control: config.control_version,
      engine, feed: config.feed, script_sha256: config.script.sha256, at: now().toISOString() }) + "\n", { mode: 0o600 });
    if (onStage) await onStage("ready");
    return { status: "installed", version: config.app_version, control_version: config.control_version, engine, location: installRoot };
  } catch (error) {
    // Remove only this attempt's new KTK tree; never touch an existing Strata
    // installation, any user's models, services, registry or Windows PATH.
    if (owned) {
      try {
        const state = JSON.parse(await readFile(stateFile, "utf8"));
        if (state.nonce === nonce && state.status === "installing") await rm(installRoot, { recursive: true, force: false });
      } catch { /* Keep unknown data intact; report the primary failure. */ }
    }
    fail(error?.code?.startsWith("strata_") ? error.code : "strata_install_failed");
  }
}

// Only for a crashed fresh attempt. Never delete a completed installation,
// an unowned directory, or any shared Strata desktop/model library.
export async function recoverIncompleteStrata({ ownerApproved = false, platform = process.platform,
  arch = process.arch, localAppData = process.env.LOCALAPPDATA, root = null } = {}) {
  if (!ownerApproved) fail("strata_owner_approval_required");
  if (platform !== "win32" || arch !== "x64") fail("strata_windows_x64_required");
  const installRoot = root ?? strataInstallRoot(localAppData);
  const info = await lstat(installRoot).catch(() => null);
  if (!info) return { status: "nothing_to_recover" };
  if (!info.isDirectory() || info.isSymbolicLink()) fail("strata_install_root_untrusted");
  const marker = await readState(path.join(installRoot, ROOT_MARKER));
  if (marker.schema !== 1 || marker.version !== lock.app_version || marker.status !== "installing" || !/^[a-f0-9]{32}$/.test(marker.nonce ?? "")) fail("strata_recovery_denied");
  await rm(installRoot, { recursive: true, force: false });
  return { status: "incomplete_install_removed", note: "Only the KTK-owned unfinished Strata tree was removed. Existing Strata and models were not touched." };
}
