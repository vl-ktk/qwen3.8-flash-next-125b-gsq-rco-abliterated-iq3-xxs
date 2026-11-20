// Block A: inventory and an installation proposal only. No download, repair,
// installer, registry write, service control, or runtime launch happens here.
const GIB = 1024 ** 3;
export const MODEL_TARGET = Object.freeze({
  repository: "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF",
  quantization: "IQ3_XXS",
  engine: "Strata",
  // The upstream model card rounds the two shards to 47.34 + 28.80 GB.
  model_download_estimate_bytes: 76_140_000_000,
  // Allow headroom for the SC117-specific native pack, MTP data, failed or
  // resumed downloads, and free space; an estimate, not a disk guarantee.
  recommended_free_bytes: 130_000_000_000,
  target_ram_bytes: 64 * GIB,
  target_vram_bytes: 24 * GIB,
});

const finiteBytes = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const boundedString = (value, max = 160) => typeof value === "string" && value.length <= max ? value : null;
const validRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validatedGpu = raw => raw?.status === "ok" && Array.isArray(raw.gpus) && raw.gpus.length <= 16
  ? { status: "ok", source: "nvidia-smi", gpus: raw.gpus.map(item => ({
    name: boundedString(item.name), driver_version: boundedString(item.driver_version, 40),
    vram_total_bytes: finiteBytes(item.vram_total_bytes),
    vram_used_bytes: finiteBytes(item.vram_used_bytes),
  })) }
  : { status: "unavailable", reason: boundedString(raw?.reason, 64) ?? "gpu_inventory_unavailable", gpus: [] };

export function normalizePcPreflight(raw, rawGpu) {
  if (!validRecord(raw)) throw Error("invalid_preflight_data");
  const ramTotal = finiteBytes(raw.ram_total_bytes);
  const ramFree = finiteBytes(raw.ram_free_bytes);
  const gpu = validatedGpu(rawGpu);
  const highestVram = gpu.gpus.reduce((max, item) => Math.max(max, item.vram_total_bytes ?? 0), 0);
  const checks = [
    { name: "windows_x64", status: typeof raw.architecture === "string" ? (/64/.test(raw.architecture) ? "pass" : "review") : "unknown" },
    { name: "ram_64_gib_target", status: ramTotal === null ? "unknown" : ramTotal >= MODEL_TARGET.target_ram_bytes ? "pass" : "review" },
    { name: "nvidia_24_gib_target", status: gpu.status !== "ok" || gpu.gpus.every(item => item.vram_total_bytes === null) ? "unknown" : highestVram >= MODEL_TARGET.target_vram_bytes ? "pass" : "review" },
  ];
  return {
    status: checks.some(check => check.status === "unknown") ? "incomplete" : checks.some(check => check.status === "review") ? "review_required" : "target_profile_matched",
    os: { name: boundedString(raw.os), version: boundedString(raw.os_version, 64), architecture: boundedString(raw.architecture, 64) },
    cpu: { model: boundedString(raw.processor), cores: finiteBytes(raw.cores), threads: finiteBytes(raw.threads) },
    ram: { total_bytes: ramTotal, free_bytes: ramTotal !== null && ramFree !== null && ramFree <= ramTotal ? ramFree : null },
    gpu, checks,
    execution_context: { session_zero: raw.session_zero === true, admin_token: raw.admin_token === true },
    note: "Hardware inventory only. CPU instruction support, CUDA execution, performance and model startup are not verified.",
  };
}

