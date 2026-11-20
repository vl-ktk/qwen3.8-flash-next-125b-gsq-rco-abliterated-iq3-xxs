import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import modelLock from "./sc117-model.lock.json" with { type: "json" };
import { findSc117ReadyRoot, sc117InferencePlan, sc117ResourceBudget,
  sc117ServeConfig, strataCommand, testSc117Inference, validateSc117InferenceReady } from "./sc117-inference.mjs";

const id1 = "a".repeat(32), id2 = "b".repeat(32);
const report = (fields = {}) => ({ stdout: JSON.stringify({ schema_version: 1, ok: true, ...fields }) });

async function fixture(t) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "ktk-inference-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const modelRoot = path.join(sandbox, "model"), strataRoot = path.join(sandbox, "strata");
  const make = async (name, data = "fixture") => {
    await mkdir(path.dirname(name), { recursive: true });
    await writeFile(name, data);
  };
  await make(path.join(strataRoot, "ktk-strata-install.json"), JSON.stringify({ schema: 1, status: "ready", version: "0.2.17", engine: { backend: "cuda" } }));
  await make(path.join(modelRoot, "ktk-sc117-install.json"), JSON.stringify({ schema: 1, status: "ready", revision: modelLock.revision, quantization: "IQ3_XXS", nonce: "d".repeat(32) }));
  await make(path.join(strataRoot, "terminal", "current", "python", "python.exe"));
  await make(path.join(strataRoot, "terminal", "current", "strata.py"));
  for (const file of modelLock.files) await make(file.path.startsWith("IQ3_XXS/")
    ? path.join(modelRoot, ...file.path.split("/")) : path.join(modelRoot, "mtp", "rt", path.basename(file.path)));
  for (const file of ["native_experts.txt", "index.txt", "dense.bin", "tokenizer/vocab.json", "tokenizer/chat_template.jinja"])
    await make(path.join(modelRoot, "pack", file));
  return { modelRoot, strataRoot, sandbox };
}

test("Block D --plan is read-only, loopback, offline and bounded", () => {
  const plan = sc117InferencePlan();
  assert.equal(plan.status, "planned_no_changes");
  assert.equal(plan.endpoint, "http://127.0.0.1:18764");
  assert.deepEqual(plan.concurrency, { parallel: 1, max_queue: 0 });
  const cfg = sc117ServeConfig(path.resolve("fixture"), 64 * 2 ** 30);
  assert.equal(cfg.exe, "component:strata-engine");
  assert.equal(cfg.offline, true);
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.parallel, 1);
  assert.equal(cfg.max_queue, 0);
  assert.equal(cfg.args[cfg.args.indexOf("--resident-budget-gib") + 1], "40");
  assert.equal(cfg.args[cfg.args.indexOf("--vram-reserve-mib") + 1], "2048");
  assert.equal(cfg.args[cfg.args.indexOf("--max-context") + 1], "8192");
  assert.match(cfg.args[cfg.args.indexOf("--ple-gguf") + 1], /00002-of-00002\.gguf$/);
  assert.equal(cfg.model_name, "ktk-sc117-iq3xxs");
  assert.equal(cfg.args.includes("--mtp"), true);
});

test("memory budget retains RAM headroom even on smaller systems", () => {
  assert.equal(sc117ResourceBudget(48 * 2 ** 30).resident_gib, 24);
  assert.equal(sc117ResourceBudget(64 * 2 ** 30).resident_gib, 40);
  assert.equal(sc117ResourceBudget(128 * 2 ** 30).resident_gib, 40);
  assert.throws(() => sc117ResourceBudget(31 * 2 ** 30), /ram_insufficient/);
  assert.throws(() => sc117ResourceBudget(NaN), /ram_unknown/);
});

test("readiness validates KTK markers and pinned physical files, no weights are read", async t => {
  const f = await fixture(t);
  assert.equal((await validateSc117InferenceReady(f)).modelRoot, f.modelRoot);
  assert.equal(await findSc117ReadyRoot({ roots: [path.join(f.sandbox, "nonexistent"), f.modelRoot] }), f.modelRoot);
  await assert.rejects(findSc117ReadyRoot({ roots: [path.join(f.sandbox, "nonexistent")] }), /model_not_prepared/);
  await writeFile(path.join(f.modelRoot, "ktk-sc117-install.json"), JSON.stringify({ status: "downloading" }));
  await assert.rejects(validateSc117InferenceReady(f), /model_not_ready/);
});

test("symlinked model shard rejected without running the engine", async t => {
  const f = await fixture(t);
  const shard = path.join(f.modelRoot, ...modelLock.files[0].path.split("/"));
  await rm(shard);
  await symlink(path.join(f.modelRoot, "pack", "dense.bin"), shard);
  await assert.rejects(validateSc117InferenceReady(f), /file_missing_or_untrusted/);
});

test("never start without local approval and native Windows", async t => {
  const f = await fixture(t);
  const invoke = async () => { throw Error("command should never run"); };
  await assert.rejects(testSc117Inference({ ...f, platform: "win32", arch: "x64", invoke }), /owner_approval_required/);
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "linux", arch: "x64", invoke }), /windows_x64_required/);
});

