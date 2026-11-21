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
    configureService: async (_service, type) => { changed++; state = { ...state, start_type: type }; },
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

test("owner-chat operation enables only KTK Tunnel autostart without restarting service or AI and rolls back exact configuration", async () => {
  const f = fixture(); f.setState({ status: "Running" });
  const plan = await f.controller.preview({ action: "enable_ktk_tunnel_autostart" });
  assert.equal(plan.status, "ready_for_owner_confirmation");
  assert.equal(plan.requires_pc_confirmation, false);
  assert.equal(plan.current_start_type, "Manual");
  assert.equal(f.change(), 0);
  const applied = await f.controller.apply({ plan_id: plan.plan_id, confirmation: plan.owner_chat_confirmation });
  assert.equal(applied.after, "Running");
  assert.equal(applied.after_start_type, "Automatic");
  assert.equal(applied.rollback_action, "rollback_ktk_tunnel_autostart");
  assert.deepEqual(f.receipt(), { schema: 1, action: "enable_ktk_tunnel_autostart", before: "Running",
    before_start_type: "Manual", transaction_id: applied.transaction_id, status: "applied", service: "KTKQwenTunnel" });
  assert.equal(f.change(), 1);
  const undone = await f.controller.preview({ action: "rollback_ktk_tunnel_autostart" });
  assert.equal(undone.status, "ready_for_owner_confirmation");
  assert.equal((await f.controller.apply({ plan_id: undone.plan_id, confirmation: undone.owner_chat_confirmation })).restored_start_type, "Manual");
  assert.equal(f.change(), 2);
  assert.equal((await f.controller.status()).rollback_available, false);
});

test("changing or already automatic KTK Tunnel configuration blocks unsupported autostart plans", async () => {
  const f = fixture(); f.setState({ status: "Running", start_type: "Automatic" });
  assert.equal((await f.controller.preview({ action: "enable_ktk_tunnel_autostart" })).reason, "tunnel_not_running_manual");
  assert.equal((await f.controller.preview({ action: "rollback_ktk_tunnel_autostart" })).reason, "no_reversible_maintenance");
  assert.equal(f.change(), 0);
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

test("receipt intent survives failed service start and remote rollback recovers without local PC intervention", async () => {
  let receipt = null;
  const ctl = createPcMaintenanceController({ queryService: async () => good(),
    startService: async () => { throw Error("super-secret native stderr"); }, stopService: async () => {},
    readReceipt: async () => receipt, writeReceipt: async r => { receipt = r; } });
  const p = await ctl.preview({ action: "start_ktk_tunnel" });
  await assert.rejects(ctl.apply({ plan_id: p.plan_id, confirmation: p.owner_chat_confirmation }));
  assert.equal(receipt.status, "pending");
  assert.equal((await ctl.status()).rollback_available, true);
  assert.equal((await ctl.preview({ action: "start_ktk_tunnel" })).reason, "previous_maintenance_active");
  const recover = await ctl.preview({ action: "rollback_ktk_tunnel" });
  assert.equal(recover.status, "ready_for_owner_confirmation");
  const restored = await ctl.apply({ plan_id: recover.plan_id, confirmation: recover.owner_chat_confirmation });
  assert.equal(restored.status, "rolled_back");
  assert.equal(receipt.status, "rolled_back");
});

test("partially changed KTK autostart is remotely reversible after a simulated SYSTEM failure", async () => {
  let type = "Manual"; let receipt = null;
  const ctl = createPcMaintenanceController({
    queryService: async () => ({ name: "KTKQwenTunnel", owner_verified: true, status: "Running", start_type: type }),
    startService: async () => {}, stopService: async () => {},
    configureService: async (_name, next) => { type = next; if (next === "Automatic") throw Error("native-command-failed-after-change"); },
    readReceipt: async () => receipt, writeReceipt: async next => { receipt = next; },
  });
  const p = await ctl.preview({ action: "enable_ktk_tunnel_autostart" });
  await assert.rejects(ctl.apply({ plan_id: p.plan_id, confirmation: p.owner_chat_confirmation }));
  assert.equal(receipt.status, "pending");
  assert.equal(type, "Automatic");
  const recover = await ctl.preview({ action: "rollback_ktk_tunnel_autostart" });
  assert.equal((await ctl.apply({ plan_id: recover.plan_id, confirmation: recover.owner_chat_confirmation })).restored_start_type, "Manual");
  assert.equal(receipt.status, "rolled_back");
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
      return { stdout: args[0] === "qc" ? `SERVICE_NAME: KTKQwenTunnel\n BINARY_PATH_NAME : "C:\\Program Files\\KTK\\QwenMCP\\KTKQwenTunnel.exe"\n SERVICE_START_NAME : NT AUTHORITY\\LocalService\n START_TYPE : 3 DEMAND_START\n` :
        `SERVICE_NAME: KTKQwenTunnel\n STATE : 1 STOPPED\n` };
    } });
  const snapshot = await adapter.queryService();
  assert.deepEqual(snapshot, good());
  await adapter.startService();
  await adapter.stopService();
  await adapter.configureService("KTKQwenTunnel", "Automatic");
  await adapter.configureService("KTKQwenTunnel", "Manual");
  assert.deepEqual(commands.map(c => c.args), [["qc", "KTKQwenTunnel"], ["query", "KTKQwenTunnel"], ["start", "KTKQwenTunnel"], ["stop", "KTKQwenTunnel"],
    ["config", "KTKQwenTunnel", "start=", "delayed-auto"], ["config", "KTKQwenTunnel", "start=", "demand"]]);
  await assert.rejects(() => adapter.configureService("KTKQwenTunnel", "disabled"), /invalid_maintenance_action/);
  await assert.rejects(() => adapter.configureService("WinDefend", "Automatic"), /invalid_maintenance_action/);
  for (const c of commands) { assert.equal(c.exe, "C:\\Windows\\System32\\sc.exe"); assert.equal(c.opts.shell, false); }
  assert.throws(() => createWindowsTunnelAdapter({ platform: "linux" }), /maintenance_windows_only/);
});

