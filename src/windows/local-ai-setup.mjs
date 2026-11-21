import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWindowsToolRegistry } from "./windows-tools.mjs";
import { strataInstallRoot, installStrata, recoverIncompleteStrata } from "./strata-installer.mjs";
import { prepareSc117Model, sc117Plan } from "./sc117-model.mjs";
import { testSc117Inference } from "./sc117-inference.mjs";

const GIB = 2 ** 30;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function localAiSetupPlan() {
  return {
    status: "planned_no_changes", mode: "one_click_local_windows_user",
    phases: ["hardware_and_storage_preflight", "install_pinned_strata", "download_verify_and_pack_sc117", "localhost_inference_acceptance", "retain_installation_for_normal_use"],
    interactive_user_required: true, requires_explicit_installer_approval: true,
    model: "SC117 IQ3_XXS", runtime: "Strata 0.2.17",
    progress_report: "%LOCALAPPDATA%\\KTK\\LocalAI\\status.json",
    result_report: "%LOCALAPPDATA%\\KTK\\LocalAI\\result.json",
    on_failure: "retain_owned_verified_model_bytes_and_report_error_for_one_click_retry",
    cancellation: "interactive_user_requested_at_safe_checkpoint; preserve_verified_and_partial_model_bytes",
    note: "Only --install --installer-approved performs changes. Setup.exe defaults to MCP only; the user must explicitly select local AI.",
  };
}

// The 24-GiB-class target has ~23.9 GiB reported by some driver counters.
// Reject unknown GPU rather than downloading 77 GB blindly.
export function assertLocalAiHardware(pc, storage) {
  if (!pc || !storage || pc.os?.architecture?.includes("64") !== true) fail("localai_windows_x64_unverified");
  if (!Number.isSafeInteger(pc.ram?.total_bytes) || pc.ram.total_bytes < 32 * GIB) fail("localai_ram_below_32gib");
  if (pc.gpu?.status !== "ok" || !Array.isArray(pc.gpu.gpus) ||
      !pc.gpu.gpus.some(gpu => Number.isSafeInteger(gpu.vram_total_bytes) && gpu.vram_total_bytes >= 20 * GIB)) fail("localai_nvidia_20gib_unverified");
  if (!Array.isArray(storage.volumes) || !storage.volumes.some(disk => ["C:", "D:"].includes(disk.drive) && Number.isSafeInteger(disk.free_bytes))) fail("localai_fixed_disk_unverified");
  return { ram_gib: Math.floor(pc.ram.total_bytes / GIB), gpu: "nvidia_20gib_or_more", disks_detected: true };
}

export async function queryLocalAiPreflight() {
  const registry = createWindowsToolRegistry();
  const [pc, storage] = await Promise.all([registry.call("pc_preflight", {}), registry.call("storage_check", {})]);
  return { pc, storage };
}

// Windows named-pipe ownership disappears on process exit, including a crash:
// unlike a persistent .lock file, it does not block an ordinary retry.
export async function acquireLocalAiSetupLock() {
  const server = createServer(socket => socket.destroy());
  const name = "\\\\.\\pipe\\KTK-Qwen-LocalAI-Setup";
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(name, resolve);
    });
  } catch {
    fail("localai_installer_already_running_or_unavailable");
  }
  return async () => new Promise(resolve => server.close(resolve));
}

async function ensureStatusDirectory(localAppData) {
  strataInstallRoot(localAppData); // validates a local interactive-user profile
  const parent = path.win32.join(localAppData, "KTK");
  const dir = path.win32.join(parent, "LocalAI");
  for (const target of [parent, dir]) {
    const entry = await lstat(target).catch(error => error?.code === "ENOENT" ? null : fail("localai_status_dir_unavailable"));
    if (!entry) await mkdir(target);
    else if (!entry.isDirectory() || entry.isSymbolicLink()) fail("localai_status_dir_untrusted");
  }
  return dir;
}

async function statusReporter(folder, { write = writeFile } = {}) {
  const report = async (file, data) => {
    const body = JSON.stringify({ schema: 1, at: new Date().toISOString(), ...data }) + "\n";
    await write(path.join(folder, file), body, { mode: 0o600 });
  };
  return { status: value => report("status.json", value), result: value => report("result.json", value) };
}

// A cancellation request is a per-run token, not an executable instruction.
// Stale requests from previous attempts cannot cancel a new installation.
export async function localAiCancelRequested(folder, runId) {
  const file = path.join(folder, "cancel-request.txt");
  const info = await lstat(file).catch(error => error?.code === "ENOENT" ? null : fail("localai_cancel_request_unavailable"));
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128) fail("localai_cancel_request_untrusted");
  return (await readFile(file, "utf8")).trim() === runId;
}

