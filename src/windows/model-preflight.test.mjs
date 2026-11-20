import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsToolRegistry, runPowerShellQuery } from "./windows-tools.mjs";
import { MODEL_TARGET, normalizePcPreflight, normalizeStorageCheck, normalizeRuntimeCheck, buildInstallationPlan } from "./model-preflight.mjs";

const GIB = 1024 ** 3;
const gpu = { status: "ok", gpus: [{ name: "RTX 3090 Ti", driver_version: "576.52", vram_total_bytes: 24 * GIB, vram_used_bytes: 2 * GIB }] };
const inventory = {
  pc_preflight: { os: "Windows 11", os_version: "10.0.26100", architecture: "64-bit", processor: "Intel Core i9-12900K", cores: 16, threads: 24, ram_total_bytes: 64 * GIB, ram_free_bytes: 55 * GIB, session_zero: true, admin_token: false },
  storage_check: { fixed_volumes: [{ drive: "C:", total_bytes: 256 * GIB, free_bytes: 40 * GIB }, { drive: "D:", total_bytes: 512 * GIB, free_bytes: 200 * GIB }], physical_disks: [{ bus_type: "NVMe", media_type: "SSD", size_bytes: 1024 * GIB }], physical_disks_status: "ok" },
  runtime_check: { machine_installs: [], running_processes: [] },
};

test("four preflight tools make only bounded static read-only inventory calls", async () => {
  const calls = [];
  const registry = createWindowsToolRegistry({
    runWindowsQuery: async (name, args) => { calls.push({ name, args }); return inventory[name]; },
    readNvidia: async () => gpu,
  });
  const pc = await registry.call("pc_preflight", {});
  assert.equal(pc.status, "target_profile_matched");
  assert.equal(pc.gpu.gpus[0].vram_total_bytes, 24 * GIB);
  assert.equal(pc.execution_context.admin_token, false);
  const storage = await registry.call("storage_check", {});
  assert.deepEqual(storage.candidate_drives, ["D:"]);
  assert.equal(storage.volumes[1].media_type, "unknown_for_volume");
  assert.equal(storage.physical_disks[0].bus_type, "NVMe");
  const runtime = await registry.call("runtime_check", {});
  assert.equal(runtime.status, "not_detected_in_machine_scope");
  assert.equal(runtime.per_user_install_checked, false);
  assert.equal(runtime.cuda_runtime_tested, false);
  const plan = await registry.call("installation_plan", {});
  assert.equal(plan.status, "planning_only");
  assert.deepEqual(plan.candidate_drives, ["D:"]);
  assert.equal(plan.mode, "read_only_no_installation");
  assert.equal(plan.steps.length, 6);
  assert.ok(plan.steps.every(step => step.state === "not_started"));
  assert.ok(plan.steps.some(step => step.id === "build_sc117_pack"));
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => ["pc_preflight", "storage_check", "runtime_check"].includes(call.name) && Object.keys(call.args).length === 0));
});

test("incomplete sensor data stays unknown; none of the tools claim CUDA or a per-user install", () => {
  const pc = normalizePcPreflight({ ...inventory.pc_preflight, architecture: null, ram_total_bytes: null }, { status: "unavailable", reason: "nvidia_smi_not_found", gpus: [] });
  assert.equal(pc.status, "incomplete");
  assert.equal(pc.checks[2].status, "unknown");
  const storage = normalizeStorageCheck({ fixed_volumes: [{ drive: "C:", total_bytes: null, free_bytes: null }] });
  assert.equal(storage.status, "incomplete");
  assert.equal(storage.volumes[0].recommended_headroom, "unknown");
  const runtime = normalizeRuntimeCheck({ machine_installs: [], running_processes: [] }, { status: "unavailable", gpus: [] });
  assert.equal(runtime.status, "not_detected_in_machine_scope");
  assert.equal(runtime.python_environment_checked, false);
  assert.equal(buildInstallationPlan({ pc, storage, runtime }).status, "incomplete");
  assert.equal(buildInstallationPlan({ pc, storage: null, runtime }).status, "incomplete");
});

test("less-than-target RAM/VRAM or insufficient disk cannot produce a green plan", () => {
  const pc = normalizePcPreflight({ ...inventory.pc_preflight, ram_total_bytes: 32 * GIB }, { status: "ok", gpus: [{ ...gpu.gpus[0], vram_total_bytes: 12 * GIB }] });
  assert.equal(pc.status, "review_required");
  const storage = normalizeStorageCheck({ fixed_volumes: [{ drive: "C:", total_bytes: 100 * GIB, free_bytes: 20 * GIB }] });
  assert.equal(storage.status, "space_below_recommendation");
  const plan = buildInstallationPlan({ pc, storage, runtime: { status: "not_detected_in_machine_scope" } });
  assert.equal(plan.status, "review_required");
  assert.deepEqual(plan.candidate_drives, []);
  assert.ok(MODEL_TARGET.model_download_estimate_bytes > 76_000_000_000);
  assert.ok(MODEL_TARGET.recommended_free_bytes > MODEL_TARGET.model_download_estimate_bytes);
});

test("installation plan fails closed when one data source errors; never triggers installation", async () => {
  const queries = [];
  const registry = createWindowsToolRegistry({
    runWindowsQuery: async name => { queries.push(name); if (name === "storage_check") throw Error("SECRET-DEVICE-ERROR"); return inventory[name]; },
    readNvidia: async () => { throw Error("SECRET-GPU-ERROR"); },
  });
  const plan = await registry.call("installation_plan", {});
  assert.equal(plan.status, "incomplete");
  assert.equal(plan.evidence.storage_check, "incomplete");
  assert.doesNotMatch(JSON.stringify(plan), /SECRET-/);
  assert.deepEqual(queries.sort(), ["pc_preflight", "runtime_check", "storage_check"]);
});

test("PowerShell preflight scripts are static, non-interactive and contain no mutating commands", async () => {
  for (const tool of ["pc_preflight", "storage_check", "runtime_check"]) {
    let script;
    await runPowerShellQuery(tool, {}, { platform: "win32", invoke: async (_exe, argv, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.ok(options.timeout <= 12000);
      script = Buffer.from(argv[4], "base64").toString("utf16le");
      assert.deepEqual(JSON.parse(Buffer.from(options.env.QWEN_MCP_ARGS_B64, "base64").toString("utf8")), {});
      return { stdout: "{}", stderr: "" };
    } });
    assert.match(script, /Get-CimInstance|Get-ItemProperty/);
    assert.doesNotMatch(script, /\b(?:Set-Item|New-Item|Remove-Item|Invoke-WebRequest|Start-Process|Start-Service|Stop-Service|Restart-Service|Invoke-Expression|Win32_Product)\b/i);
    await assert.rejects(() => runPowerShellQuery(tool, {}, { platform: "linux" }), /windows_unavailable/);
  }
});
