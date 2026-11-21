import test from "node:test";
import assert from "node:assert/strict";
import { runLocalAiUserJob } from "./Run-KTKLocalAIJob.mjs";

const id = "a".repeat(32);
const job = { schema: 1, action: "prepare", attempt: id, created_at: 1000, expires_at: 2000 };
const enoent = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const stub = ({ data = job, preflight = async () => {}, install = async () => ({ status: "installed" }),
  prepare = async () => ({ status: "prepared_for_inference_test" }), readMarker = null } = {}) => {
  const writes = [], calls = [];
  const run = () => runLocalAiUserJob({ platform: "win32", arch: "x64", localAppData: "C:\\Users\\Owner\\AppData\\Local",
    programData: "C:\\ProgramData", now: () => 1500,
    read: async file => { if (file.endsWith("local-ai-job.json")) return JSON.stringify(data);
      if (file.endsWith("ktk-strata-install.json") && readMarker) return JSON.stringify(readMarker);
      throw enoent(); },
    write: async (file, content) => { writes.push({ file, payload: JSON.parse(content) }); },
    inspect: async () => { throw enoent(); }, makeDir: async () => {},
    acquireLock: async () => async () => { calls.push("unlock"); },
    preflight: async () => { calls.push("preflight"); return preflight(); },
    install: async options => { calls.push("install"); assert.equal(options.ownerApproved, true); return install(options); },
    prepare: async options => { calls.push("prepare"); assert.equal(options.approved, true); return prepare(options); } });
  return { run, writes, calls };
};

test("user job refuses expired, altered and missing approval without install", async () => {
  const missing = stub();
  const bad = stub({ data: { ...job, command: "cmd.exe" } });
  await assert.rejects(bad.run(), /invalid_or_expired/);
  assert.equal(bad.calls.length, 0);
  const old = stub({ data: { ...job, expires_at: 1499 } });
  await assert.rejects(old.run(), /invalid_or_expired/);
  assert.equal(old.calls.length, 0);
  const ready = await missing.run();
  assert.equal(ready.status, "files_prepared_no_inference");
  assert.equal(ready.model_started, false);
  assert.deepEqual(missing.calls, ["preflight", "install", "prepare", "unlock"]);
  assert.equal(missing.writes.some(x => x.payload.status === "completed"), true);
});

test("repair does not erase a ready Strata installation; failed preflight does not download", async () => {
  const fixture = stub({ data: { ...job, action: "repair" }, readMarker: { status: "ready" } });
  assert.equal((await fixture.run()).status, "files_prepared_no_inference");
  const broken = stub({ preflight: async () => { throw Object.assign(new Error("no GPU"), { code: "sc117_cuda_missing" }); } });
  await assert.rejects(() => broken.run(), /sc117_cuda_missing/);
  assert.deepEqual(broken.calls, ["preflight", "unlock"]);
  assert.equal(broken.writes.some(x => x.payload.status === "failed"), true);
});
