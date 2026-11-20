import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { realpath, stat, open } from "node:fs/promises";
import path from "node:path";
import { collectWindowsMonitoring, queryNvidiaGpus } from "./monitoring.mjs";
import { getAdminStatus, WINDOWS_MCP_VERSION } from "./administration.mjs";
import { normalizePcPreflight, normalizeStorageCheck, normalizeRuntimeCheck, buildInstallationPlan } from "./model-preflight.mjs";
import { callLocalUpdater, validateUpdateOffer } from "./remote-update.mjs";

const execFileAsync = promisify(execFile);
const MAX_READ = 32 * 1024;
const MAX_TEXT = 40 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,96}$/;
const READ_EXTENSIONS = new Set([".txt", ".log", ".md", ".csv", ".json", ".yaml", ".yml"]);
const BLOCKED_NAMES = /(?:^|[_.-])(\.env|id_rsa|id_ed25519|passwords?|secrets?|credentials?|tokens?|private|apikeys?|api_keys?)(?:$|[_.-])/i;
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeError = code => Object.assign(new Error(code), { code });

// All scripts are static; no request argument is concatenated into executable
// PowerShell. JSON arguments are passed through a separate base64 environment
// variable and converted into data inside the script. No arbitrary PS API.
const PREFIX = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:QWEN_MCP_ARGS_B64)) | ConvertFrom-Json
`;
const SCRIPTS = Object.freeze({
  system_info: PREFIX + `
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
$machine = Get-CimInstance -ClassName Win32_ComputerSystem
[pscustomobject]@{
  computer_name = $env:COMPUTERNAME
  os = $os.Caption
  os_version = $os.Version
  os_build = $os.BuildNumber
  architecture = $os.OSArchitecture
  processor = $cpu.Name
  cores = $cpu.NumberOfCores
  threads = $cpu.NumberOfLogicalProcessors
  ram_bytes = $machine.TotalPhysicalMemory
} | ConvertTo-Json -Depth 4 -Compress
`,
  process_list: PREFIX + `
$processes = @(Get-Process | Where-Object { -not $a.name -or $_.ProcessName -eq $a.name } |
  Sort-Object -Property WorkingSet64 -Descending | Select-Object -First $a.limit |
  ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id;
    cpu_seconds = $_.CPU; memory_bytes = $_.WorkingSet64 } })
ConvertTo-Json -InputObject $processes -Depth 4 -Compress
`,
  service_status: PREFIX + `
$services = @(Get-Service | Where-Object { $_.Name -eq $a.name } |
  ForEach-Object { [pscustomobject]@{ name = $_.Name; display_name = $_.DisplayName;
    status = $_.Status.ToString();
    startup_type = $(if ($null -ne $_.StartType) { $_.StartType.ToString() } else { 'unknown' }) } })
ConvertTo-Json -InputObject $services -Depth 4 -Compress
`,
  app_status: PREFIX + `
$procs = @(Get-Process | Where-Object { $_.ProcessName -eq $a.name } |
  Select-Object -First 50 | ForEach-Object { [pscustomobject]@{
    name = $_.ProcessName; pid = $_.Id; memory_bytes = $_.WorkingSet64 } })
[pscustomobject]@{ name = $a.name; running = ($procs.Count -gt 0); instances = $procs } |
  ConvertTo-Json -Depth 5 -Compress
`,
  system_monitor: PREFIX + `
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$cpuLoad = $null
try {
  $cpu = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
  if ($null -ne $cpu) { $cpuLoad = $cpu.PercentProcessorTime }
} catch { $cpuLoad = $null }
$disks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' |
  ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID;
    total_bytes = $_.Size; free_bytes = $_.FreeSpace } })
$events = @()
$eventsStatus = 'ok'
try {
  $events = @(Get-WinEvent -FilterHashtable @{LogName='System'; Level=@(1,2);
      StartTime=(Get-Date).AddHours(-24)} -MaxEvents 5 -ErrorAction Stop |
    ForEach-Object { [pscustomobject]@{event_id=$_.Id; provider=$_.ProviderName;
      at=$_.TimeCreated.ToUniversalTime().ToString('o'); level=$_.LevelDisplayName} })
} catch { $eventsStatus = 'unavailable_or_empty' }
[pscustomobject]@{
  cpu_usage_percent = $cpuLoad
  ram_total_bytes = ([int64]$os.TotalVisibleMemorySize * 1024)
  ram_free_bytes = ([int64]$os.FreePhysicalMemory * 1024)
  fixed_disks = $disks
  events = $events
  events_status = $eventsStatus
} | ConvertTo-Json -Depth 6 -Compress
`,
  pc_preflight: PREFIX + `
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
$machine = Get-CimInstance -ClassName Win32_ComputerSystem
$sessionZero = [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
[pscustomobject]@{
  os = $os.Caption; os_version = $os.Version; architecture = $os.OSArchitecture
  processor = $cpu.Name; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
  ram_total_bytes = $machine.TotalPhysicalMemory
  ram_free_bytes = ([int64]$os.FreePhysicalMemory * 1024)
  session_zero = $sessionZero
  admin_token = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} | ConvertTo-Json -Depth 4 -Compress
`,
  storage_check: PREFIX + `
$volumes = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' |
  Select-Object -First 32 | ForEach-Object { [pscustomobject]@{
    drive = $_.DeviceID; total_bytes = $_.Size; free_bytes = $_.FreeSpace } })
