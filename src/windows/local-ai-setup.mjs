import { createServer } from "node:net";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWindowsToolRegistry } from "./windows-tools.mjs";
import { strataInstallRoot, installStrata } from "./strata-installer.mjs";
import { prepareSc117Model } from "./sc117-model.mjs";
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
    note: "Only --install --installer-approved performs changes. Setup.exe --OFFLINE skips live model installation.",
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

export async function runLocalAiSetup({ approved = false, platform = process.platform, arch = process.arch,
  localAppData = process.env.LOCALAPPDATA, statusDir = null, inventory = queryLocalAiPreflight,
  installRuntime = installStrata, prepareModel = prepareSc117Model, testInference = testSc117Inference,
  acquireLock = acquireLocalAiSetupLock, reportFactory = statusReporter,
  timeNow = () => Date.now() } = {}) {
  if (!approved) fail("localai_installer_approval_required");
  if (platform !== "win32" || arch !== "x64") fail("localai_windows_x64_required");
  const unlock = await acquireLock();
  let stage = "preflight";
  let reporter;
  try {
    const folder = statusDir ?? await ensureStatusDirectory(localAppData);
    reporter = await reportFactory(folder);
    const update = async (phase, percent, detail = null) => reporter.status({ status: "running", phase, percent, detail });
    await reporter.result({ status: "running", phase: "preflight", code: "localai_in_progress" });
    await update("preflight", 1);
    const { pc, storage } = await inventory();
    const hardware = assertLocalAiHardware(pc, storage);
    await update("preflight_complete", 5, hardware);

    stage = "strata";
    const strata = await installRuntime({ ownerApproved: true, localAppData,
      onStage: name => update("strata_" + name, name === "ready" || name === "already_installed" ? 21 : 12) });
    if (!strata || !["installed", "already_installed"].includes(strata.status)) fail("localai_strata_incomplete");
    await update("strata_ready", 22);

    stage = "model";
    let lastReport = 0;
    const model = await prepareModel({ approved: true, localAppData,
      onStage: (name, detail) => update("sc117_" + name, name === "packing" ? 89 : name === "prepared" || name === "already_prepared" ? 93 : 24, detail ?? null),
      onProgress: async ({ bytes_done, bytes_total, file_index, files_total }) => {
        if (!Number.isSafeInteger(bytes_done) || !Number.isSafeInteger(bytes_total) || bytes_total <= 0) return;
        const now = timeNow();
        if (now - lastReport < 1000 && bytes_done < bytes_total) return;
        lastReport = now;
        await update("sc117_downloading", 24 + Math.floor(64 * Math.min(1, bytes_done / bytes_total)),
          { bytes_done, bytes_total, file_index, files_total });
      },
    });
    if (!model?.root || !["prepared_for_inference_test", "already_prepared_not_rehashed"].includes(model.status)) fail("localai_model_incomplete");
    await update("sc117_ready", 93);

    stage = "inference";
    const tested = await testInference({ approved: true, modelRoot: model.root, localAppData,
      onStage: name => update("inference_" + name, name === "verified" ? 99 : 95) });
    if (tested?.status !== "inference_verified_and_stopped" || tested.inference_tested !== true) fail("localai_inference_not_verified");
    const result = { status: "passed", code: "localai_installed_tested", model: "SC117 IQ3_XXS",
      strata_version: "0.2.17", inference_verified: true, endpoint: "127.0.0.1:18764",
      note: "Inference acceptance ended with an owned graceful stop; model files remain on disk." };
    await reporter.result(result);
    await update("complete", 100);
    return result;
  } catch (error) {
    // Never remove verified shards/MTP or preexisting Windows services. The
    // B/C modules preserve their own retry markers, D owns its exact stop.
    const code = typeof error?.code === "string" ? error.code : "localai_unexpected_failure";
    if (reporter) {
      await reporter.result({ status: "failed", phase: stage, code, retry: "rerun_same_setup_exe", retained: "verified_artifacts" });
      await reporter.status({ status: "failed", phase: stage, percent: null, code });
    }
    throw Object.assign(new Error(code), { code });
  } finally {
    await unlock();
  }
}
