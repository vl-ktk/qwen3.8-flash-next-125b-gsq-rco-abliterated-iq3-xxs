import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";

const invokeNvidia = promisify(execFile);
const MIB = 1024 * 1024;
const GPU_FIELDS = ["index", "name", "driver_version", "utilization.gpu", "memory.total", "memory.used", "temperature.gpu"];

const toNumber = value => {
  if (value === null || value === undefined || value === "" || value === "N/A" || value === "[Not Supported]") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const toPercent = value => { const n = toNumber(value); return n === null || n > 100 ? null : n; };
const toBytes = value => { const n = toNumber(value); return n === null || !Number.isSafeInteger(Math.round(n * MIB)) ? null : Math.round(n * MIB); };

// Accept quoted CSV strings and escaped quotes. Never treat GPU names as code.
export function parseNvidiaCsv(line) {
  const row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { row.push(field.trim()); field = ""; }
    else field += c;
  }
  if (quoted) throw Error("invalid_gpu_output");
  row.push(field.trim());
  return row;
}

export function parseNvidiaSmiOutput(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 16384) throw Error("invalid_gpu_output");
  const rows = output.replace(/^\uFEFF/, "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!rows.length || rows.length > 16) throw Error("invalid_gpu_output");
  const GPUs = rows.map(row => {
    const fields = parseNvidiaCsv(row);
    if (fields.length !== GPU_FIELDS.length) throw Error("invalid_gpu_output");
    const [id, name, driver, usage, total, used, temperature] = fields;
    const index = Number(id);
    if (!Number.isInteger(index) || index < 0 || index > 255 || name.length < 1 || name.length > 160) throw Error("invalid_gpu_output");
    const totalBytes = toBytes(total);
    const usedBytes = toBytes(used);
    return {
      index,
      name,
      driver_version: driver || null,
      utilization_percent: toPercent(usage),
      vram_total_bytes: totalBytes,
      vram_used_bytes: totalBytes !== null && usedBytes !== null && usedBytes <= totalBytes ? usedBytes : null,
      temperature_c: toNumber(temperature),
    };
  });
  if (new Set(GPUs.map(gpu => gpu.index)).size !== GPUs.length) throw Error("invalid_gpu_output");
  return GPUs;
}

// Do not execute 'nvidia-smi' from PATH: a writable path could shadow it.
// Only known protected Windows install locations are considered. Installer
// may later add a verified driver-specific path if needed.
export async function queryNvidiaGpus({ platform = process.platform, exists = stat, invoke = invokeNvidia, systemRoot = process.env.SystemRoot ?? "C:\\Windows", programFiles = process.env.ProgramFiles ?? "C:\\Program Files" } = {}) {
  if (platform !== "win32") return { status: "unavailable", reason: "not_windows", gpus: [] };
  const choices = [
    path.win32.join(systemRoot, "System32", "nvidia-smi.exe"),
    path.win32.join(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
  ];
  let executable = null;
  for (const candidate of choices) {
    try { if ((await exists(candidate)).isFile()) { executable = candidate; break; } }
    catch { /* Try only the next trusted location. */ }
  }
  if (!executable) return { status: "unavailable", reason: "nvidia_smi_not_found", gpus: [] };
  let stdout;
  try {
    ({ stdout } = await invoke(executable, [`--query-gpu=${GPU_FIELDS.join(",")}`, "--format=csv,noheader,nounits"], {
      windowsHide: true, shell: false, timeout: 5000, maxBuffer: 16384, encoding: "utf8",
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
    }));
  } catch { return { status: "unavailable", reason: "nvidia_smi_failed", gpus: [] }; }
  try { return { status: "ok", source: "nvidia-smi", gpus: parseNvidiaSmiOutput(stdout) }; }
  catch { return { status: "unavailable", reason: "invalid_gpu_output", gpus: [] }; }
}

// PowerShell's script produces known read-only CIM data; this layer normalizes
// units and keeps missing counters as null, never as fabricated zero values.
export function normalizeSystemCounters(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid_system_counters");
  const total = toNumber(raw.ram_total_bytes);
  const free = toNumber(raw.ram_free_bytes);
  const ram = { total_bytes: total, free_bytes: total !== null && free !== null && free <= total ? free : null };
  ram.used_bytes = ram.total_bytes !== null && ram.free_bytes !== null ? ram.total_bytes - ram.free_bytes : null;
  ram.used_percent = ram.used_bytes !== null && ram.total_bytes > 0 ? Math.round(ram.used_bytes * 10000 / ram.total_bytes) / 100 : null;
  const fixedDisks = Array.isArray(raw.fixed_disks) ? raw.fixed_disks.slice(0, 32).map(item => {
    const totalBytes = toNumber(item?.total_bytes);
    const freeBytes = toNumber(item?.free_bytes);
    return {
      drive: typeof item?.drive === "string" && /^[A-Z]:$/i.test(item.drive) ? item.drive.toUpperCase() : null,
      total_bytes: totalBytes,
      free_bytes: totalBytes !== null && freeBytes !== null && freeBytes <= totalBytes ? freeBytes : null,
      media_type: "unknown", // Logical volumes cannot safely classify SSD vs HDD.
    };
  }).filter(drive => drive.drive) : [];
  const errors = Array.isArray(raw.events) ? raw.events.slice(0, 5).map(e => ({
    event_id: Number.isSafeInteger(Number(e?.event_id)) ? Number(e.event_id) : null,
    provider: typeof e?.provider === "string" ? e.provider.slice(0, 120) : null,
    at: typeof e?.at === "string" ? e.at.slice(0, 40) : null,
    level: typeof e?.level === "string" ? e.level.slice(0, 30) : null,
  })) : [];
  return {
    cpu: { usage_percent: toPercent(raw.cpu_usage_percent), temperature_c: null, temperature_status: "unsupported_without_sensor_provider" },
    ram,
    fixed_disks: fixedDisks,
    diagnostics: { recent_system_events: errors, status: raw.events_status === "ok" ? "ok" : "unavailable_or_empty", window_hours: 24 },
  };
}

export async function collectWindowsMonitoring({ readSystem, readGpu = queryNvidiaGpus, now = () => new Date() } = {}) {
  if (typeof readSystem !== "function") throw Error("monitor_query_unconfigured");
  const system = normalizeSystemCounters(await readSystem());
  let gpu;
  try { gpu = await readGpu(); }
  catch { gpu = { status: "unavailable", reason: "gpu_monitor_failed", gpus: [] }; }
  if (!gpu || !["ok", "unavailable"].includes(gpu.status) || !Array.isArray(gpu.gpus)) {
    gpu = { status: "unavailable", reason: "invalid_gpu_output", gpus: [] };
  }
  return { observed_at: now().toISOString(), ...system, gpu };
}
