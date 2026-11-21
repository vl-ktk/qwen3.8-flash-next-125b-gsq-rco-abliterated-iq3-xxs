// Windows 11 target diagnostic normalization. The raw values originate only
// from fixed, read-only PowerShell queries; no personal paths or registry data.
import { MODEL_TARGET } from "./model-preflight.mjs";

const GIB = 1024 ** 3;
const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v, max) => Array.isArray(v) ? v.slice(0, max) : [];
const bytes = v => v === null || v === undefined || v === "" ? null : Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const integer = (v, max = Number.MAX_SAFE_INTEGER) => { const n = bytes(v); return n !== null && n <= max ? n : null; };
const text = (v, max = 120) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\r\n\0]/.test(v) ? v : null;
const bool = v => typeof v === "boolean" ? v : null;
const drive = v => typeof v === "string" && /^[A-Za-z]:$/.test(v) ? v.toUpperCase() : null;
const cappedMemory = (total, free) => free !== null && total !== null && free <= total ? free : null;

export function normalizePcFullAudit(raw) {
  if (!record(raw)) throw Error("invalid_pc_full_audit");
  const build = integer(raw.os_build, 999999);
  const name = text(raw.os, 160);
  const isWin11 = build === null || !name ? null : /Windows 11/i.test(name) && build >= 22000;
  const total = bytes(raw.ram_total_bytes);
  const free = cappedMemory(total, bytes(raw.ram_free_bytes));
  const committed = bytes(raw.committed_bytes);
  const limit = bytes(raw.commit_limit_bytes);
  return {
    status: name && isWin11 !== null && total !== null ? "observed" : "incomplete",
    os: { name, version: text(raw.os_version, 48), build, architecture: text(raw.architecture, 48), windows_11: isWin11 },
    cpu: { model: text(raw.processor, 160), cores: integer(raw.cores, 256), threads: integer(raw.threads, 1024), avx2: "not_tested" },
    ram: { total_bytes: total, free_bytes: free, committed_bytes: committed, commit_limit_bytes: limit !== null && committed !== null && limit >= committed ? limit : null },
    pagefiles: list(raw.pagefiles, 8).map(item => ({ allocated_bytes: integer(item?.allocated_mb, 2 ** 32) === null ? null : integer(item.allocated_mb, 2 ** 32) * 1024 ** 2,
      used_bytes: integer(item?.used_mb, 2 ** 32) === null ? null : integer(item.used_mb, 2 ** 32) * 1024 ** 2 })),
    pending_reboot: bool(raw.pending_reboot),
    execution: { session_zero: bool(raw.session_zero), admin_token: bool(raw.admin_token) },
    note: "Windows 11 is the recorded target. A Windows 10 MCP host is not proof of friend-PC readiness; CPU instructions and CUDA execution are untested.",
  };
}

export function normalizePcGpuAudit(raw, nvidia) {
  if (!record(raw)) throw Error("invalid_pc_gpu_audit");
  const gpus = nvidia?.status === "ok" && Array.isArray(nvidia.gpus) ? nvidia.gpus.slice(0, 16).map(gpu => {
    const total = bytes(gpu?.vram_total_bytes);
    const used = cappedMemory(total, bytes(gpu?.vram_used_bytes));
    return {
      index: integer(gpu?.index, 255), name: text(gpu?.name, 160), driver_version: text(gpu?.driver_version, 40),
      vram_total_bytes: total, vram_used_bytes: used, vram_free_bytes: total !== null && used !== null ? total - used : null,
      utilization_percent: integer(gpu?.utilization_percent, 100), temperature_c: integer(gpu?.temperature_c, 150),
    };
  }) : [];
  const displayDrivers = list(raw.display_drivers, 8).map(d => ({
    name: text(d?.name, 160), driver_version: text(d?.driver_version, 80), signed: bool(d?.signed),
  })).filter(d => d.name);
  return {
    status: nvidia?.status === "ok" ? "observed" : "incomplete",
    nvidia_status: nvidia?.status === "ok" ? "ok" : "unavailable",
    nvidia_reason: nvidia?.status === "ok" ? null : text(nvidia?.reason, 80) ?? "gpu_inventory_unavailable",
    gpus, display_drivers: displayDrivers,
    cuda_execution: "not_tested", cuda_engine_compatibility: "unknown",
    note: "Driver metadata and nvidia-smi do not prove CUDA execution. Windows WDDM may leave process-level VRAM unavailable.",
  };
}

export function normalizePcStorageAudit(raw) {
  if (!record(raw)) throw Error("invalid_pc_storage_audit");
  const volumes = list(raw.volumes, 32).map(v => {
    const name = drive(v?.drive);
    const total = bytes(v?.total_bytes);
    const free = cappedMemory(total, bytes(v?.free_bytes));
    const bus = text(v?.bus_type, 32);
    const mapped = bool(v?.mapping_verified) === true && bus !== null;
    return {
      drive: name, total_bytes: total, free_bytes: free, filesystem: text(v?.filesystem, 32),
      disk_number: mapped ? integer(v?.disk_number, 4096) : null,
      bus_type: mapped ? bus : null, media_type: mapped ? text(v?.media_type, 32) : null,
      disk_health: mapped ? text(v?.disk_health, 32) : null,
      volume_to_disk_mapping: mapped ? "verified_by_partition" : "unknown",
      recommended_space: free === null ? "unknown" : free >= MODEL_TARGET.recommended_free_bytes ? "yes" : "no",
    };
  }).filter(v => v.drive);
  return {
    status: volumes.length ? "observed" : "incomplete",
    volumes, recommended_free_bytes: MODEL_TARGET.recommended_free_bytes,
    candidate_nvme_drives: volumes.filter(v => v.bus_type?.toLowerCase() === "nvme" && v.recommended_space === "yes").map(v => v.drive),
    candidate_space_only: volumes.filter(v => v.recommended_space === "yes").map(v => v.drive),
    note: "Bus/media claims apply only when partition-to-disk mapping succeeds. Disk health is not a SMART endurance test; write access and CUDA are not tested.",
  };
}