$physical = @()
$diskStatus = 'unavailable'
try {
  $physical = @(Get-PhysicalDisk -ErrorAction Stop | Select-Object -First 16 |
    ForEach-Object { [pscustomobject]@{ bus_type = $_.BusType.ToString();
      media_type = $_.MediaType.ToString(); size_bytes = $_.Size } })
  $diskStatus = 'ok'
} catch { $diskStatus = 'unavailable' }
[pscustomobject]@{ fixed_volumes = $volumes; physical_disks = $physical;
  physical_disks_status = $diskStatus } | ConvertTo-Json -Depth 5 -Compress
`,
  runtime_check: PREFIX + `
$uninstallPaths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$installed = @(Get-ItemProperty -Path $uninstallPaths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '(?i)^Strata(?:[ \\-]|$)' } |
  Select-Object -First 12 | ForEach-Object {
    [pscustomobject]@{ name = $_.DisplayName; version = $_.DisplayVersion } })
$running = @(Get-Process -Name 'strata','strata-server' -ErrorAction SilentlyContinue |
  Select-Object -First 20 | ForEach-Object { [pscustomobject]@{
    name = $_.ProcessName; pid = $_.Id } })
[pscustomobject]@{ machine_installs = $installed; running_processes = $running } |
  ConvertTo-Json -Depth 5 -Compress
