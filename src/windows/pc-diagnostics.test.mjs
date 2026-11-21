import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsToolRegistry, runPowerShellQuery } from "./windows-tools.mjs";
import { normalizePcFullAudit, normalizePcGpuAudit, normalizePcStorageAudit, normalizePcMemoryAudit,
  normalizePcInstallDiagnostics, buildPcReadinessReport } from "./pc-diagnostics.mjs";

const GIB = 1024 ** 3;
const gpuRaw = { status: "ok", gpus: [{ index: 0, name: "NVIDIA GeForce RTX 3090 Ti", driver_version: "576.52",
  vram_total_bytes: 24 * GIB, vram_used_bytes: 2 * GIB, temperature_c: 59, utilization_percent: 10 }] };
const raw = {
  pc_full_audit: { os: "Microsoft Windows 11 Pro", os_version: "10.0.26100", os_build: "26100", architecture: "64-bit",
    processor: "Intel Core i9-12900K", cores: 16, threads: 24, ram_total_bytes: 64 * GIB, ram_free_bytes: 45 * GIB,
    committed_bytes: 26 * GIB, commit_limit_bytes: 100 * GIB, pagefiles: [{ allocated_mb: 8192, used_mb: 1024 }],
    pending_reboot: false, session_zero: true, admin_token: false },
  pc_gpu_audit: { display_drivers: [{ name: "NVIDIA GeForce RTX 3090 Ti", driver_version: "32.0.15", signed: null }] },
  pc_storage_audit: { volumes: [
    { drive: "C:", total_bytes: 500 * GIB, free_bytes: 40 * GIB, filesystem: "NTFS", mapping_verified: true,
      disk_number: 0, bus_type: "SATA", media_type: null, disk_health: "Healthy" },
    { drive: "D:", total_bytes: 1000 * GIB, free_bytes: 290 * GIB, filesystem: "NTFS", mapping_verified: true,
      disk_number: 1, bus_type: "NVMe", media_type: null, disk_health: "Healthy" },
  ] },
  pc_memory_audit: { ram_total_bytes: 64 * GIB, ram_free_bytes: 45 * GIB,
    committed_bytes: 26 * GIB, commit_limit_bytes: 100 * GIB,
    processes: [{ name: "chrome", pid: 112, working_set_bytes: 1024 ** 3 }, { name: "code", pid: 113, working_set_bytes: 512 * 1024 ** 2 }] },
  pc_install_diagnostics: { pending_reboot: false, services: [
    { name: "KTKQwenMCP", status: "Running", start_type: "Automatic" },
    { name: "not-a-KTK-service", status: "Running", start_type: "Automatic" },
  ], user_task_status: "Ready", mcp_directory_exists: true, cuda_driver_dll_present: true,
  strata_processes: [{ name: "strata", pid: 348 }, { name: "chrome", pid: 349 }],
  updater_status: { status: "updated", version: "0.18.16", code: null } },
};
const normalize = () => ({
  full: normalizePcFullAudit(raw.pc_full_audit), gpu: normalizePcGpuAudit(raw.pc_gpu_audit, gpuRaw),
  storage: normalizePcStorageAudit(raw.pc_storage_audit), memory: normalizePcMemoryAudit(raw.pc_memory_audit, gpuRaw),
  install: normalizePcInstallDiagnostics(raw.pc_install_diagnostics),
});

