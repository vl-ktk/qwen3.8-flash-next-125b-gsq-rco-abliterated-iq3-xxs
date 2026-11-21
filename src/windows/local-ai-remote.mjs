import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const invoke = promisify(execFile);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const HEX32 = /^[a-f0-9]{32}$/;
const LIFETIME = 5 * 60 * 1000;
const JOB_LIFETIME = 24 * 60 * 60 * 1000;
const ALLOWED = new Set(["prepare", "repair"]);

export function validateLocalAiPrepare(args) {
  if (!args || Array.isArray(args) || typeof args !== "object" ||
      Object.keys(args).join() !== "operation" || !ALLOWED.has(args.operation)) fail("local_ai_invalid_operation");
  return { operation: args.operation };
}

export function validateLocalAiConfirm(args) {
  if (!args || Array.isArray(args) || typeof args !== "object" ||
      Object.keys(args).sort().join() !== "confirmation,plan_id" || !HEX32.test(args.plan_id) ||
      args.confirmation !== `CONFIRM KTK LOCAL AI ${args.plan_id}`) fail("local_ai_owner_confirmation_required");
  return { plan_id: args.plan_id, confirmation: args.confirmation };
}

export function validateLocalAiJob(job, now = Date.now()) {
  if (!job || Array.isArray(job) || typeof job !== "object" ||
      Object.keys(job).sort().join() !== "action,attempt,created_at,expires_at,schema" ||
      job.schema !== 1 || !ALLOWED.has(job.action) || !HEX32.test(job.attempt) ||
      !Number.isSafeInteger(job.created_at) || !Number.isSafeInteger(job.expires_at) ||
      job.created_at > now || job.expires_at <= now ||
      job.expires_at - job.created_at > JOB_LIFETIME) fail("local_ai_job_invalid_or_expired");
  return job;
}

// The updater may QUEUE a fixed user action, never run a model or any script
// selected by the MCP caller. A separate permission and 5-minute owner plan
// are mandatory. Readiness is observed, never guessed from a queued task.
export function createLocalAiRemoteController({
  inspect = async () => ({ status: "unknown", reason: "user_task_unverified" }),
  queue = async () => fail("local_ai_queue_not_configured"),
  now = () => Date.now(), newId = () => randomBytes(16).toString("hex"),
} = {}) {
  const plans = new Map();
  let busy = false;
  const status = async () => {
    const result = await inspect();
    const phase = result.installation_status ?? "unknown";
    const next = result.user_task_trusted !== true ? "reinstall_verified_user_updater" :
      phase === "failed" ? "prepare_repair_and_confirm_in_chat" :
        phase === "running" ? "check_install_status_later" :
          phase === "completed" ? "await_stage_4_manual_load_buttons" : "preview_then_confirm_in_chat";
    return { ...result, next_action: next, model_loaded: "unknown", model_load_control: "not_installed_stage_4",
      installs_model_on_status: false };
  };
  const preview = async args => {
    const { operation } = validateLocalAiPrepare(args);
    if (busy) fail("local_ai_busy");
    const existing = await status();
    const reason = existing.user_task_trusted !== true ? "local_ai_user_task_untrusted_or_missing" :
      existing.job_status === "running" ? "local_ai_job_running" : null;
    const details = { status: reason ? "blocked" : "ready_for_owner_confirmation", operation, reason,
      execution: "KTKQwenUserUpdater (the installed interactive Windows account, never SYSTEM)",
      hardware_readiness: existing.hardware_readiness ?? "unknown",
      model: "SC117 IQ3_XXS", strata: "0.2.17", expected_download_bytes: 76966598276,
      effect: "Queue only pinned Strata + SC117 download, verify and pack. No CUDA inference, model load/unload or user-selected commands.",
      risk: "Downloads approximately 77 GB and requires free SSD space, CUDA-capable NVIDIA GPU and an interactive Windows account. If the user is logged out, wait for that user's next login.",
      requires_pc_confirmation: false, requires_owner_chat_confirmation: true,
      next_action: reason ? "install_and_enrol_ktk_user_updater_first" : "confirm_in_chat",
      rollback: "Keep already verified shards; retry resumably. Never remove user files or reset Windows." };
    if (reason) return details;
    const planId = newId();
    if (!HEX32.test(planId)) fail("local_ai_nonce_unavailable");
    plans.clear();
    plans.set(planId, { operation, expires: now() + LIFETIME });
    return { ...details, plan_id: planId, expires_in_seconds: 300,
      owner_chat_confirmation: `CONFIRM KTK LOCAL AI ${planId}` };
  };
  const dispatch = async (args, operation) => {
    const { plan_id } = validateLocalAiConfirm(args);
    const entry = plans.get(plan_id);
    plans.delete(plan_id);
    if (!entry || entry.expires <= now() || entry.operation !== operation) fail("local_ai_plan_expired_or_mismatch");
    if (busy) fail("local_ai_busy");
    busy = true;
    try {
      const state = await status();
      if (state.user_task_trusted !== true || state.job_status === "running") fail("local_ai_user_task_untrusted_or_busy");
      const job = { schema: 1, action: operation, attempt: newId(), created_at: now(), expires_at: now() + JOB_LIFETIME };
      validateLocalAiJob(job, now());
      const result = await queue(job);
      return { status: result?.status === "queued" ? "queued" : "waiting_for_login",
        job_id: job.attempt, action: operation, local_model_started: false,
        note: "Queue accepted. Model files may download only in the original user's session; no inference or model load." };
    } finally { busy = false; }
  };
  return { preview, install: args => dispatch(args, "prepare"), repair: args => dispatch(args, "repair"),
    status, isBusy: () => busy };
}

