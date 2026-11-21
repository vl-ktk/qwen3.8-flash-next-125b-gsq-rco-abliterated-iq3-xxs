#!/usr/bin/env node
// Fixed per-user Task Scheduler extension. Does NOT start Strata inference or
// call /v1/load; only verifies/pins files and prepares the native model pack.
// No SYSTEM rights, user-selected shell, model path or URL are accepted.
import { createServer } from "node:net";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const FILES = Object.freeze({ status: "status.json", result: "result.json" });
function validateLocalAiJob(job, now) {
  if (!job || Array.isArray(job) || typeof job !== "object" ||
      Object.keys(job).sort().join() !== "action,attempt,created_at,expires_at,schema" ||
      job.schema !== 1 || !["prepare", "repair"].includes(job.action) ||
      !/^[a-f0-9]{32}$/.test(job.attempt) ||
      !Number.isSafeInteger(job.created_at) || !Number.isSafeInteger(job.expires_at) ||
      job.created_at > now || job.expires_at <= now || job.expires_at - job.created_at > 86400000) fail("local_ai_job_invalid_or_expired");
  return job;
}

async function exclusiveUserLock() {
  const server = createServer(connection => connection.destroy());
  try { await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen("\\\\.\\pipe\\KTK-Qwen-LocalAI-Setup", resolve);
  }); } catch { fail("local_ai_install_already_running"); }
  return () => new Promise(resolve => server.close(resolve));
}

export async function runLocalAiUserJob({ platform = process.platform, arch = process.arch,
  localAppData = process.env.LOCALAPPDATA, programData = process.env.ProgramData,
  now = () => Date.now(), read = readFile, write = writeFile,
  inspect = lstat, makeDir = mkdir, acquireLock = exclusiveUserLock,
  install = null, recover = null, prepare = null, preflight = null } = {}) {
  if (platform !== "win32" || arch !== "x64" || !localAppData || !programData ||
      !path.win32.isAbsolute(localAppData) ||
      /\\Windows\\(?:ServiceProfiles|System32\\config\\systemprofile)/i.test(localAppData)) fail("local_ai_interactive_user_required");
  const source = path.win32.join(programData, "KTK", "Updater", "public", "local-ai-job.json");
  let raw;
  try { raw = await read(source, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return { status: "no_approved_local_ai_job" }; fail("local_ai_job_unavailable"); }
  let job;
  try { job = validateLocalAiJob(JSON.parse(raw), now()); } catch { fail("local_ai_job_invalid_or_expired"); }
  const dir = path.win32.join(localAppData, "KTK", "LocalAI");
  for (const part of [path.win32.join(localAppData, "KTK"), dir]) {
    const meta = await inspect(part).catch(error => error?.code === "ENOENT" ? null : fail("local_ai_directory_unavailable"));
    if (meta && (!meta.isDirectory() || meta.isSymbolicLink())) fail("local_ai_directory_untrusted");
    if (!meta) await makeDir(part);
  }
  const prior = path.win32.join(dir, "remote-job-success.json");
  try {
    const result = JSON.parse(await read(prior, "utf8"));
    if (result.attempt === job.attempt && result.action === job.action) return { status: "already_prepared", attempt: job.attempt };
  } catch { /* No completed attempt. */ }
  const unlock = await acquireLock();
  let lastProgressAt = 0;
  const report = async (kind, value) => {
    const file = path.win32.join(dir, FILES[kind]);
    await write(file, JSON.stringify({ schema: 1, at: new Date(now()).toISOString(),
      source: "KTK_user_local_ai_job", attempt: job.attempt, ...value }) + "\n", { mode: 0o600 });
  };
  try {
    const checkHardware = preflight ?? (async () => {
      const setup = await import("./runtime/local-ai-setup.mjs");
      const { pc, storage } = await setup.queryLocalAiPreflight();
      return setup.assertLocalAiHardware(pc, storage);
    });
    await report("status", { status: "running", phase: "read_only_hardware_preflight" });
    await checkHardware();
    const modules = install && prepare ? null : await import("./runtime/strata-installer.mjs");
    const model = prepare ? null : await import("./runtime/sc117-model.mjs");
    const runInstall = install ?? modules.installStrata;
    const runRepair = recover ?? modules?.recoverIncompleteStrata;
    const runModel = prepare ?? model.prepareSc117Model;
    await report("status", { status: "running", phase: "preparing" });
    if (job.action === "repair") {
      await report("status", { status: "running", phase: "recovering_ktk_strata" });
      const marker = path.win32.join(localAppData, "KTK", "Strata", "ktk-strata-install.json");
      const previous = await read(marker, "utf8").then(JSON.parse).catch(error => error?.code === "ENOENT" ? null : fail("local_ai_strata_marker_untrusted"));
      if (previous?.status === "installing") {
        if (typeof runRepair !== "function") fail("local_ai_repair_unavailable");
        await runRepair({ ownerApproved: true, localAppData, platform, arch });
      } else if (previous && previous.status !== "ready") fail("local_ai_strata_marker_untrusted");
    }
    const strata = await runInstall({ ownerApproved: true, localAppData, platform, arch,
      onStage: phase => report("status", { status: "running", phase: `strata_${phase}` }) });
    if (!strata || !["installed", "already_installed"].includes(strata.status)) fail("local_ai_strata_install_incomplete");
    const result = await runModel({ approved: true, localAppData, platform, arch,
      onStage: (phase, detail) => report("status", { status: "running", phase: `sc117_${phase}`, detail: detail ?? null }),
      onProgress: ({ bytes_done, bytes_total, file_index, files_total }) => {
        const timestamp = now();
        if (timestamp - lastProgressAt < 1000 && bytes_done !== bytes_total) return;
        lastProgressAt = timestamp;
        return report("status", { status: "running", phase: "sc117_downloading",
          bytes_done, bytes_total, file_index, files_total });
      },
    });
    if (!result || !["prepared_for_inference_test", "already_prepared_not_rehashed"].includes(result.status)) fail("local_ai_sc117_install_incomplete");
    await report("result", { status: "files_prepared_no_inference", code: "manual_model_load_not_implemented", inference_tested: false,
      model_hashes_verified_now: result.status === "prepared_for_inference_test" });
    await report("status", { status: "completed", phase: "files_prepared_no_inference" });
    await write(prior, JSON.stringify({ schema: 1, attempt: job.attempt, action: job.action }) + "\n", { mode: 0o600 });
    return { status: "files_prepared_no_inference", inference_tested: false, model_started: false };
  } catch (error) {
    const code = /^[a-z][a-z0-9_]{2,80}$/.test(error?.code ?? "") ? error.code : "local_ai_install_failed";
    await report("result", { status: "failed", code, retry: "new_owner_approved_repair", retained: "verified_model_files_and_partials" });
    await report("status", { status: "failed", phase: "repairable", code });
    throw Object.assign(new Error(code), { code });
  } finally { await unlock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.platform === "win32") {
  runLocalAiUserJob().then(result => process.stdout.write(JSON.stringify(result) + "\n"), error => {
    process.stderr.write(JSON.stringify({ status: "failed", code: error?.code ?? "local_ai_install_failed" }) + "\n");
    process.exitCode = 1;
  });
}