export function normalizeStorageCheck(raw) {
  if (!validRecord(raw)) throw Error("invalid_storage_data");
  const volumes = (Array.isArray(raw.fixed_volumes) ? raw.fixed_volumes : []).slice(0, 32).map(item => {
    const total = finiteBytes(item?.total_bytes);
    const free = finiteBytes(item?.free_bytes);
    const drive = typeof item?.drive === "string" && /^[a-z]:$/i.test(item.drive) ? item.drive.toUpperCase() : null;
    return { drive, total_bytes: total, free_bytes: total !== null && free !== null && free <= total ? free : null,
      recommended_headroom: free === null || total === null || free > total ? "unknown" : free >= MODEL_TARGET.recommended_free_bytes ? "yes" : "no",
      media_type: "unknown_for_volume" };
  }).filter(volume => volume.drive);
  const devices = (Array.isArray(raw.physical_disks) ? raw.physical_disks : []).slice(0, 16).map(item => ({
    bus_type: boundedString(item?.bus_type, 40), media_type: boundedString(item?.media_type, 40), size_bytes: finiteBytes(item?.size_bytes),
  }));
  const fitting = volumes.filter(item => item.recommended_headroom === "yes");
  return {
    status: !volumes.length ? "incomplete" : fitting.length ? "space_available" : volumes.some(item => item.recommended_headroom === "unknown") ? "incomplete" : "space_below_recommendation",
    volumes, physical_disks: devices,
    physical_disks_status: raw.physical_disks_status === "ok" ? "ok" : "unavailable",
    recommended_free_bytes: MODEL_TARGET.recommended_free_bytes,
    model_download_estimate_bytes: MODEL_TARGET.model_download_estimate_bytes,
    candidate_drives: fitting.map(item => item.drive),
    note: "Physical disk bus/media cannot be reliably mapped to a drive letter by this check. NVMe must be confirmed before installation.",
  };
}

export function normalizeRuntimeCheck(raw, rawGpu) {
  if (!validRecord(raw)) throw Error("invalid_runtime_data");
  const installed = (Array.isArray(raw.machine_installs) ? raw.machine_installs : []).slice(0, 12).map(item => ({
    name: boundedString(item?.name), version: boundedString(item?.version, 80),
  })).filter(item => item.name);
  const running = (Array.isArray(raw.running_processes) ? raw.running_processes : []).slice(0, 20).map(item => ({
    name: boundedString(item?.name, 80), pid: finiteBytes(item?.pid),
  })).filter(item => item.name);
  return {
    status: installed.length || running.length ? "detected" : "not_detected_in_machine_scope",
    machine_installs: installed, running_processes: running,
    nvidia: validatedGpu(rawGpu),
    per_user_install_checked: false,
    python_environment_checked: false,
    cuda_runtime_tested: false,
    note: "Only HKLM uninstall entries and process names are inspected. A per-user Strata installation may exist but be invisible to the Windows service.",
  };
}

export function buildInstallationPlan({ pc, storage, runtime }) {
  const hardware = pc?.status ?? "incomplete";
  const disk = storage?.status ?? "incomplete";
  const runtimeStatus = runtime?.status ?? "incomplete";
  const blocked = ["review_required"].includes(hardware) || disk === "space_below_recommendation";
  const unknown = !pc || !storage || !runtime || hardware === "incomplete" || disk === "incomplete" || runtimeStatus === "incomplete";
  return {
    status: blocked ? "review_required" : unknown ? "incomplete" : "planning_only",
    mode: "read_only_no_installation",
    model: MODEL_TARGET,
    evidence: { pc_preflight: hardware, storage_check: disk, runtime_check: runtimeStatus },
    candidate_drives: Array.isArray(storage?.candidate_drives) ? storage.candidate_drives : [],
    steps: [
      { id: "select_volume", action: "Confirm an NVMe volume and reserve recommended free space", state: "not_started" },
      { id: "install_strata", action: "Download, verify, and install a pinned compatible Strata release", state: "not_started" },
      { id: "download_model", action: "Download both SC117 IQ3_XXS GGUF shards and Strata MTP runtime files; verify hashes", state: "not_started" },
      { id: "build_sc117_pack", action: "Build a new SC117-specific Strata native pack; do not reuse the official model pack", state: "not_started" },
      { id: "configure_runtime", action: "Configure native, ple-gguf, pack, MTP and localhost-only API settings", state: "not_started" },
      { id: "acceptance", action: "Perform one integrated Windows installation and inference acceptance test after later blocks", state: "not_started" },
    ],
    caveats: ["No disk location has been selected or changed.", "Model size and free-space allowance are estimates, not measured file hashes.", "No runtime install, pack build, CUDA test or inference has run."],
  };
}