test("Windows 11 PC audit reports recorded hardware, pagefile and execution context without claiming AVX2/CUDA", () => {
  const { full, gpu, storage, memory, install } = normalize();
  assert.equal(full.os.windows_11, true);
  assert.equal(full.os.build, 26100);
  assert.equal(full.ram.free_bytes, 45 * GIB);
  assert.equal(full.pagefiles[0].allocated_bytes, 8 * GIB);
  assert.equal(full.cpu.avx2, "not_tested");
  assert.equal(full.execution.session_zero, true);
  assert.equal(full.execution.admin_token, false);
  assert.equal(gpu.gpus[0].vram_free_bytes, 22 * GIB);
  assert.equal(gpu.gpus[0].temperature_c, 59);
  assert.equal(gpu.cuda_execution, "not_tested");
  assert.deepEqual(storage.candidate_nvme_drives, ["D:"]);
  assert.equal(storage.volumes[1].volume_to_disk_mapping, "verified_by_partition");
  assert.equal(memory.top_processes.length, 2);
  assert.equal(memory.gpu_memory[0].vram_used_bytes, 2 * GIB);
  assert.deepEqual(install.services.map(s => s.name), ["KTKQwenMCP"]);
  assert.equal(install.pending_reboot, false);
  assert.equal(install.mcp_directory_exists, true);
  assert.equal(install.cuda_driver_dll_present, true);
  assert.equal(install.cuda_execution, "not_tested");
  assert.deepEqual(install.strata_processes, [{ name: "strata", pid: 348 }]);
  assert.deepEqual(install.updater_status, { status: "updated", version: "0.18.16", code: null });
  assert.equal(install.strata_user_scope, "unknown_in_service_context");
  assert.equal(install.pinned_download_network, "not_tested");
});

test("unverified disk mapping and missing sensors are unknown, not invented NVMe/CUDA/pass", () => {
  const storage = normalizePcStorageAudit({ volumes: [{ ...raw.pc_storage_audit.volumes[1], mapping_verified: false, bus_type: "NVMe" }] });
  assert.equal(storage.volumes[0].bus_type, null);
  assert.deepEqual(storage.candidate_nvme_drives, []);
  const gpu = normalizePcGpuAudit({ display_drivers: [] }, { status: "unavailable", reason: "nvidia_smi_not_found", gpus: [] });
  assert.equal(gpu.status, "incomplete");
  assert.equal(gpu.cuda_execution, "not_tested");
  const full = normalizePcFullAudit({ ...raw.pc_full_audit, ram_free_bytes: null, pending_reboot: null, os_build: null });
  assert.equal(full.status, "incomplete");
  assert.equal(full.ram.free_bytes, null);
  assert.equal(full.os.windows_11, null);
  assert.equal(full.pending_reboot, null);
  const report = buildPcReadinessReport({ full, gpu, storage, memory: null, install: null });
  assert.equal(report.status, "unknown");
  assert.ok(report.next_actions.includes("complete_missing_read_only_observations"));
});

test("Windows 10, insufficient RAM/VRAM, and missing space cannot falsely pass readiness", () => {
  const ok = normalize();
  const report = buildPcReadinessReport(ok);
  assert.equal(report.status, "needs_action");
  assert.ok(report.next_actions.includes("perform_later_local_cuda_test"));
  assert.deepEqual(report.nvme_candidate_drives, ["D:"]);
  const old = normalizePcFullAudit({ ...raw.pc_full_audit, os: "Microsoft Windows 10 Pro", os_build: 19045,
    ram_total_bytes: 16 * GIB, ram_free_bytes: 3 * GIB });
  const small = normalizePcGpuAudit({}, { status: "ok", gpus: [{ ...gpuRaw.gpus[0], vram_total_bytes: 12 * GIB }] });
  const blocked = buildPcReadinessReport({ ...ok, full: old, gpu: small });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockers.sort(), ["gpu_below_target", "ram_below_target", "target_requires_windows_11"]);
  const noSpace = normalizePcStorageAudit({ volumes: [{ drive: "D:", total_bytes: 100 * GIB, free_bytes: 12 * GIB }] });
  assert.ok(buildPcReadinessReport({ ...ok, storage: noSpace }).next_actions.includes("free_target_disk_space"));
});