export function normalizePcMemoryAudit(raw, nvidia) {
  if (!record(raw)) throw Error("invalid_pc_memory_audit");
  const total = bytes(raw.ram_total_bytes);
  const free = cappedMemory(total, bytes(raw.ram_free_bytes));
  const processes = list(raw.processes, 20).map(p => ({ name: text(p?.name, 96), pid: integer(p?.pid, 0xFFFFFFFF), working_set_bytes: bytes(p?.working_set_bytes) })).filter(p => p.name && p.pid !== null);
  const gpu = normalizePcGpuAudit({ display_drivers: [] }, nvidia);
  return {
    status: total !== null && free !== null ? "observed" : "incomplete",
    ram: { total_bytes: total, available_bytes: free, used_estimate_bytes: total !== null && free !== null ? total - free : null,
      committed_bytes: bytes(raw.committed_bytes), commit_limit_bytes: bytes(raw.commit_limit_bytes) },
    top_processes: processes, gpu_status: gpu.nvidia_status,
    gpu_memory: gpu.gpus.map(g => ({ index: g.index, vram_total_bytes: g.vram_total_bytes, vram_used_bytes: g.vram_used_bytes, vram_free_bytes: g.vram_free_bytes })),
    note: "Read-only counters; no process termination, standby-cache flushing, memory cleaning, or GPU reset.",
  };
}

export function normalizePcInstallDiagnostics(raw) {
  if (!record(raw)) throw Error("invalid_pc_install_diagnostics");
  const known = new Set(["KTKQwenMCP", "KTKQwenTunnel", "KTKQwenUpdater"]);
  const services = list(raw.services, 3).map(s => ({
    name: text(s?.name, 50), status: text(s?.status, 40), start_type: text(s?.start_type, 40),
  })).filter(s => known.has(s.name));
  const running = list(raw.strata_processes, 8).map(p => ({
    name: text(p?.name, 64), pid: integer(p?.pid, 0xFFFFFFFF),
  })).filter(p => ["strata", "strata-server"].includes(p.name) && p.pid !== null);
  const updater = record(raw.updater_status) ? {
    status: text(raw.updater_status.status, 32),
    version: text(raw.updater_status.version, 32),
    code: text(raw.updater_status.code, 64),
  } : null;
  return {
    status: bool(raw.pending_reboot) === null ? "incomplete" : "observed",
    pending_reboot: bool(raw.pending_reboot), services,
    user_updater_task: text(raw.user_task_status, 40) ?? "unknown",
    mcp_directory_exists: bool(raw.mcp_directory_exists),
    updater_status: updater,
    strata_processes: running, strata_user_scope: "unknown_in_service_context",
    cuda_driver_dll_present: bool(raw.cuda_driver_dll_present), cuda_execution: "not_tested",
    install_logs: "not_read_to_avoid_secrets", pinned_download_network: "not_tested",
    note: "Machine KTK status, fixed process names and NVIDIA driver DLL presence only. Per-user Strata installation, network, full CUDA runtime, and log contents cannot be inferred from a SYSTEM service.",
  };
}

export function buildPcReadinessReport({ full, gpu, storage, memory, install }) {
  const evidence = { full_audit: full?.status ?? "unavailable", gpu_audit: gpu?.status ?? "unavailable",
    storage_audit: storage?.status ?? "unavailable", memory_audit: memory?.status ?? "unavailable",
    install_diagnostics: install?.status ?? "unavailable" };
  const blockers = [];
  const actions = [];
  const unknown = Object.values(evidence).some(s => s !== "observed");
  if (full?.os?.windows_11 === false) blockers.push("target_requires_windows_11");
  if (full?.os?.architecture && !/64/.test(full.os.architecture)) blockers.push("windows_x64_required");
  if (full?.ram?.total_bytes !== null && full?.ram?.total_bytes !== undefined && full.ram.total_bytes < MODEL_TARGET.target_ram_bytes) blockers.push("ram_below_target");
  const gpuTotals = gpu?.gpus?.map(g => g.vram_total_bytes).filter(v => v !== null) ?? [];
  if (gpuTotals.length && Math.max(...gpuTotals) < MODEL_TARGET.target_vram_bytes) blockers.push("gpu_below_target");
  if (gpu?.nvidia_status === "ok" && !gpuTotals.length) actions.push("verify_nvidia_vram");
  const available = storage?.volumes?.filter(v => v.recommended_space === "yes") ?? [];
  if (storage?.status === "observed" && !available.length) actions.push("free_target_disk_space");
  if (storage?.status === "observed" && available.length && !storage.candidate_nvme_drives.length) actions.push("verify_nvme_mapping");
  if (install?.pending_reboot === true || full?.pending_reboot === true) actions.push("review_pending_reboot");
  if (gpu?.cuda_execution !== "verified") actions.push("perform_later_local_cuda_test");
  if (unknown) actions.push("complete_missing_read_only_observations");
  return {
    status: blockers.length ? "blocked" : unknown ? "unknown" : actions.length ? "needs_action" : "ready",
    mode: "read_only_no_installation", target_os: "Windows 11 x64",
    evidence, blockers, next_actions: [...new Set(actions)],
    nvme_candidate_drives: storage?.candidate_nvme_drives ?? [],
    note: "Not a CUDA or model acceptance test. No installation, model download or system configuration took place.",
  };
}