export async function runLocalAiSetup({ approved = false, platform = process.platform, arch = process.arch,
  localAppData = process.env.LOCALAPPDATA, statusDir = null, inventory = queryLocalAiPreflight,
  installRuntime = installStrata, recoverRuntime = recoverIncompleteStrata,
  prepareModel = prepareSc117Model, testInference = testSc117Inference,
  acquireLock = acquireLocalAiSetupLock, reportFactory = statusReporter,
  cancelRequested = localAiCancelRequested,
  timeNow = () => Date.now() } = {}) {
  if (!approved) fail("localai_installer_approval_required");
  if (platform !== "win32" || arch !== "x64") fail("localai_windows_x64_required");
  const unlock = await acquireLock();
  let stage = "preflight";
  let reporter;
  const runId = randomBytes(16).toString("hex");
  try {
    const folder = statusDir ?? await ensureStatusDirectory(localAppData);
    reporter = await reportFactory(folder);
    let lastCancelPoll = 0;
    const checkCancellation = async (force = true) => {
      const now = Date.now();
      if (!force && now - lastCancelPoll < 250) return;
      lastCancelPoll = now;
      if (await cancelRequested(folder, runId)) fail("localai_user_cancelled");
    };
    const update = async (phase, percent, detail = null) => {
      await reporter.status({ status: "running", run_id: runId, phase, percent, detail });
      await checkCancellation();
    };
    await reporter.result({ status: "running", phase: "preflight", code: "localai_in_progress" });
    await update("preflight", 1);
    const { pc, storage } = await inventory();
    const hardware = assertLocalAiHardware(pc, storage);
    const matchingGpu = pc.gpu.gpus.find(gpu => Number.isSafeInteger(gpu.vram_total_bytes) && gpu.vram_total_bytes >= 20 * GIB);
    const drives = storage.volumes.filter(v => ["C:", "D:"].includes(v.drive) && Number.isSafeInteger(v.free_bytes))
      .map(v => ({ drive: v.drive, free_gib: Math.floor(v.free_bytes / GIB) }));
    await update("preflight_complete", 5, { ...hardware, vram_gib: Math.floor(matchingGpu.vram_total_bytes / GIB),
      drives, download_bytes: sc117Plan().model_and_mtp_bytes });

    stage = "strata";
    const installPinnedRuntime = () => installRuntime({ ownerApproved: true, localAppData,
      onStage: name => update("strata_" + name, name === "ready" || name === "already_installed" ? 21 : 12) });
    let strata;
    try { strata = await installPinnedRuntime(); }
    catch (error) {
      // A prior crash may leave the *owned* Strata tree in installing state.
      // The recovery helper validates exact KTK marker/version/nonce and will
      // NEVER remove a ready, foreign or unrecognized Strata installation.
      if (error?.code !== "strata_existing_install_unrecognized") throw error;
      await update("strata_recovery", 10);
      const recovered = await recoverRuntime({ ownerApproved: true, localAppData, platform, arch });
      if (recovered?.status !== "incomplete_install_removed") fail("localai_strata_recovery_unconfirmed");
      strata = await installPinnedRuntime();
    }
    if (!strata || !["installed", "already_installed"].includes(strata.status)) fail("localai_strata_incomplete");
    await update("strata_ready", 22);

    stage = "model";
    let lastReport = 0;
    // Abort even a stalled HTTPS request with zero incoming chunks; never
    // abruptly kill a model packer or an owned inference process.
    const downloadAbort = new AbortController();
    let pollingCancel = false;
    const cancelTimer = setInterval(async () => {
      if (pollingCancel || downloadAbort.signal.aborted) return;
      pollingCancel = true;
      try {
        if (await cancelRequested(folder, runId))
          downloadAbort.abort(Object.assign(new Error("localai_user_cancelled"), { code: "localai_user_cancelled" }));
      } catch (error) { downloadAbort.abort(error); }
      finally { pollingCancel = false; }
    }, 350);
    cancelTimer.unref();
    let model;
    try {
      model = await prepareModel({ approved: true, localAppData, signal: downloadAbort.signal,
        onStage: (name, detail) => update("sc117_" + name, name === "packing" ? 89 : name === "prepared" || name === "already_prepared" ? 93 : 24, detail ?? null),
        onProgress: async ({ bytes_done, bytes_total, file_index, files_total }) => {
          await checkCancellation(false);
          if (!Number.isSafeInteger(bytes_done) || !Number.isSafeInteger(bytes_total) || bytes_total <= 0) return;
          const now = timeNow();
          if (now - lastReport < 1000 && bytes_done < bytes_total) return;
          lastReport = now;
          await update("sc117_downloading", 24 + Math.floor(64 * Math.min(1, bytes_done / bytes_total)),
            { bytes_done, bytes_total, file_index, files_total });
        },
      });
    } finally { clearInterval(cancelTimer); }
    if (!model?.root || !["prepared_for_inference_test", "already_prepared_not_rehashed"].includes(model.status)) fail("localai_model_incomplete");
    await update("sc117_ready", 93);

    stage = "inference";
    const tested = await testInference({ approved: true, modelRoot: model.root, localAppData,
      // Inference owns its startup and graceful stop; never interrupt the stop
      // callback even when the user has requested cancellation.
      onStage: name => reporter.status({ status: "running", run_id: runId, phase: "inference_" + name,
        percent: name === "verified" ? 99 : 95 }) });
    await checkCancellation();
    if (tested?.status !== "inference_verified_and_stopped" || tested.inference_tested !== true) fail("localai_inference_not_verified");
    const result = { status: "passed", code: "localai_installed_tested", model: "SC117 IQ3_XXS",
      strata_version: "0.2.17", inference_verified: true, runtime_state: "stopped", endpoint: "127.0.0.1:18764",
      note: "Inference acceptance ended with an owned graceful stop; model files remain on disk." };
    await reporter.result(result);
    await update("complete", 100);
    return result;
  } catch (error) {
    // Never remove verified shards/MTP or preexisting Windows services. The
    // B/C modules preserve their own retry markers, D owns its exact stop.
    const code = typeof error?.code === "string" ? error.code : "localai_unexpected_failure";
    if (reporter) {
      const cancelled = code === "localai_user_cancelled";
      await reporter.result({ status: cancelled ? "cancelled" : "failed", phase: stage, code,
        retry: "rerun_same_setup_exe", retained: cancelled ? "verified_and_partial_artifacts" : "verified_artifacts" });
      await reporter.status({ status: cancelled ? "cancelled" : "failed", phase: stage, percent: null, code });
    }
    throw Object.assign(new Error(code), { code });
  } finally {
    await unlock();
  }
}