// Exact Task Scheduler identity, binary and script. PATH is never inherited
// from an MCP request; no user, command or file path is a function argument.
export async function inspectKtkUserTask({ invokeCommand = invoke,
  windowsRoot = process.env.SystemRoot ?? "C:\\Windows" } = {}) {
  const exe = path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$ErrorActionPreference='Stop'; $t=Get-ScheduledTask -TaskName 'KTKQwenUserUpdater' -TaskPath '\\' -ErrorAction Stop;
    $a=@($t.Actions); $p=$t.Principal; if ($a.Count -ne 1 -or $p.LogonType -ne 'Interactive' -or $p.RunLevel -ne 'Limited') { throw 'task_untrusted' };
    $exe=[string]$a[0].Execute; $args=[string]$a[0].Arguments;
    if (-not $exe.StartsWith('C:\\',[StringComparison]::OrdinalIgnoreCase) -and -not $exe.StartsWith('D:\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'task_binary_untrusted' };
    if (-not $exe.EndsWith('\\AppData\\Local\\KTK\\UserUpdater\\bin\\node.exe',[StringComparison]::OrdinalIgnoreCase)) { throw 'task_binary_untrusted' };
    $expected=Join-Path (Split-Path $exe -Parent | Split-Path -Parent) 'Run-KTKUserUpdate.mjs';
    if ($args -cne ('"'+$expected+'"')) { throw 'task_entry_untrusted' };
    $root=Split-Path $expected -Parent; $ownerPath=Join-Path $root 'owner.json';
    if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) { throw 'task_owner_missing' };
    $marker=Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json;
    $sid=[string]$p.UserId;
    if ($sid -notmatch '^S-1-') { $sid=([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value };
    if ($marker.schema -ne 1 -or $marker.sid -cne $sid -or $sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw 'task_owner_mismatch' };
    $result=[ordered]@{user_task_trusted=$true;job_status=[string]$t.State;installation_status='not_started'};
    $reportPath=Join-Path (Split-Path $root -Parent) 'LocalAI\status.json';
    if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
      $f=Get-Item -LiteralPath $reportPath -Force;
      if (($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $f.Length -gt 4096) { throw 'local_ai_status_untrusted' };
      $report=Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json;
      if ($report.schema -ne 1 -or $report.source -cne 'KTK_user_local_ai_job' -or $report.status -notin @('running','completed','failed')) { throw 'local_ai_status_untrusted' };
      $result.installation_status=[string]$report.status;
      $result.phase=[string]$report.phase;
      if ($report.code) { $result.code=[string]$report.code };
      if ($null -ne $report.bytes_done) { $result.bytes_done=[long]$report.bytes_done };
      if ($null -ne $report.bytes_total) { $result.bytes_total=[long]$report.bytes_total };
      if ($null -ne $report.file_index) { $result.file_index=[int]$report.file_index };
      if ($null -ne $report.files_total) { $result.files_total=[int]$report.files_total };
      $resultPath=Join-Path (Split-Path $root -Parent) 'LocalAI\result.json';
      if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        $rf=Get-Item -LiteralPath $resultPath -Force;
        if (($rf.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $rf.Length -gt 4096) { throw 'local_ai_result_untrusted' };
        $completed=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json;
        if ($completed.source -cne 'KTK_user_local_ai_job') { throw 'local_ai_result_untrusted' };
        if ($completed.attempt -ceq $report.attempt -and $completed.status -eq 'files_prepared_no_inference') { $result.file_sha256_verified_during_this_attempt=[bool]$completed.model_hashes_verified_now };
      };
    };
    [pscustomobject]$result | ConvertTo-Json -Compress`;
  try {
    const result = await invokeCommand(exe, ["-NoProfile", "-NonInteractive", "-Command", script],
      { shell: false, windowsHide: true, timeout: 12000, maxBuffer: 4096 });
    const value = JSON.parse(result.stdout);
    if (value.user_task_trusted !== true || !["not_started", "running", "completed", "failed"].includes(value.installation_status)) fail("local_ai_status_invalid");
    const phase = typeof value.phase === "string" && /^[a-z0-9_]{1,70}$/.test(value.phase) ? value.phase : "unknown";
    const code = typeof value.code === "string" && /^[a-z][a-z0-9_]{2,80}$/.test(value.code) ? value.code : undefined;
    const progress = [value.bytes_done, value.bytes_total].every(x => Number.isSafeInteger(x) && x >= 0) && value.bytes_done <= value.bytes_total ?
      { bytes_done: value.bytes_done, bytes_total: value.bytes_total } : {};
    const files = [value.file_index, value.files_total].every(x => Number.isSafeInteger(x) && x > 0) && value.file_index <= value.files_total && value.files_total <= 6 ?
      { file_index: value.file_index, files_total: value.files_total } : {};
    return { user_task_trusted: true, job_status: value.job_status === "Running" ? "running" : "not_running",
      installation_status: value.installation_status, phase, ...(code ? { code } : {}), ...progress, ...files,
      ...(typeof value.file_sha256_verified_during_this_attempt === "boolean" ? { file_sha256_verified_during_this_attempt: value.file_sha256_verified_during_this_attempt } : {}) };
  } catch { return { user_task_trusted: false, job_status: "unknown", reason: "task_missing_untrusted_or_logged_out" }; }
}

// SYSTEM-owned, same fixed public directory as the verified MCP release.
// An ACL must grant Users read-only and only SYSTEM/Admins write, enforced by
// the installer. Refuse a missing directory instead of creating an unsafe one.
export async function queueKtkLocalAiJob(job, { dataRoot, invokeCommand = invoke } = {}) {
  validateLocalAiJob(job);
  const publicDir = path.join(dataRoot, "public");
  const dir = await lstat(publicDir).catch(() => fail("local_ai_public_directory_missing"));
  if (!dir.isDirectory() || dir.isSymbolicLink()) fail("local_ai_public_directory_untrusted");
  const file = path.join(publicDir, "local-ai-job.json");
  const previous = await lstat(file).catch(error => error?.code === "ENOENT" ? null : fail("local_ai_existing_job_untrusted"));
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.size > 2048)) fail("local_ai_existing_job_untrusted");
  const tmp = path.join(publicDir, `local-ai-job-${randomBytes(16).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(job), { flag: "wx", mode: 0o600 });
  try { await rename(tmp, file); } catch { fail("local_ai_job_write_failed"); }
  const schtasks = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
  try {
    await invokeCommand(schtasks, ["/run", "/tn", "KTKQwenUserUpdater"],
      { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 4096 });
    return { status: "queued" };
  } catch { return { status: "waiting_for_login" }; }
}
