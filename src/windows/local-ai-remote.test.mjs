import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callLocalUpdater, createUpdaterServer } from "./remote-update.mjs";
import { createLocalAiRemoteController, inspectKtkUserTask, queueKtkLocalAiJob,
  validateLocalAiConfirm, validateLocalAiJob, validateLocalAiPrepare } from "./local-ai-remote.mjs";

const id = "a".repeat(32);
const ready = () => ({ user_task_trusted: true, job_status: "not_running", installation_status: "not_started" });

test("local AI arguments never accept an exe, path, URL or unconfirmed job", () => {
  assert.deepEqual(validateLocalAiPrepare({ operation: "prepare" }), { operation: "prepare" });
  for (const args of [{ operation: "launch" }, { operation: "prepare", path: "C:\\Windows" }, {}, null])
    assert.throws(() => validateLocalAiPrepare(args), /local_ai_invalid_operation/);
  assert.deepEqual(validateLocalAiConfirm({ plan_id: id, confirmation: `CONFIRM KTK LOCAL AI ${id}` }).plan_id, id);
  for (const args of [{ plan_id: id, confirmation: "yes" }, { plan_id: id, confirmation: `CONFIRM KTK LOCAL AI ${id}`, shell: "cmd" }])
    assert.throws(() => validateLocalAiConfirm(args), /local_ai_owner_confirmation_required/);
  assert.throws(() => validateLocalAiJob({ schema: 1, action: "prepare", attempt: id, created_at: 0, expires_at: 10 }, 11), /expired/);
});

test("confirmation is operation-bound, five minutes, single-use and never starts model", async () => {
  let clock = 1000, queued = [];
  const controller = createLocalAiRemoteController({ now: () => clock, newId: () => id,
    inspect: async () => ready(), queue: async job => { queued.push(job); return { status: "queued" }; } });
  const plan = await controller.preview({ operation: "prepare" });
  assert.equal(plan.status, "ready_for_owner_confirmation");
  assert.equal(plan.requires_pc_confirmation, false);
  assert.equal(plan.expected_download_bytes, 76966598276);
  const confirmation = { plan_id: plan.plan_id, confirmation: plan.owner_chat_confirmation };
  await assert.rejects(() => controller.repair(confirmation), /mismatch/);
  await assert.rejects(() => controller.install(confirmation), /mismatch/);
  const plan2 = await controller.preview({ operation: "prepare" });
  const result = await controller.install({ plan_id: plan2.plan_id, confirmation: plan2.owner_chat_confirmation });
  assert.equal(result.status, "queued");
  assert.equal(result.local_model_started, false);
  assert.equal(queued.length, 1);
  assert.deepEqual(Object.keys(queued[0]).sort(), ["action", "attempt", "created_at", "expires_at", "schema"]);
  await assert.rejects(() => controller.install(confirmation), /mismatch/);
  const plan3 = await controller.preview({ operation: "repair" });
  clock += 300001;
  await assert.rejects(() => controller.repair({ plan_id: plan3.plan_id, confirmation: plan3.owner_chat_confirmation }), /expired/);
  assert.equal(queued.length, 1);
});

test("untrusted Windows user task blocks remote model preparation", async () => {
  const controller = createLocalAiRemoteController({ inspect: async () => ({ user_task_trusted: false }) });
  assert.equal((await controller.preview({ operation: "prepare" })).status, "blocked");
  const trusted = await inspectKtkUserTask({ invokeCommand: async () => ({ stdout: JSON.stringify(ready()) }) });
  assert.equal(trusted.user_task_trusted, true);
  assert.equal(trusted.installation_status, "not_started");
  const unsafe = await inspectKtkUserTask({ invokeCommand: async () => ({ stdout: JSON.stringify({ user_task_trusted: true, installation_status: "anything" }) }) });
  assert.equal(unsafe.user_task_trusted, false);
});

test("SYSTEM queues only a validated fixed user task job in pre-existing protected folder", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-local-ai-queue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "public"));
  const job = { schema: 1, action: "prepare", attempt: id, created_at: Date.now() - 10, expires_at: Date.now() + 60000 };
  let execution;
  const outcome = await queueKtkLocalAiJob(job, { dataRoot: dir, invokeCommand: async (file, args, options) => {
    execution = { file, args, options };
  } });
  assert.equal(outcome.status, "queued");
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "public", "local-ai-job.json"))), job);
  assert.deepEqual(execution.args, ["/run", "/tn", "KTKQwenUserUpdater"]);
  assert.equal(execution.options.shell, false);
  await assert.rejects(() => queueKtkLocalAiJob({ ...job, action: "powershell" }, { dataRoot: dir }), /invalid/);
  await assert.rejects(() => queueKtkLocalAiJob(job, { dataRoot: path.join(dir, "missing") }), /missing/);
});

test("loopback signed Stage 3 API separates previews, confirmations, status and replay", async t => {
  const keyText = randomBytes(32).toString("base64url");
  const controller = createLocalAiRemoteController({ inspect: async () => ready(), queue: async () => ({ status: "queued" }) });
  const server = createUpdaterServer({ keyText, port: 0, dataRoot: os.tmpdir(), pcLocalAi: controller });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/local-ai/status`)).status, 403);
  assert.equal((await callLocalUpdater("local_ai_status", null, { keyText, port })).model_loaded, "unknown");
  const plan = await callLocalUpdater("local_ai_preview", { operation: "prepare" }, { keyText, port });
  assert.equal(plan.status, "ready_for_owner_confirmation");
  const result = await callLocalUpdater("local_ai_install", { plan_id: plan.plan_id, confirmation: plan.owner_chat_confirmation }, { keyText, port });
  assert.equal(result.status, "queued");
  await assert.rejects(() => callLocalUpdater("local_ai_install", { plan_id: plan.plan_id, confirmation: plan.owner_chat_confirmation }, { keyText, port }), /updater_unavailable/);
});