`,
});

function validate(name, args) {
  if (!isRecord(args)) throw safeError("invalid_arguments");
  const keys = Object.keys(args);
  if (["system_info", "system_monitor", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan", "update_status"].includes(name)) {
    if (keys.length) throw safeError("invalid_arguments");
    return {};
  }
  if (name === "process_list") {
    if (keys.some(key => !["name", "limit"].includes(key))) throw safeError("invalid_arguments");
    if (args.name !== undefined && (typeof args.name !== "string" || !SAFE_NAME.test(args.name))) throw safeError("invalid_arguments");
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) throw safeError("invalid_arguments");
    return { name: args.name ?? null, limit: args.limit ?? 20 };
  }
  if (name === "service_status" || name === "app_status") {
    if (keys.length !== 1 || keys[0] !== "name" || typeof args.name !== "string" || !SAFE_NAME.test(args.name)) throw safeError("invalid_arguments");
    return { name: args.name };
  }
  if (name === "file_read") {
    if (keys.length !== 1 || keys[0] !== "path" || typeof args.path !== "string" || args.path.length < 1 || args.path.length > 1024 || args.path.includes("\0")) throw safeError("invalid_arguments");
    return { path: args.path };
  }
  if (name === "update_apply") return validateUpdateOffer(args);
  throw safeError("unknown_tool");
}

export async function runPowerShellQuery(name, args, { platform = process.platform, invoke = execFileAsync } = {}) {
  if (!Object.hasOwn(SCRIPTS, name)) throw safeError("unknown_tool");
  if (platform !== "win32") throw safeError("windows_unavailable");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const exe = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = Buffer.from(SCRIPTS[name], "utf16le").toString("base64");
  // Child inherits no OAuth token, device identity path, or unrelated secrets.
  const env = {
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR ?? systemRoot,
    PSModulePath: process.env.PSModulePath ?? "",
    COMPUTERNAME: process.env.COMPUTERNAME ?? "",
    QWEN_MCP_ARGS_B64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
  };
  let result;
  try {
    result = await invoke(exe, ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", script], {
      windowsHide: true, shell: false, timeout: name === "system_monitor" ? 12000 : 8000, maxBuffer: MAX_TEXT, encoding: "utf8", env,
    });
  } catch { throw safeError("powershell_unavailable"); }
  if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > MAX_TEXT) throw safeError("powershell_unavailable");
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()); }
  catch { throw safeError("powershell_unavailable"); }
}

const DEFINITIONS = Object.freeze({
  admin_status: {
    name: "admin_status", description: "Read the local Windows MCP version, Windows service state, and pending installer/recovery capabilities. Does not change anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  system_info: {
    name: "system_info", description: "Read Windows version, processor, core count and installed RAM. No changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  system_monitor: {
    name: "system_monitor", description: "Read current CPU load, RAM usage, fixed-volume free space, recent System event IDs, and NVIDIA GPU/VRAM/temperature when supported. Missing sensors are reported as unavailable.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  pc_preflight: {
    name: "pc_preflight", description: "Read Windows, CPU, RAM, NVIDIA GPU and driver facts for the SC117 125B local model; report unknown capability checks honestly. No installation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  storage_check: {
    name: "storage_check", description: "Read free space on fixed Windows volumes and available physical disk bus/media inventory. Does not guess a volume-to-NVMe mapping or write files.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  runtime_check: {
    name: "runtime_check", description: "Read machine-wide Strata installation registry entries, running process names and NVIDIA driver; per-user installs and CUDA execution are not verified.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  installation_plan: {
    name: "installation_plan", description: "Generate a read-only SC117 IQ3_XXS + Strata setup plan from fresh hardware, storage and runtime observations. No downloads, installation or launch.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  process_list: {
    name: "process_list", description: "List at most 50 Windows processes (optional exact process name). No command lines or secrets.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Exact process name, no wildcard" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  service_status: {
    name: "service_status", description: "Check state of one Windows service by exact service name. Read only.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  app_status: {
    name: "app_status", description: "Check whether one exact Windows process name is running. Read only.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  file_read: {
    name: "file_read", description: "Read at most 32 KiB of one small text file inside administrator-approved directories. No secrets or file writes.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  update_status: {
    name: "update_status", description: "Read the KTK-only privileged updater's last update result. No changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  update_apply: {
    name: "update_apply", description: "Apply one KTK MCP release from the authenticated gateway release catalog; the server substitutes exact trusted URL and SHA-256. May restart KTK services. Never accepts commands or arbitrary destinations.",
    inputSchema: { type: "object", properties: { version: { type: "string", pattern: "^0\\.18\\.[1-9][0-9]{0,3}$" } }, required: ["version"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
});

async function readAllowedFile(filePath, roots) {
  if (!path.isAbsolute(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("\\\\?\\") || filePath.startsWith("\\\\.\\")) throw safeError("file_denied");
  if (!READ_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || BLOCKED_NAMES.test(path.basename(filePath))) throw safeError("file_denied");
  const actual = await realpath(filePath).catch(() => { throw safeError("file_denied"); });
  const safe = await Promise.all(roots.map(async root => {
    const canonical = await realpath(root).catch(() => null);
    if (!canonical) return false;
    const relative = path.relative(canonical, actual);
    return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
  }));
  if (!safe.some(Boolean)) throw safeError("file_denied");
  const info = await stat(actual).catch(() => { throw safeError("file_denied"); });
  if (!info.isFile() || info.size > MAX_READ) throw safeError("file_denied");
  const fd = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw safeError("file_denied"); });
  try {
    const check = await fd.stat();
    if (!check.isFile() || check.size > MAX_READ || check.ino !== info.ino || check.dev !== info.dev) throw safeError("file_denied");
    return { path: filePath, content: await fd.readFile({ encoding: "utf8" }) };
  } finally { await fd.close(); }
}

export function createWindowsToolRegistry({ allowedFileRoots = [], runWindowsQuery = runPowerShellQuery, readNvidia = queryNvidiaGpus, identityConfigured = false,
  updater = callLocalUpdater, updaterKey = null } = {}) {
  if (!Array.isArray(allowedFileRoots) || allowedFileRoots.some(root => typeof root !== "string" || !path.isAbsolute(root))) throw safeError("invalid_file_roots");
  const available = ["system_info", "system_monitor", "process_list", "service_status", "app_status", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan", ...(updaterKey ? ["update_status", "update_apply"] : []), ...(allowedFileRoots.length ? ["file_read"] : [])];
  const safeGpu = async () => {
    try { return await readNvidia(); } catch { return { status: "unavailable", reason: "gpu_inventory_failed", gpus: [] }; }
  };
  const readModelCheck = async name => {
    if (name === "pc_preflight") return normalizePcPreflight(await runWindowsQuery(name, {}), await safeGpu());
    if (name === "storage_check") return normalizeStorageCheck(await runWindowsQuery(name, {}));
    if (name === "runtime_check") return normalizeRuntimeCheck(await runWindowsQuery(name, {}), await safeGpu());
    throw safeError("unknown_tool");
  };
  return {
    list: () => available.map(name => structuredClone(DEFINITIONS[name])),
    has: name => available.includes(name),
    async call(name, args) {
      if (!available.includes(name)) throw safeError("unknown_tool");
      const params = validate(name, args);
      if (name === "update_status" || name === "update_apply") {
        if (!updaterKey) throw safeError("updater_not_configured");
        return updater(name === "update_apply" ? "update" : "status", params, { keyText: updaterKey });
      }
      if (name === "admin_status") return getAdminStatus({
        paired: identityConfigured,
        health: { status: "ready", version: WINDOWS_MCP_VERSION },
        queryService: async serviceName => runWindowsQuery("service_status", { name: serviceName }),
      });
      if (name === "file_read") return readAllowedFile(params.path, allowedFileRoots);
      if (name === "system_monitor") return collectWindowsMonitoring({ readSystem: () => runWindowsQuery(name, params), readGpu: readNvidia });
      if (["pc_preflight", "storage_check", "runtime_check"].includes(name)) return readModelCheck(name);
      if (name === "installation_plan") {
        // Fail individual observations closed, rather than presenting a partial
        // inventory as proof that a machine is suitable for installation.
        const outcomes = await Promise.allSettled([readModelCheck("pc_preflight"), readModelCheck("storage_check"), readModelCheck("runtime_check")]);
        const [pc, storage, runtime] = outcomes.map(outcome => outcome.status === "fulfilled" ? outcome.value : null);
        return buildInstallationPlan({ pc, storage, runtime });
      }
      return runWindowsQuery(name, params);
    },
  };
}
