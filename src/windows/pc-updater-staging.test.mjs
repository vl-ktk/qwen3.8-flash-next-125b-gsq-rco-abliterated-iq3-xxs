import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKtkStageAdapter, markKtkUpdateStage } from "./pc-updater-staging.mjs";
import { createPcMaintenanceController } from "./pc-maintenance.mjs";

const HOUR = 60 * 60 * 1000;

test("stage quarantine is HMAC-owned, opt-in, read-only in preview and exactly reversible", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktk-stage-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyText = randomBytes(32).toString("base64url");
  let clock = 100 * HOUR;
  const now = () => clock;
  const staging = createKtkStageAdapter({ dataRoot: root, keyText, now });
  const target = path.join(root, "update-aB092f");
  await mkdir(target);
  await markKtkUpdateStage(target, keyText, now());
  await writeFile(path.join(target, "artifact.zip"), Buffer.from("fake-zip"));
  // Fresh staging must never be touched by maintenance, even with owner signature.
  assert.equal((await staging.inspectCandidate()).candidate, null);
  clock += 25 * HOUR;
  const candidate = (await staging.inspectCandidate()).candidate;
  assert.deepEqual({ name: candidate.name, bytes: candidate.bytes, stale: candidate.stale },
    { name: "update-aB092f", bytes: 8, stale: true });
  let receipt = null;
  const controller = createPcMaintenanceController({
    queryService: async () => ({ name: "KTKQwenTunnel", status: "Stopped", start_type: "Manual", owner_verified: true }),
    startService: async () => {}, stopService: async () => {}, staging,
    readReceipt: async () => receipt, writeReceipt: async item => { receipt = { ...item }; }, now,
  });
  const planned = await controller.preview({ action: "quarantine_ktk_staging" });
  assert.equal(planned.status, "ready_for_owner_confirmation");
  assert.equal(planned.staging_name, candidate.name);
  assert.equal(planned.estimated_freed_bytes, 0);
  assert.equal(planned.requires_pc_confirmation, false);
  assert.deepEqual((await readdir(target)).sort(), ["artifact.zip", "ktk-stage-owner.json"]);
  await assert.rejects(controller.apply({ plan_id: planned.plan_id, confirmation: "YES" }), /maintenance_owner_confirmation_required/);
  assert.equal((await controller.apply({ plan_id: planned.plan_id, confirmation: planned.owner_chat_confirmation })).status, "applied");
  assert.equal((await controller.status()).rollback_available, true);
  assert.equal((await staging.inspect(candidate.name, "active")), null);
  assert.equal((await staging.inspect(candidate.name, "quarantine")).bytes, 8);
  assert.equal((await controller.preview({ action: "quarantine_ktk_staging" })).reason, "previous_maintenance_active");
  const undo = await controller.preview({ action: "restore_ktk_staging" });
  assert.equal((await controller.apply({ plan_id: undo.plan_id, confirmation: undo.owner_chat_confirmation })).status, "rolled_back");
  assert.equal((await staging.inspect(candidate.name, "active")).bytes, 8);
  assert.equal((await controller.status()).rollback_available, false);
});

test("unmarked, forged, unknown, symlinked, stale-looking and crowded KTK staging never gets moved", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktk-stage-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyText = randomBytes(32).toString("base64url");
  const earlier = 10 * HOUR;
  const staging = createKtkStageAdapter({ dataRoot: root, keyText, now: () => earlier + 25 * HOUR });
  await mkdir(path.join(root, "update-123abc"));
  await writeFile(path.join(root, "update-123abc", "artifact.zip"), "foreign");
  const forged = path.join(root, "update-123aBc");
  await mkdir(forged);
  await markKtkUpdateStage(forged, keyText, earlier);
  const marker = JSON.parse(await readFile(path.join(forged, "ktk-stage-owner.json"), "utf8"));
  await writeFile(path.join(forged, "ktk-stage-owner.json"), JSON.stringify({ ...marker, signature: "f".repeat(64) }));
  await mkdir(path.join(root, "update-2G4aAb"));
  await markKtkUpdateStage(path.join(root, "update-2G4aAb"), keyText, earlier);
  await writeFile(path.join(root, "update-2G4aAb", "other-user.txt"), "do not touch");
  const src = path.join(root, "update-linkaa");
  await symlink(forged, src, process.platform === "win32" ? "junction" : "dir");
  const audit = await staging.inspectCandidate();
  assert.equal(audit.candidate, null);
  assert.equal(audit.scanned, 4);
  assert.equal(audit.rejected, 4);
  assert.deepEqual((await readdir(forged)).sort(), ["ktk-stage-owner.json"]);
  await assert.rejects(staging.quarantine("update-123abc"), /maintenance_stage_untrusted/);
  await assert.rejects(staging.quarantine("update-linkaa"), /maintenance_stage_untrusted/);
  await assert.rejects(staging.quarantine("../escape"), /maintenance_stage_untrusted/);
  assert.equal((await staging.inspectCandidate()).candidate, null);
});

test("interrupted after atomic quarantine is recoverable from pending receipt without deleting bytes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktk-stage-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyText = randomBytes(32).toString("base64url");
  const original = createKtkStageAdapter({ dataRoot: root, keyText, now: () => 96 * HOUR });
  const folder = path.join(root, "update-ABC123");
  await mkdir(folder);
  await markKtkUpdateStage(folder, keyText, 10 * HOUR);
  await writeFile(path.join(folder, "artifact.zip"), "preserved");
  let receipt = null;
  let interrupt = true;
  const makeController = () => createPcMaintenanceController({
    staging: {
      ...original,
      quarantine: async name => { await original.quarantine(name); if (interrupt) throw Error("simulated updater crash"); },
    },
    queryService: async () => ({ name: "KTKQwenTunnel", status: "Stopped", start_type: "Manual", owner_verified: true }),
    startService: async () => {}, stopService: async () => {},
    readReceipt: async () => receipt, writeReceipt: async item => { receipt = { ...item }; },
  });
  const controller = makeController();
  const plan = await controller.preview({ action: "quarantine_ktk_staging" });
  await assert.rejects(controller.apply({ plan_id: plan.plan_id, confirmation: plan.owner_chat_confirmation }), /simulated updater crash/);
  assert.equal(receipt.status, "pending");
  assert.equal((await original.inspect("update-ABC123", "quarantine")).bytes, 9);
  interrupt = false;
  const restarted = makeController();
  const recover = await restarted.preview({ action: "restore_ktk_staging" });
  assert.equal(recover.status, "ready_for_owner_confirmation");
  assert.equal((await restarted.apply({ plan_id: recover.plan_id, confirmation: recover.owner_chat_confirmation })).status, "rolled_back");
  assert.equal((await original.inspect("update-ABC123", "active")).bytes, 9);
});