test("Windows 11 delayed-auto KTK tunnel SCM response is recognized without weakening binary ownership", async () => {
  const adapter = createWindowsTunnelAdapter({ platform: "win32", windowsRoot: "C:\\Windows", programFiles: "C:\\Program Files",
    invokeCommand: async (_exe, args) => ({ stdout: args[0] === "qc" ?
      'BINARY_PATH_NAME : "C:\\Program Files\\KTK\\QwenMCP\\KTKQwenTunnel.exe"\r\n SERVICE_START_NAME : NT AUTHORITY\\LocalService\r\n START_TYPE : 2 AUTO_START (DELAYED)\r\n' :
      'STATE : 4 RUNNING\r\n' }) });
  assert.deepEqual(await adapter.queryService(), { name: "KTKQwenTunnel", status: "Running", start_type: "Automatic", owner_verified: true });
});

test("verified MCP/Updater WinSW autostart is reversible without stopping either service or loading local AI", async () => {
  for (const [action, reverse, target] of [
    ["enable_ktk_mcp_autostart", "rollback_ktk_mcp_autostart", "KTKQwenMCP"],
    ["enable_ktk_updater_autostart", "rollback_ktk_updater_autostart", "KTKQwenUpdater"],
  ]) {
    let type = "Manual"; let receipt = null; const commands = [];
    const ctl = createPcMaintenanceController({
      queryService: async name => ({ name, owner_verified: true, status: "Running", start_type: type }),
      startService: async name => { throw Error(`Unexpected start ${name}`); },
      stopService: async name => { throw Error(`Unexpected stop ${name}`); },
      configureService: async (name, next) => { commands.push({ name, next }); type = next; },
      readReceipt: async () => receipt, writeReceipt: async value => { receipt = value; },
    });
    const preview = await ctl.preview({ action });
    assert.equal(preview.service, target);
    assert.equal(preview.requires_pc_confirmation, false);
    const applied = await ctl.apply({ plan_id: preview.plan_id, confirmation: preview.owner_chat_confirmation });
    assert.equal(applied.rollback_action, reverse);
    assert.equal(receipt.service, target);
    const undo = await ctl.preview({ action: reverse });
    assert.equal((await ctl.apply({ plan_id: undo.plan_id, confirmation: undo.owner_chat_confirmation })).restored_start_type, "Manual");
    assert.deepEqual(commands, [{ name: target, next: "Automatic" }, { name: target, next: "Manual" }]);
  }
});

test("native SCM rejects an untrusted MCP/Updater binary path before any privileged config", async () => {
  for (const target of ["KTKQwenMCP", "KTKQwenUpdater"]) {
    let configCalls = 0;
    const adapter = createWindowsTunnelAdapter({ platform: "win32", windowsRoot: "C:\\Windows", programFiles: "C:\\Program Files",
      invokeCommand: async (_exe, args) => {
        if (args[0] === "config") configCalls++;
        return { stdout: args[0] === "qc" ?
          `BINARY_PATH_NAME : "C:\\Windows\\System32\\untrusted.exe"\nSTART_TYPE : 3 DEMAND_START\n` :
          `STATE : 4 RUNNING\n` };
      } });
    const ctl = createPcMaintenanceController({ ...adapter });
    await assert.rejects(ctl.preview({ action: target === "KTKQwenMCP" ? "enable_ktk_mcp_autostart" : "enable_ktk_updater_autostart" }), /ktk_service_not_trusted/);
    assert.equal(configCalls, 0);
  }
});

test("Windows SCM service ownership requires the exact KTK WinSW path AND service account", async () => {
  for (const [name, file, identity] of [
    ["KTKQwenMCP", "C:\\Program Files\\KTK\\QwenMCP\\KTKQwenMCP.exe", "NT AUTHORITY\\LocalService"],
    ["KTKQwenUpdater", "C:\\Program Files\\KTK\\Updater\\KTKQwenUpdater.exe", "LocalSystem"],
  ]) {
    let startName = identity;
    const adapter = createWindowsTunnelAdapter({ platform: "win32", programFiles: "C:\\Program Files",
      invokeCommand: async (_exe, args) => ({ stdout: args[0] === "qc" ?
        `BINARY_PATH_NAME : "${file}"\nSERVICE_START_NAME : ${startName}\nSTART_TYPE : 3 DEMAND_START\n` :
        `STATE : 4 RUNNING\n` }) });
    assert.equal((await adapter.queryService(name)).owner_verified, true);
    startName = name === "KTKQwenMCP" ? "LocalSystem" : "NT AUTHORITY\\LocalService";
    assert.equal((await adapter.queryService(name)).owner_verified, false);
  }
});
