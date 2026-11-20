import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { strataInstallRoot } from "./strata-installer.mjs";
import modelLock from "./sc117-model.lock.json" with { type: "json" };
import { validateSc117Lock } from "./sc117-model.mjs";

const execFileAsync = promisify(execFile);
const PROFILE = "ktk-sc117-iq3xxs";
const PORT = 18764;
const ID = /^[0-9a-f]{32}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// A source-only stage until Block E connects all stages to one local GUI.
export function sc117InferencePlan() {
  return {
    status: "planned_no_changes", model: "SC117 IQ3_XXS", runtime: "Strata 0.2.17",
    endpoint: `http://127.0.0.1:${PORT}`, concurrency: { parallel: 1, max_queue: 0 },
    gpu_reserve_mib: 2048, context_tokens: 8192,
    memory: "min(40 GiB, floor(physical_ram_gib) - 24 GiB); minimum 8 GiB",
    workflow: ["require_completed_ktk_strata_and_sc117", "create_owned_profile_if_absent", "start_owned_local_runtime", "verify_ownership_health_and_generation", "stop_exact_owned_instance"],
    permissions: "interactive_windows_user_and_explicit_local_installer_approval_only",
    note: "No inference is run by --plan. The existing Setup.exe does not invoke this stage until Block E.",
  };
}

export function sc117ResourceBudget(totalMemoryBytes) {
  if (!Number.isSafeInteger(totalMemoryBytes) || totalMemoryBytes <= 0) fail("sc117_ram_unknown");
  const totalGiB = Math.floor(totalMemoryBytes / 2 ** 30);
  const residentGiB = Math.min(40, totalGiB - 24);
  if (residentGiB < 8) fail("sc117_ram_insufficient_for_conservative_profile");
  return { total_gib: totalGiB, resident_gib: residentGiB, vram_reserve_mib: 2048, context_tokens: 8192 };
}

// Runtime understands component:strata-engine and selects the locally verified
// signed CUDA component, never an executable downloaded from the model repo.
export function sc117ServeConfig(root, memoryBytes) {
  validateSc117Lock();
  if (!path.isAbsolute(root)) fail("sc117_model_root_invalid");
  const budget = sc117ResourceBudget(memoryBytes);
  const first = path.join(root, ...modelLock.files[0].path.split("/"));
  const second = path.join(root, ...modelLock.files[1].path.split("/"));
  const pack = path.join(root, "pack");
  return {
    exe: "component:strata-engine", backend: "cuda", cwd: root,
    args: ["--pack", pack, "--native", first, "--ple-gguf", second,
      "--mtp", path.join(root, "mtp", "rt"),
      "--resident-budget-gib", String(budget.resident_gib),
      "--vram-reserve-mib", String(budget.vram_reserve_mib),
      "--max-context", String(budget.context_tokens)],
    tokenizer: path.join(pack, "tokenizer"), model_name: PROFILE,
    log: path.join(root, "ktk-runtime", "strata.log"),
    host: "127.0.0.1", port: PORT, parallel: 1, max_queue: 0,
    offline: true,
  };
}