function runtimeMock({ existing = false, verifyFails = false, ownerChanges = false, stopFails = false,
  alreadyRunning = false, startIncomplete = false } = {}) {
  const calls = [];
  const invoke = async (python, args, options) => {
    const words = args.slice(1);
    calls.push({ words, options });
    assert.equal(path.basename(python), "python.exe");
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.STRATA_API_KEY.length, 64);
    const [family, action] = words;
    if (family === "runtime" && action === "status") {
      const n = calls.filter(x => x.words[0] === "runtime" && x.words[1] === "status").length;
      return n === 1 && !alreadyRunning ? report({ state: "stopped" }) : report({ state: "ready", owner_id: ownerChanges ? "c".repeat(32) : id1, instance_id: id2 });
    }
    if (family === "profile" && action === "list") return report({ profiles: existing ? [{ id: "ktk-sc117-iq3xxs" }] : [] });
    if (family === "profile" && action === "create") return report({ profile: { id: "ktk-sc117-iq3xxs" } });
    if (family === "profile" && action === "show") return report({ profile: { source_config: "wrong" } });
    if (family === "runtime" && action === "start") return startIncomplete ? report({ state: "starting" }) : report({ state: "ready", owner_id: id1, instance_id: id2 });
    if (family === "runtime" && action === "verify") return verifyFails ? report({ readiness_state: "unloaded" }) : report({ readiness_state: "generation_ready" });
    if (family === "runtime" && action === "stop") return report({ state: stopFails ? "failed" : "stopped" });
    throw Error("Unexpected CLI invocation: " + words.join(" "));
  };
  return { invoke, calls };
}

test("offline mocked lifecycle: prepare config, start, own, health, inference, exact-stop", async t => {
  const f = await fixture(t), mock = runtimeMock();
  const requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith("/health")) return new Response(JSON.stringify({ loaded: true }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "готово" } }] }), { status: 200 });
  };
  const result = await testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock, fetchImpl });
  assert.equal(result.status, "inference_verified_and_stopped");
  assert.equal(result.inference_tested, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:18764/health");
  assert.equal(requests[1].url, "http://127.0.0.1:18764/v1/chat/completions");
  assert.equal(requests[1].opts.method, "POST");
  assert.equal(JSON.parse(requests[1].opts.body).max_tokens, 24);
  const started = mock.calls.find(x => x.words.slice(0, 2).join(" ") === "runtime start");
  assert.equal(started.words.includes("--wait"), true);
  const stop = mock.calls.at(-1);
  assert.deepEqual(stop.words, ["runtime", "stop", "--profile", "ktk-sc117-iq3xxs", "--if-owner-id", id1, "--if-instance-id", id2, "--wait", "120", "--output", "json"]);
  const cfg = JSON.parse(await readFile(path.join(f.modelRoot, "ktk-runtime", "run-config.json"), "utf8"));
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.offline, true);
  assert.equal(cfg.args.includes("--native"), true);
});

test("failed generation still stops the exact owned instance", async t => {
  const f = await fixture(t), mock = runtimeMock({ verifyFails: true });
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock }), /generation_not_ready/);
  assert.equal(mock.calls.at(-1).words[1], "stop");
});

test("changed runtime identity blocks requests and stops only original identity", async t => {
  const f = await fixture(t), mock = runtimeMock({ ownerChanges: true });
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock }), /identity_changed/);
  assert.equal(mock.calls.at(-1).words[1], "stop");
  assert.equal(mock.calls.at(-1).words.includes(id1), true);
});

test("stop refusal is reported, never falsely claim a clean shutdown", async t => {
  const f = await fixture(t), mock = runtimeMock({ verifyFails: true, stopFails: true });
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock }), /manual_attention_required/);
});

test("unknown previous profile is never overwritten or started", async t => {
  const f = await fixture(t), mock = runtimeMock({ existing: true });
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock }), /existing_profile_unrecognized/);
  assert.equal(mock.calls.some(c => c.words[1] === "start"), false);
});

test("existing active runtime refuses to start or alter its profile", async t => {
  const f = await fixture(t), mock = runtimeMock({ alreadyRunning: true });
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock }), /already_active/);
  assert.equal(mock.calls.length, 1);
});

test("incomplete asynchronous startup is never declared ready", async t => {
  const f = await fixture(t), mock = runtimeMock({ startIncomplete: true });
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock }), /start_unconfirmed_manual_attention_required/);
});

test("failed health reports failure and still stops the owned service", async t => {
  const f = await fixture(t), mock = runtimeMock();
  await assert.rejects(testSc117Inference({ ...f, approved: true, platform: "win32", arch: "x64", memoryBytes: 64 * 2 ** 30, ...mock,
    fetchImpl: async () => new Response(JSON.stringify({ loaded: false })) }), /health_failed/);
  assert.equal(mock.calls.at(-1).words[1], "stop");
});

test("Strata response must be valid JSON and indicate success", async () => {
  const run = async invoke => strataCommand({ python: "python.exe", entry: "strata.py", cwd: ".", env: {}, args: ["runtime", "status"], invoke });
  await assert.rejects(run(async () => ({ stdout: "oops" })), /invalid_response/);
  await assert.rejects(run(async () => report({ ok: false })), /command_rejected/);
  await assert.rejects(run(async () => { throw Error("failed"); }), /command_failed/);
});
