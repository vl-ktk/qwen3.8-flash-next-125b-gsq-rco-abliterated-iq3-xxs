#!/usr/bin/env node
// Runs only as the signed-in Windows user through the fixed KTK Task Scheduler
// task. No elevation, generic command runner, or caller-controlled file path.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const exec = promisify(execFile);
const VERSION = /^0\.18\.[1-9]\d{0,3}$/;
const HEX = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,180}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function checkUserUpdateJob(job) {
  if (!job || Array.isArray(job) || typeof job !== "object" ||
      Object.keys(job).sort().join() !== "attempt,manifest_sha256,schema,version" ||
      job.schema !== 1 || typeof job.version !== "string" || !VERSION.test(job.version) ||
      typeof job.attempt !== "string" || !/^[a-f0-9]{32}$/.test(job.attempt) ||
      typeof job.manifest_sha256 !== "string" || !HEX.test(job.manifest_sha256)) fail("user_update_job_invalid");
  return job;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyUserRelease(root, job, { read = readFile, inspect = lstat, hashFile = sha256File } = {}) {
  checkUserUpdateJob(job);
  const manifestPath = path.join(root, "MANIFEST.json");
  const manifestStat = await inspect(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail("user_update_manifest_untrusted");
  const bytes = await read(manifestPath);
  if (createHash("sha256").update(bytes).digest("hex") !== job.manifest_sha256) fail("user_update_manifest_checksum");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("user_update_manifest_invalid"); }
  if (manifest.schema !== 1 || manifest.package_version !== job.version || manifest.target !== "windows-x64" ||
      manifest.ready_for_installation !== false || !Array.isArray(manifest.files) || manifest.files.length < 30 || manifest.files.length > 100) fail("user_update_manifest_invalid");
  const seen = new Set();
  for (const item of manifest.files) {
    if (typeof item?.path !== "string" || !SAFE_PATH.test(item.path) || item.path.split("/").includes("..") || item.path.includes("//") ||
        typeof item.sha256 !== "string" || !HEX.test(item.sha256) || seen.has(item.path)) fail("user_update_entry_invalid");
    seen.add(item.path);
    const parts = item.path.split("/");
    let part = root;
    for (const component of parts.slice(0, -1)) {
      part = path.join(part, component);
      const dir = await inspect(part);
      if (!dir.isDirectory() || dir.isSymbolicLink()) fail("user_update_entry_untrusted");
    }
    const file = path.join(root, ...parts);
    const info = await inspect(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== item.bytes || await hashFile(file) !== item.sha256) fail("user_update_entry_checksum");
  }
  for (const required of ["bin/node.exe", "Install-KTKLocalAI.mjs", "runtime/local-ai-setup.mjs", "runtime/sc117-model.lock.json", "runtime/strata-runtime.lock.json"]) {
    if (!seen.has(required)) fail("user_update_incomplete_release");
  }
  return manifest;
}

export async function runUserUpdate({ platform = process.platform, localAppData = process.env.LOCALAPPDATA,
  programData = process.env.ProgramData, invoke = exec, read = readFile,
  verify = verifyUserRelease, write = writeFile } = {}) {
  if (platform !== "win32" || !localAppData || !programData ||
      /\\Windows\\(?:ServiceProfiles|System32\\config\\systemprofile)/i.test(localAppData)) fail("user_update_interactive_profile_required");
  const publicDir = path.win32.join(programData, "KTK", "Updater", "public");
  let raw;
  try { raw = await read(path.win32.join(publicDir, "job.json"), "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { status: "no_approved_user_update" };
    fail("user_update_job_unavailable");
  }
  let job;
  try { job = checkUserUpdateJob(JSON.parse(raw)); } catch { fail("user_update_job_invalid"); }
  const completed = path.win32.join(localAppData, "KTK", "UserUpdater", "last-success.json");
  try {
    const previous = JSON.parse(await read(completed, "utf8"));
    if (previous.attempt === job.attempt && previous.version === job.version && previous.manifest_sha256 === job.manifest_sha256)
      return { status: "user_components_already_verified", version: job.version };
  } catch { /* No completed transaction yet: retry the approved release. */ }
  const root = path.win32.join(publicDir, `release-${job.version}`);
  await verify(root, job);
  const command = path.win32.join(root, "bin", "node.exe");
  const script = path.win32.join(root, "Install-KTKLocalAI.mjs");
  try {
    await invoke(command, [script, "--install", "--installer-approved"], {
      shell: false, windowsHide: true, cwd: root, timeout: 24 * 60 * 60 * 1000,
      maxBuffer: 16 * 1024, env: { ...process.env, QWEN_MCP_GATEWAY_KEY: "", QWEN_DEVICE_IDENTITY_PATH: "" },
    });
  } catch { fail("user_update_local_ai_failed"); }
  await write(completed, JSON.stringify(job) + "\n", { mode: 0o600 });
  return { status: "user_components_verified", version: job.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.platform === "win32") {
  runUserUpdate().then(result => process.stdout.write(JSON.stringify(result) + "\n"), error => {
    process.stderr.write(JSON.stringify({ status: "failed", code: error?.code || "user_update_failed" }) + "\n");
    process.exitCode = 1;
  });
}
