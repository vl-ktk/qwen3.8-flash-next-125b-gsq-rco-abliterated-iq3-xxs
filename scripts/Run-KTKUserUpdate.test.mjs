import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkUserUpdateJob, verifyUserRelease, runUserUpdate } from "./Run-KTKUserUpdate.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const job = { schema: 1, version: "0.18.7", manifest_sha256: "a".repeat(64), attempt: "b".repeat(32) };
const local = "C:\\Users\\Vlad\\AppData\\Local";
const data = "C:\\ProgramData";

test("user updater accepts only fixed release metadata, no commands or paths", () => {
  assert.deepEqual(checkUserUpdateJob(job), job);
  for (const bad of [
    { ...job, command: "cmd.exe" }, { ...job, user: "Administrator" },
    { ...job, version: "0.18.7/../../" }, { ...job, attempt: "not-a-nonce" },
    { ...job, manifest_sha256: "a".repeat(63) },
  ]) assert.throws(() => checkUserUpdateJob(bad), /user_update_job_invalid/);
});

test("verified user release checks every file and refuses modified manifest or payload", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktk-user-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ["bin/node.exe", "Install-KTKStrata.mjs", "Prepare-KTKSC117.mjs", "runtime/strata-installer.mjs", "runtime/sc117-model.mjs", "runtime/sc117-model.lock.json", "runtime/strata-runtime.lock.json",
    ...Array.from({ length: 31 }, (_, index) => `runtime/file-${index}.mjs`)];
  const files = [];
  for (const name of names) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(`approved KTK file ${name}`);
    await writeFile(file, bytes);
    files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  const manifest = Buffer.from(JSON.stringify({ schema: 1, package_version: job.version, target: "windows-x64", ready_for_installation: false, files }));
  await writeFile(path.join(root, "MANIFEST.json"), manifest);
  const approved = { ...job, manifest_sha256: digest(manifest) };
  assert.equal((await verifyUserRelease(root, approved)).files.length, names.length);
  await assert.rejects(() => verifyUserRelease(root, { ...approved, manifest_sha256: "f".repeat(64) }), /user_update_manifest_checksum/);
  await writeFile(path.join(root, "runtime/file-4.mjs"), "modified by untrusted process");
  await assert.rejects(() => verifyUserRelease(root, approved), /user_update_entry_checksum/);
});

test("approved automatic user update only installs pinned files; never calls inference", async () => {
  const calls = [];
  const writes = [];
  const read = async file => file.endsWith("job.json") ? JSON.stringify(job) : Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
  const result = await runUserUpdate({ platform: "win32", localAppData: local, programData: data, read,
    verify: async (root, value) => { assert.equal(value.version, job.version); assert.match(root, /release-0\.18\.7$/); },
    invoke: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ status: calls.length === 1 ? "already_installed" : "already_prepared_not_rehashed" }) };
    },
    write: async (...args) => { writes.push(args); },
  });
  assert.deepEqual(result, { status: "user_components_prepared_no_inference", version: job.version, model_started: false });
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /release-0\.18\.7\\bin\\node\.exe$/);
  assert.match(calls[0][1][0], /release-0\.18\.7\\Install-KTKStrata\.mjs$/);
  assert.deepEqual(calls[0][1].slice(1), ["--install", "--installer-approved"]);
  assert.match(calls[1][1][0], /release-0\.18\.7\\Prepare-KTKSC117\.mjs$/);
  assert.deepEqual(calls[1][1].slice(1), ["--prepare", "--installer-approved"]);
  assert.ok(calls.every(call => !call[1].join(" ").includes("Install-KTKLocalAI")));
  assert.equal(calls[0][2].shell, false);
  assert.equal(writes.length, 1);
});

test("failed or ambiguous preparation cannot report update success", async () => {
  const writes = [];
  const read = async file => file.endsWith("job.json") ? JSON.stringify(job) : Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
  for (const responses of [["nonsense"], ['{"status":"installed"}', '{"status":"inference_verified_and_stopped"}']]) {
    let stage = 0;
    await assert.rejects(() => runUserUpdate({ platform: "win32", localAppData: local, programData: data, read,
      verify: async () => {},
      invoke: async () => ({ stdout: responses[stage++] }),
      write: async (...args) => { writes.push(args); },
    }), /user_update_local_ai_failed/);
  }
  assert.equal(writes.length, 0);
});

test("user task skips an already completed attempt and allows a new attempt", async () => {
  let invoked = 0;
  const result = await runUserUpdate({ platform: "win32", localAppData: local, programData: data,
    read: async file => file.endsWith("job.json") ? JSON.stringify(job) : JSON.stringify(job),
    invoke: async () => { invoked++; }, verify: async () => { invoked++; },
  });
  assert.equal(result.status, "user_components_already_verified");
  assert.equal(invoked, 0);
});

test("user updater is a no-op without an approved job and refuses SYSTEM profile", async () => {
  assert.deepEqual(await runUserUpdate({ platform: "win32", localAppData: local, programData: data,
    read: async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); } }), { status: "no_approved_user_update" });
  await assert.rejects(() => runUserUpdate({ platform: "win32", localAppData: "C:\\Windows\\System32\\config\\systemprofile", programData: data }), /user_update_interactive_profile_required/);
});
