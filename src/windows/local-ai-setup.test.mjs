import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertLocalAiHardware, localAiSetupPlan, runLocalAiSetup } from "./local-ai-setup.mjs";

const GIB = 2 ** 30;
const inventory = async () => ({
  pc: { os: { architecture: "AMD64" }, ram: { total_bytes: 64 * GIB }, gpu: { status: "ok", gpus: [{ vram_total_bytes: 23 * GIB }] } },
  storage: { volumes: [{ drive: "D:", free_bytes: 140_000_000_000 }] },
});

async function fixture(t, overrides = {}) {
  const statusDir = await mkdtemp(path.join(os.tmpdir(), "ktk-setup-test-"));
  t.after(() => rm(statusDir, { recursive: true, force: true }));
  const calls = [];
  const defaults = {
    approved: true, platform: "win32", arch: "x64", statusDir, inventory,
    acquireLock: async () => { calls.push("lock"); return async () => { calls.push("unlock"); }; },
    installRuntime: async ({ onStage }) => { calls.push("strata"); await onStage("installing_cuda_engine"); return { status: "installed" }; },
    prepareModel: async ({ onStage, onProgress }) => {
      calls.push("model");
      await onStage("downloading", { file_index: 1, files_total: 6 });
      await onProgress({ bytes_done: 50, bytes_total: 100, file_index: 1, files_total: 6 });
      await onStage("packing");
      await onStage("prepared");
      return { status: "prepared_for_inference_test", root: "D:\\KTK\\Models\\SC117-IQ3_XXS" };
    },
    testInference: async ({ modelRoot, onStage }) => {
      assert.equal(modelRoot, "D:\\KTK\\Models\\SC117-IQ3_XXS");
      calls.push("inference");
      await onStage("verified");
      return { status: "inference_verified_and_stopped", inference_tested: true };
    },
    timeNow: () => 5000,
  };
  return { opts: { ...defaults, ...overrides }, calls, statusDir };
}

test("read-only combined plan shows all five stages and retry behavior", () => {
  const plan = localAiSetupPlan();
  assert.equal(plan.status, "planned_no_changes");
  assert.equal(plan.phases.length, 5);
  assert.equal(plan.interactive_user_required, true);
  assert.equal(plan.requires_explicit_installer_approval, true);
  assert.match(plan.result_report, /LocalAI\\result\.json$/);
});

test("preflight tolerates actual 3090 Ti VRAM reporting but refuses unknown device", async () => {
  const valid = await inventory();
  assert.deepEqual(assertLocalAiHardware(valid.pc, valid.storage), { ram_gib: 64, gpu: "nvidia_20gib_or_more", disks_detected: true });
  assert.throws(() => assertLocalAiHardware({ ...valid.pc, ram: { total_bytes: 31 * GIB } }, valid.storage), /ram_below/);
  assert.throws(() => assertLocalAiHardware({ ...valid.pc, gpu: { status: "unavailable", gpus: [] } }, valid.storage), /nvidia_20gib_unverified/);
  assert.throws(() => assertLocalAiHardware({ ...valid.pc, os: { architecture: "x86" } }, valid.storage), /windows_x64_unverified/);
  assert.throws(() => assertLocalAiHardware(valid.pc, { volumes: [{ drive: "Z:", free_bytes: 100 }] }), /fixed_disk_unverified/);
});

test("one action runs A>B>C>D and records success with no credentials", async t => {
  const f = await fixture(t);
  const result = await runLocalAiSetup(f.opts);
  assert.equal(result.status, "passed");
  assert.equal(result.inference_verified, true);
  assert.deepEqual(f.calls, ["lock", "strata", "model", "inference", "unlock"]);
  const json = await readFile(path.join(f.statusDir, "status.json"), "utf8");
  const final = JSON.parse(json);
  assert.equal(final.phase, "complete");
  assert.equal(final.percent, 100);
  const report = JSON.parse(await readFile(path.join(f.statusDir, "result.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.inference_verified, true);
  assert.doesNotMatch(json + JSON.stringify(report), /api_key|authorization|password|secret/i);
});

test("no approval or wrong OS refuses before acquiring lock or writing", async t => {
  const f = await fixture(t);
  await assert.rejects(runLocalAiSetup({ ...f.opts, approved: false }), /approval_required/);
  await assert.rejects(runLocalAiSetup({ ...f.opts, platform: "linux" }), /windows_x64_required/);
  assert.deepEqual(f.calls, []);
});

test("preflight failure leaves no Strata/model files and writes retry report", async t => {
  const f = await fixture(t, { inventory: async () => ({ pc: { os: { architecture: "x86" } }, storage: { volumes: [] } }) });
  await assert.rejects(runLocalAiSetup(f.opts), /windows_x64_unverified/);
  assert.deepEqual(f.calls, ["lock", "unlock"]);
  const report = JSON.parse(await readFile(path.join(f.statusDir, "result.json"), "utf8"));
  assert.deepEqual({ status: report.status, phase: report.phase, code: report.code, retry: report.retry },
    { status: "failed", phase: "preflight", code: "localai_windows_x64_unverified", retry: "rerun_same_setup_exe" });
});

test("model failure preserves artifact retry semantics and does not launch inference", async t => {
  const f = await fixture(t, { prepareModel: async () => { f.calls.push("model"); throw Object.assign(Error("broken"), { code: "sc117_download_interrupted" }); } });
  await assert.rejects(runLocalAiSetup(f.opts), /sc117_download_interrupted/);
  assert.deepEqual(f.calls, ["lock", "strata", "model", "unlock"]);
  const report = JSON.parse(await readFile(path.join(f.statusDir, "result.json"), "utf8"));
  assert.equal(report.phase, "model");
  assert.equal(report.retained, "verified_artifacts");
});

test("inference failure refuses to declare ready and releases session lock", async t => {
  const f = await fixture(t, { testInference: async () => { f.calls.push("inference"); throw Object.assign(Error("not ready"), { code: "sc117_runtime_generation_not_ready" }); } });
  await assert.rejects(runLocalAiSetup(f.opts), /generation_not_ready/);
  assert.deepEqual(f.calls, ["lock", "strata", "model", "inference", "unlock"]);
  const report = JSON.parse(await readFile(path.join(f.statusDir, "result.json"), "utf8"));
  assert.equal(report.phase, "inference");
  assert.equal(report.status, "failed");
});

test("one-click retry accepts existing installed runtime and already-prepared model", async t => {
  const f = await fixture(t, {
    installRuntime: async () => { f.calls.push("strata"); return { status: "already_installed" }; },
    prepareModel: async () => { f.calls.push("model"); return { status: "already_prepared_not_rehashed", root: "D:\\KTK\\Models\\SC117-IQ3_XXS" }; },
  });
  assert.equal((await runLocalAiSetup(f.opts)).status, "passed");
  assert.deepEqual(f.calls, ["lock", "strata", "model", "inference", "unlock"]);
});

test("unknown response from a phase fails closed rather than reporting a false pass", async t => {
  const f = await fixture(t, { testInference: async () => ({ status: "error", inference_tested: false }) });
  await assert.rejects(runLocalAiSetup(f.opts), /inference_not_verified/);
  const report = JSON.parse(await readFile(path.join(f.statusDir, "result.json"), "utf8"));
  assert.equal(report.status, "failed");
});
