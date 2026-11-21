import test from "node:test";
import assert from "node:assert/strict";
import { createPcMaintenanceController, createWindowsTunnelAdapter,
  validateMaintenancePreview, validateMaintenancePlanId, validateMaintenanceApply } from "./pc-maintenance.mjs";

const good = () => ({ name: "KTKQwenTunnel", status: "Stopped", start_type: "Manual", owner_verified: true });
const fixture = () => {
  let state = good(); let receipt = null; let changed = 0;
  let time = 1000000;
  const controller = createPcMaintenanceController({
    queryService: async () => ({ ...state }),
    startService: async () => { changed++; state = { ...state, status: "Running" }; },
    stopService: async () => { changed++; state = { ...state, status: "Stopped" }; },
    readReceipt: async () => receipt,
    writeReceipt: async next => { receipt = { ...next }; },
    now: () => time,
  });
  return { controller, change: () => changed, setState: next => { state = { ...state, ...next }; },
    advance: ms => { time += ms; }, receipt: () => receipt };
};

test("preview is read-only, lists exact risk and never requires a PC confirmation", async () => {
  const f = fixture();
  const preview = await f.controller.preview({ action: "start_ktk_tunnel" });
  assert.equal(preview.status, "ready_for_owner_confirmation");
  assert.equal(preview.service, "KTKQwenTunnel");
  assert.equal(preview.requires_pc_confirmation, false);
  assert.equal(preview.requires_owner_chat_confirmation, true);
  assert.equal(preview.executed_by, "KTKQwenUpdater (LocalSystem)");
  assert.equal(preview.estimated_freed_bytes, 0);
  assert.equal(preview.requires_reboot, false);
  assert.match(preview.owner_chat_confirmation, /^CONFIRM KTK MAINTENANCE [a-f0-9]{32}$/);
  assert.equal(f.change(), 0);
  await assert.rejects(f.controller.apply({ plan_id: preview.plan_id }), /maintenance_owner_confirmation_required/);
  assert.equal(f.change(), 0);
});

test("approved one-time plan starts only stopped KTK tunnel, verifies result, persists receipt and reverses it", async () => {
  const f = fixture();
  const start = await f.controller.preview({ action: "start_ktk_tunnel" });
  const applied = await f.controller.apply({ plan_id: start.plan_id, confirmation: start.owner_chat_confirmation });
  assert.deepEqual({ before: applied.before, after: applied.after }, { before: "Stopped", after: "Running" });
  assert.equal(f.receipt().status, "applied");
  assert.equal(f.change(), 1);
  await assert.rejects(f.controller.apply({ plan_id: start.plan_id, confirmation: start.owner_chat_confirmation }), /maintenance_plan_expired/);
  const rollback = await f.controller.preview({ action: "rollback_ktk_tunnel" });
  assert.match(rollback.risk, /disconnect/);
  const undone = await f.controller.apply({ plan_id: rollback.plan_id, confirmation: rollback.owner_chat_confirmation });
  assert.equal(undone.status, "rolled_back");
  assert.equal(f.change(), 2);
  assert.equal((await f.controller.status()).rollback_available, false);
});

test("disabled, running, missing or untrusted service never gets changed", async () => {
  for (const state of [{ status: "Running" }, { start_type: "Disabled" }, { owner_verified: false }, { name: "WinDefend" }]) {
    const f = fixture(); f.setState(state);
    if (state.status === "Running") {
      assert.equal((await f.controller.preview({ action: "start_ktk_tunnel" })).status, "blocked");
    } else await assert.rejects(f.controller.preview({ action: "start_ktk_tunnel" }), /ktk_service_not_trusted/);
    assert.equal(f.change(), 0);
  }
});