async function requiredFile(file) {
  const info = await lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size === 0) fail("sc117_inference_file_missing_or_untrusted");
}
async function requiredDir(dir) {
  const info = await lstat(dir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail("sc117_inference_directory_missing_or_untrusted");
}
async function jsonFile(file) {
  await requiredFile(file);
  try { return JSON.parse(await readFile(file, "utf8")); } catch { fail("sc117_inference_marker_invalid"); }
}

export async function findSc117ReadyRoot({ roots = ["D:\\KTK\\Models\\SC117-IQ3_XXS", "C:\\KTK\\Models\\SC117-IQ3_XXS"] } = {}) {
  for (const root of roots) {
    const exists = await lstat(path.join(root, "ktk-sc117-install.json")).catch(() => null);
    if (exists) return root;
  }
  fail("sc117_model_not_prepared");
}

export async function validateSc117InferenceReady({ modelRoot, strataRoot }) {
  validateSc117Lock();
  if (!path.isAbsolute(modelRoot) || !path.isAbsolute(strataRoot)) fail("sc117_inference_path_invalid");
  const strata = await jsonFile(path.join(strataRoot, "ktk-strata-install.json"));
  if (strata.schema !== 1 || strata.status !== "ready" || strata.version !== "0.2.17" || strata.engine?.backend !== "cuda") fail("sc117_strata_not_ready");
  const model = await jsonFile(path.join(modelRoot, "ktk-sc117-install.json"));
  if (model.schema !== 1 || model.status !== "ready" || model.quantization !== "IQ3_XXS" || model.revision !== modelLock.revision || !ID.test(model.nonce ?? "")) fail("sc117_model_not_ready");
  for (const dir of [strataRoot, path.join(strataRoot, "terminal"), path.join(strataRoot, "terminal", "current"),
    modelRoot, path.join(modelRoot, "IQ3_XXS"), path.join(modelRoot, "mtp"), path.join(modelRoot, "mtp", "rt"),
    path.join(modelRoot, "pack"), path.join(modelRoot, "pack", "tokenizer")]) await requiredDir(dir);
  for (const file of [path.join(strataRoot, "terminal", "current", "python", "python.exe"),
    path.join(strataRoot, "terminal", "current", "strata.py"),
    ...modelLock.files.map(f => f.path.startsWith("IQ3_XXS/")
      ? path.join(modelRoot, ...f.path.split("/")) : path.join(modelRoot, "mtp", "rt", path.basename(f.path))),
    ...["native_experts.txt", "index.txt", "dense.bin", "tokenizer/vocab.json", "tokenizer/chat_template.jinja"].map(f => path.join(modelRoot, "pack", f))]) await requiredFile(file);
  return { modelRoot, strataRoot, python: path.join(strataRoot, "terminal", "current", "python", "python.exe"),
    entry: path.join(strataRoot, "terminal", "current", "strata.py") };
}

// We do not inherit a broad environment containing unrelated secrets. A fresh
// ephemeral API key protects this session even though it is loopback-only.
function pythonEnvironment(strataRoot, apiKey) {
  const sys = process.env.SystemRoot || "C:\\Windows";
  return { SystemRoot: sys, WINDIR: sys, PATH: `${path.win32.join(sys, "System32")};${sys}`,
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
    TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "",
    STRATA_DATA_DIR: strataRoot, STRATA_HOME: path.join(strataRoot, "home"),
    STRATA_API_KEY: apiKey, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONHOME: "", PYTHONPATH: "" };
}

export async function strataCommand({ python, entry, cwd, env, args, invoke = execFileAsync, timeout = 30000 }) {
  let result;
  try { result = await invoke(python, [entry, ...args], { cwd, env, windowsHide: true, shell: false,
    timeout, maxBuffer: 1024 * 1024, encoding: "utf8" }); }
  catch { fail("sc117_strata_command_failed"); }
  if (result?.exitCode && result.exitCode !== 0) fail("sc117_strata_command_failed");
  let data;
  try { data = JSON.parse(result.stdout); } catch { fail("sc117_strata_invalid_response"); }
  if (data?.schema_version !== 1 || data.ok !== true) fail("sc117_strata_command_rejected");
  return data;
}

async function saveOwnedConfig(dir, config) {
  // Do not change an existing profile/config; a planned repair belongs to E.
  const parent = path.dirname(dir);
  await requiredDir(parent);
  const current = await lstat(dir).catch(error => error?.code === "ENOENT" ? null : fail("sc117_runtime_dir_unavailable"));
  if (!current) await mkdir(dir);
  else if (!current.isDirectory() || current.isSymbolicLink()) fail("sc117_runtime_dir_untrusted");
  const target = path.join(dir, "run-config.json");
  const expected = JSON.stringify(config, null, 2) + "\n";
  try { await writeFile(target, expected, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error?.code !== "EEXIST") fail("sc117_runtime_config_unavailable");
    await requiredFile(target);
    if (await readFile(target, "utf8") !== expected) fail("sc117_runtime_config_modified");
  }
  return target;
}

function ownedIdentity(doc) {
  if (doc?.state !== "ready" || !ID.test(doc.owner_id ?? "") || !ID.test(doc.instance_id ?? "")) fail("sc117_runtime_not_owned_or_ready");
  return { ownerId: doc.owner_id, instanceId: doc.instance_id };
}

export async function testSc117Inference({ approved = false, platform = process.platform, arch = process.arch,
  localAppData = process.env.LOCALAPPDATA, modelRoot = null, strataRoot = null,
  memoryBytes = os.totalmem(), invoke = execFileAsync, fetchImpl = fetch,
  getModelRoot = findSc117ReadyRoot, onStage = null } = {}) {
  if (!approved) fail("sc117_inference_owner_approval_required");
  if (platform !== "win32" || arch !== "x64") fail("sc117_inference_windows_x64_required");
  const roots = { modelRoot: modelRoot ?? await getModelRoot(), strataRoot: strataRoot ?? strataInstallRoot(localAppData) };
  const prepared = await validateSc117InferenceReady(roots);
  const config = sc117ServeConfig(prepared.modelRoot, memoryBytes);
  const cwd = path.dirname(prepared.entry);
  const apiKey = randomBytes(32).toString("hex");
  const env = pythonEnvironment(prepared.strataRoot, apiKey);
  const command = async (args, timeout) => strataCommand({ ...prepared, cwd, env, args, timeout, invoke });
  const before = await command(["runtime", "status", "--profile", PROFILE, "--output", "json"]);
  if (before.state !== "stopped") fail("sc117_runtime_already_active");
  const configFile = await saveOwnedConfig(path.join(prepared.modelRoot, "ktk-runtime"), config);
  const profiles = await command(["profile", "list", "--output", "json"]);
  if (!Array.isArray(profiles.profiles)) fail("sc117_profile_inventory_unavailable");
  if (profiles.profiles.some(p => p.id === PROFILE)) {
    const existing = await command(["profile", "show", PROFILE, "--output", "json"]);
    if (existing.profile?.source_config !== configFile) fail("sc117_existing_profile_unrecognized");
  } else await command(["profile", "create", PROFILE, "--from-config", configFile, "--output", "json"]);

  let identity;
  try {
    if (onStage) await onStage("starting");
    const started = await command(["runtime", "start", "--profile", PROFILE, "--wait", "900", "--shutdown-timeout", "30", "--output", "json"], 950000);
    identity = ownedIdentity(started);
  } catch {
    // If startup timed out after spawning a detached runtime, we must not
    // guess which process owns it. Block E must surface manual recovery.
    fail("sc117_runtime_start_unconfirmed_manual_attention_required");
  }
  let testError = null;
  let answer = null;
  try {
    if (onStage) await onStage("verifying");
    const current = await command(["runtime", "status", "--profile", PROFILE, "--output", "json"]);
    const owner = ownedIdentity(current);
    if (owner.ownerId !== identity.ownerId || owner.instanceId !== identity.instanceId) fail("sc117_runtime_identity_changed");
    const verified = await command(["runtime", "verify", "--profile", PROFILE,
      "--if-owner-id", identity.ownerId, "--if-instance-id", identity.instanceId, "--wait", "180", "--output", "json"], 210000);
    if (verified.readiness_state !== "generation_ready") fail("sc117_runtime_generation_not_ready");
    const origin = `http://127.0.0.1:${PORT}`;
    const headers = { Authorization: `Bearer ${apiKey}` };
    const health = await fetchImpl(`${origin}/health`, { headers, signal: AbortSignal.timeout(15000) });
    if (!health.ok || (await health.json())?.loaded !== true) fail("sc117_runtime_health_failed");
    const response = await fetchImpl(`${origin}/v1/chat/completions`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: PROFILE, messages: [{ role: "user", content: "Ответь одним словом: готово" }], max_tokens: 24, stream: false }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) fail("sc117_runtime_inference_failed");
    const completion = await response.json();
    answer = completion?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || answer.trim().length === 0) fail("sc117_runtime_inference_empty");
  } catch (error) { testError = error; }

  // Always stop our exact owner+instance after testing. Never stop an unknown
  // or newly replaced server. The engine is drained by Strata's own runtime.
  let stopped;
  try {
    if (onStage) await onStage("stopping");
    stopped = await command(["runtime", "stop", "--profile", PROFILE,
      "--if-owner-id", identity.ownerId, "--if-instance-id", identity.instanceId, "--wait", "120", "--output", "json"], 150000);
    if (stopped.state !== "stopped") fail("sc117_runtime_stop_unconfirmed");
  } catch { fail("sc117_runtime_stop_unconfirmed_manual_attention_required"); }
  if (testError) throw testError;
  if (onStage) await onStage("verified");
  return { status: "inference_verified_and_stopped", model: PROFILE, endpoint: `127.0.0.1:${PORT}`,
    health: "loaded", generation: "verified", response_received: Boolean(answer), inference_tested: true };
}
