import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPcMaintenanceController } from "./pc-maintenance.mjs";
import { createUpdaterServer, callLocalUpdater, createPrivateMaintenanceReceiptStore } from "./remote-update.mjs";

test("MCP maintenance uses LocalSystem updater without any interactive PC approval", async t => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "ktk-maintenance-gate-"));
  t.after(() => rm(dataRoot, { force: true, recursive: true }));
  let state = "Stopped"; let startType = "Manual"; let mutations = 0;
  const maintenance = createPcMaintenanceController({
    queryService: async () => ({ name: "KTKQwenTunnel", owner_verified: true, status: state, start_type: startType }),
    startService: async () => { state = "Running"; mutations++; }, stopService: async () => { state = "Stopped"; mutations++; },
    configureService: async (_name, type) => { startType = type; mutations++; },
    ...createPrivateMaintenanceReceiptStore(dataRoot),
  });
  const keyText = randomBytes(32).toString("base64url");
  const server = createUpdaterServer({ keyText, port: 0, dataRoot, updaterRoot: dataRoot,
    pcMaintenance: maintenance,
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const call = (action, payload) => callLocalUpdater(action, payload, { keyText, port });
  const first = await call("maintenance_preview", { action: "start_ktk_tunnel" });
  assert.equal(first.status, "ready_for_owner_confirmation");
  assert.equal(first.requires_pc_confirmation, false);
  assert.equal(mutations, 0);
  assert.equal(await call("maintenance_apply", { plan_id: first.plan_id }).catch(e => e.code), "maintenance_owner_confirmation_required");
  assert.equal(mutations, 0);
  // Wrong plan id or unauthenticated POST must not authorize SCM.
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/maintenance/apply`, { method: "POST",
    body: JSON.stringify({ plan_id: first.plan_id }) })).status, 403);
  const second = await call("maintenance_preview", { action: "start_ktk_tunnel" });
  assert.equal(mutations, 0);
  // A separate owner authorization in chat is passed through HMAC/OAuth;
  // local Windows UAC, CLI prompts and PC consent files are never consulted.
  const result = await call("maintenance_apply", { plan_id: second.plan_id, confirmation: second.owner_chat_confirmation });
  assert.equal(result.status, "applied");
  assert.equal(mutations, 1);
  assert.equal((await call("maintenance_status")).rollback_available, true);
  // Undo is a separate preview + chat confirmation, not a silent remote stop.
  const undo = await call("maintenance_preview", { action: "rollback_ktk_tunnel" });
  assert.equal(await call("maintenance_apply", { plan_id: undo.plan_id }).catch(e => e.code), "maintenance_owner_confirmation_required");
  assert.equal(mutations, 1);
  assert.equal((await call("maintenance_apply", { plan_id: undo.plan_id, confirmation: undo.owner_chat_confirmation })).status, "rolled_back");
  assert.equal(mutations, 2);
  assert.equal((await call("maintenance_status")).rollback_available, false);
  // A separate SYSTEM-backed administrative change needs no local UAC prompt.
  state = "Running";
  const autostart = await call("maintenance_preview", { action: "enable_ktk_tunnel_autostart" });
  assert.equal(autostart.requires_pc_confirmation, false);
  const enabled = await call("maintenance_apply", { plan_id: autostart.plan_id, confirmation: autostart.owner_chat_confirmation });
  assert.equal(enabled.after_start_type, "Automatic");
  assert.equal(mutations, 3);
  const restore = await call("maintenance_preview", { action: "rollback_ktk_tunnel_autostart" });
  assert.equal((await call("maintenance_apply", { plan_id: restore.plan_id, confirmation: restore.owner_chat_confirmation })).restored_start_type, "Manual");
  assert.equal(mutations, 4);
});

test("maintenance receipts persist across controller restart and never expose raw paths", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-maintenance-receipts-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const store = createPrivateMaintenanceReceiptStore(dir);
  assert.equal(await store.readReceipt(), null);
  const receipt = { schema: 1, transaction_id: "a".repeat(32), service: "KTKQwenTunnel", before: "Stopped", status: "applied" };
  await store.writeReceipt(receipt);
  assert.deepEqual(await store.readReceipt(), receipt);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "maintenance-receipt.json"), "utf8")), receipt);
  await writeFile(path.join(dir, "maintenance-receipt.json"), JSON.stringify({ path: "C:\\Users\\secret" }));
  await assert.rejects(createPcMaintenanceController({ queryService: async () => ({ name: "KTKQwenTunnel", owner_verified: true, status: "Stopped", start_type: "Manual" }),
    startService: async () => {}, stopService: async () => {}, ...store }).status(), /maintenance_receipt_invalid/);
});

test("concurrent KTK release update blocks privileged maintenance before any PC operation", async t => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "ktk-maintenance-busy-"));
  t.after(() => rm(dataRoot, { force: true, recursive: true }));
  let attempted = 0;
  const maintenance = createPcMaintenanceController({
    queryService: async () => { attempted++; return { name: "KTKQwenTunnel", owner_verified: true, status: "Stopped", start_type: "Manual" }; },
    startService: async () => { attempted++; }, stopService: async () => { attempted++; },
  });
  const keyText = randomBytes(32).toString("base64url");
  const server = createUpdaterServer({ keyText, port: 0, dataRoot, updaterRoot: dataRoot,
    initialStatus: { status: "running", version: "0.18.19" }, pcMaintenance: maintenance });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal(await callLocalUpdater("maintenance_preview", { action: "start_ktk_tunnel" }, { keyText, port }).catch(e => e.code), "updater_unavailable");
  assert.equal(attempted, 0);
  assert.equal((await callLocalUpdater("maintenance_status", null, { keyText, port })).rollback_available, false);
});