test("expired owner plans, state changes and negative permissions fail closed", async () => {
  const f = fixture();
  const p = await f.controller.preview({ action: "start_ktk_tunnel" });
  f.advance(300001);
  await assert.rejects(f.controller.apply({ plan_id: p.plan_id, confirmation: p.owner_chat_confirmation }), /maintenance_plan_expired/);
  assert.equal(f.change(), 0);
  const p2 = await f.controller.preview({ action: "start_ktk_tunnel" });
  f.setState({ status: "Running" });
  await assert.rejects(f.controller.apply({ plan_id: p2.plan_id, confirmation: p2.owner_chat_confirmation }), /maintenance_state_changed/);
  assert.equal(f.change(), 0);
});

test("receipt intent survives failed service start and blocks a new action until manual inspection", async () => {
  let receipt = null;
  const ctl = createPcMaintenanceController({ queryService: async () => good(),
    startService: async () => { throw Error("super-secret native stderr"); }, stopService: async () => {},
    readReceipt: async () => receipt, writeReceipt: async r => { receipt = r; } });
  const p = await ctl.preview({ action: "start_ktk_tunnel" });
  await assert.rejects(ctl.apply({ plan_id: p.plan_id, confirmation: p.owner_chat_confirmation }));
  assert.equal(receipt.status, "pending");
  assert.equal((await ctl.preview({ action: "start_ktk_tunnel" })).reason, "previous_maintenance_active");
});

test("rejects arbitrary commands, service names, paths and malformed or repeated plan IDs", () => {
  for (const args of [{ action: "restart_WinDefend" }, { action: "start_ktk_tunnel", command: "Remove-Item" },
    { action: "stop_services" }, { path: "C:\\Windows" }, {}, null, []]) {
    assert.throws(() => validateMaintenancePreview(args), /invalid_maintenance_action/);
  }
  for (const args of [{ plan_id: "../secret" }, { plan_id: "x".repeat(32) }, { plan_id: "a".repeat(32), command: "whoami" }, {}, null]) {
    assert.throws(() => validateMaintenancePlanId(args), /invalid_maintenance_plan_id/);
  }
  for (const args of [{ plan_id: "a".repeat(32) }, { plan_id: "a".repeat(32), confirmation: "YES" },
    { plan_id: "a".repeat(32), confirmation: "CONFIRM KTK MAINTENANCE " + "b".repeat(32) },
    { plan_id: "a".repeat(32), confirmation: "CONFIRM KTK MAINTENANCE " + "a".repeat(32), cmd: "whoami" }, null]) {
    assert.throws(() => validateMaintenanceApply(args), /maintenance_owner_confirmation_required/);
  }
});

test("native SCM adapter invokes only absolute sc.exe and rejects foreign service binaries", async () => {
  const commands = [];
  const adapter = createWindowsTunnelAdapter({ platform: "win32", windowsRoot: "C:\\Windows", programFiles: "C:\\Program Files",
    invokeCommand: async (exe, args, opts) => {
      commands.push({ exe, args, opts });
      return { stdout: args[0] === "qc" ? `SERVICE_NAME: KTKQwenTunnel\n BINARY_PATH_NAME : "C:\\Program Files\\KTK\\QwenMCP\\KTKQwenTunnel.exe"\n START_TYPE : 3 DEMAND_START\n` :
        `SERVICE_NAME: KTKQwenTunnel\n STATE : 1 STOPPED\n` };
    } });
  const snapshot = await adapter.queryService();
  assert.deepEqual(snapshot, good());
  await adapter.startService();
  await adapter.stopService();
  assert.deepEqual(commands.map(c => c.args), [["qc", "KTKQwenTunnel"], ["query", "KTKQwenTunnel"], ["start", "KTKQwenTunnel"], ["stop", "KTKQwenTunnel"]]);
  for (const c of commands) { assert.equal(c.exe, "C:\\Windows\\System32\\sc.exe"); assert.equal(c.opts.shell, false); }
  assert.throws(() => createWindowsTunnelAdapter({ platform: "linux" }), /maintenance_windows_only/);
});