test("malicious, gigantic or invalid raw fields are dropped; no absolute paths or secrets are returned", () => {
  const bad = normalizePcMemoryAudit({ ...raw.pc_memory_audit, processes: [
    { name: "secret\nC:\\Users\\password", pid: 123, working_set_bytes: 1 },
    { name: "chrome", pid: -1, working_set_bytes: 1 },
    ...Array.from({ length: 50 }, (_, i) => ({ name: "process" + i, pid: i + 100, working_set_bytes: 500 }))
  ] }, { status: "unavailable", reason: "secret-driver-error" });
  assert.equal(bad.top_processes.length, 18);
  assert.doesNotMatch(JSON.stringify(bad), /password|secret-driver-error/);
  const unsigned = normalizePcGpuAudit({ display_drivers: [{ name: "malware\npassword", signed: false }] }, gpuRaw);
  assert.equal(unsigned.display_drivers.length, 0);
  assert.throws(() => normalizePcFullAudit(null), /invalid_pc_full_audit/);
});

test("new diagnostic MCP tools accept only empty objects, compose fixed queries and fail closed", async () => {
  const calls = [];
  const registry = createWindowsToolRegistry({
    runWindowsQuery: async (name, args) => { calls.push({ name, args }); if (!Object.hasOwn(raw, name)) throw Error("SECRET-DRIVER-PATH"); return raw[name]; },
    readNvidia: async () => gpuRaw,
  });
  for (const name of Object.keys(raw)) {
    assert.equal(registry.has(name), true);
    assert.equal(registry.list().find(t => t.name === name).annotations.readOnlyHint, true);
    await assert.rejects(() => registry.call(name, { command: "Remove-Item C:\\" }), /invalid_arguments/);
    assert.equal((await registry.call(name, {})).status, "observed");
  }
  const report = await registry.call("pc_readiness_report", {});
  assert.equal(report.status, "needs_action");
  assert.equal(report.mode, "read_only_no_installation");
  assert.deepEqual(Object.keys(report.evidence), ["full_audit", "gpu_audit", "storage_audit", "memory_audit", "install_diagnostics"]);
  assert.equal(calls.length, 10);
  assert.ok(calls.every(({ name, args }) => Object.hasOwn(raw, name) && Object.keys(args).length === 0));
  await assert.rejects(() => registry.call("pc_readiness_report", { install: true }), /invalid_arguments/);
  const broken = createWindowsToolRegistry({ runWindowsQuery: async name => name === "pc_gpu_audit" ? Promise.reject(Error("SECRET")) : raw[name], readNvidia: async () => gpuRaw });
  const missing = await broken.call("pc_readiness_report", {});
  assert.equal(missing.status, "unknown");
  assert.doesNotMatch(JSON.stringify(missing), /SECRET/);
});

test("Windows 11 diagnostic queries are static, bounded and read-only even when given hostile data", async () => {
  for (const name of Object.keys(raw)) {
    const captured = [];
    await runPowerShellQuery(name, {}, { platform: "win32", invoke: async (exe, argv, opts) => {
      captured.push({ exe, argv, opts });
      return { stdout: "{}", stderr: "secret-device-error" };
    } });
    const { argv, opts } = captured[0];
    const script = Buffer.from(argv[4], "base64").toString("utf16le");
    assert.match(script, /Get-CimInstance|Get-Process|Get-Service|Get-ScheduledTask/);
    assert.doesNotMatch(script, /\b(?:Set-Item|New-Item|Remove-Item|Invoke-WebRequest|Start-Process|Start-Service|Stop-Service|Restart-Service|Invoke-Expression|Clear-Content|Set-ExecutionPolicy|Win32_Product)\b/i);
    if (name === "pc_install_diagnostics") {
      assert.match(script, /System32\\nvcuda\.dll/);
      assert.match(script, /KTK\\Updater\\status\.json/);
    }
    assert.equal(opts.shell, false);
    assert.equal(opts.timeout, 18000);
    assert.equal(opts.maxBuffer, 40960);
    assert.deepEqual(JSON.parse(Buffer.from(opts.env.QWEN_MCP_ARGS_B64, "base64").toString("utf8")), {});
    assert.deepEqual(Object.keys(opts.env).sort(), ["COMPUTERNAME", "PSModulePath", "QWEN_MCP_ARGS_B64", "SystemRoot", "WINDIR"].sort());
    await assert.rejects(() => runPowerShellQuery(name, {}, { platform: "linux" }), /windows_unavailable/);
  }
});
