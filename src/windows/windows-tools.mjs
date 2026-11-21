import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { realpath, stat, open } from "node:fs/promises";
import path from "node:path";
import { collectWindowsMonitoring, queryNvidiaGpus } from "./monitoring.mjs";
import { getAdminStatus, WINDOWS_MCP_VERSION } from "./administration.mjs";
import { normalizePcPreflight, normalizeStorageCheck, normalizeRuntimeCheck, buildInstallationPlan } from "./model-preflight.mjs";
import { normalizePcFullAudit, normalizePcGpuAudit, normalizePcStorageAudit, normalizePcMemoryAudit, normalizePcInstallDiagnostics, buildPcReadinessReport } from "./pc-diagnostics.mjs";
import { callLocalUpdater, validateUpdateOffer } from "./remote-update.mjs";
import { validateMaintenancePreview, validateMaintenanceApply } from "./pc-maintenance.mjs";

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
  pc_full_audit: PREFIX + `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$machine = Get-CimInstance Win32_ComputerSystem
$memory = $null
try { $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop } catch {}
$pagefiles = @()
try { $pagefiles = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop | Select-Object -First 8 |
  ForEach-Object { [pscustomobject]@{ allocated_mb=$_.AllocatedBaseSize; used_mb=$_.CurrentUsage } }) } catch {}
$pending = $null
try {
  $pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or
    (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')
  $rename = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue)
  if ($null -ne $rename) { $pending = $true }
} catch { $pending = $null }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
[pscustomobject]@{
  os=$os.Caption; os_version=$os.Version; os_build=$os.BuildNumber; architecture=$os.OSArchitecture
  processor=$cpu.Name; cores=$cpu.NumberOfCores; threads=$cpu.NumberOfLogicalProcessors
  ram_total_bytes=$machine.TotalPhysicalMemory; ram_free_bytes=([int64]$os.FreePhysicalMemory * 1024)
  committed_bytes=$(if ($memory) { $memory.CommittedBytes } else { $null })
  commit_limit_bytes=$(if ($memory) { $memory.CommitLimit } else { $null })
  pagefiles=$pagefiles; pending_reboot=$pending
  session_zero=([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0)
  admin_token=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} | ConvertTo-Json -Depth 5 -Compress
`,
  pc_gpu_audit: PREFIX + `
$drivers = @()
try {
  $drivers = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object -First 8 |
    ForEach-Object { [pscustomobject]@{ name=$_.Name; driver_version=$_.DriverVersion; signed=$null } })
} catch {}
[pscustomobject]@{ display_drivers=$drivers } | ConvertTo-Json -Depth 4 -Compress
`,
  pc_storage_audit: PREFIX + `
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -First 32 |
  ForEach-Object {
    [pscustomobject]@{ drive=$_.DeviceID; total_bytes=$_.Size; free_bytes=$_.FreeSpace
      filesystem=$_.FileSystem }
  })
[pscustomobject]@{ volumes=$volumes } | ConvertTo-Json -Depth 5 -Compress
`,
  // Physical mapping is optional and deliberately isolated. Some Windows
  // storage providers can hang on Get-Partition/Get-Disk; never lose the
  // already observed volume/free-space data because of that slow provider.
  pc_storage_mapping: PREFIX + `
$parts = @(Get-Partition -ErrorAction Stop | Where-Object { $_.DriveLetter -match '^[A-Za-z]$' } | Select-Object -First 32)
$mapped = @($parts | ForEach-Object {
  $disk = Get-Disk -Number $_.DiskNumber -ErrorAction Stop
  if ($disk -and $disk.BusType) {
    [pscustomobject]@{ drive=(([string]$_.DriveLetter).ToUpperInvariant() + ':'); disk_number=$disk.Number
      bus_type=$disk.BusType.ToString(); disk_health=$(if ($disk.HealthStatus) { $disk.HealthStatus.ToString() } else { $null })
      mapping_verified=$true }
  }
})
[pscustomobject]@{ volumes=$mapped } | ConvertTo-Json -Depth 4 -Compress
`,
  pc_memory_audit: PREFIX + `
$os = Get-CimInstance Win32_OperatingSystem
$memory = $null
try { $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop } catch {}
$processes = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 |
  ForEach-Object { [pscustomobject]@{ name=$_.ProcessName; pid=$_.Id; working_set_bytes=$_.WorkingSet64 } })
[pscustomobject]@{
  ram_total_bytes=([int64]$os.TotalVisibleMemorySize * 1024)
  ram_free_bytes=([int64]$os.FreePhysicalMemory * 1024)
  committed_bytes=$(if ($memory) { $memory.CommittedBytes } else { $null })
  commit_limit_bytes=$(if ($memory) { $memory.CommitLimit } else { $null })
  processes=$processes
} | ConvertTo-Json -Depth 5 -Compress
`,
  pc_install_diagnostics: PREFIX + `
$names = @('KTKQwenMCP','KTKQwenTunnel','KTKQwenUpdater')
$services = @($names | ForEach-Object {
  $service = Get-Service -Name $_ -ErrorAction SilentlyContinue
  if ($service) { [pscustomobject]@{ name=$service.Name; status=$service.Status.ToString()
    start_type=$service.StartType.ToString() } }
})
$pending = $null
try {
  $pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or
    (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')
  $rename = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
  if ($null -ne $rename) { $pending = $true }
} catch { $pending = $null }
$mcpDirectory = $null
$cudaDriverDll = $null
try {
  $mcpDirectory = Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'KTK\\QwenMCP') -PathType Container
  $cudaDriverDll = Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\\nvcuda.dll') -PathType Leaf
} catch {}
$strataProcesses = @(Get-Process -Name 'strata','strata-server' -ErrorAction SilentlyContinue |
  Select-Object -First 8 | ForEach-Object { [pscustomobject]@{ name=$_.ProcessName; pid=$_.Id } })
$updaterStatus = $null
try {
  $updaterPath = Join-Path $env:ProgramData 'KTK\\Updater\\status.json'
  $item = Get-Item -LiteralPath $updaterPath -ErrorAction SilentlyContinue
  if ($item -and $item.Length -gt 0 -and $item.Length -le 8192) {
    $state = Get-Content -LiteralPath $updaterPath -Raw -ErrorAction Stop | ConvertFrom-Json
    $updaterStatus = [pscustomobject]@{ status=$state.status; version=$state.version; code=$state.code }
  }
} catch {}
[pscustomobject]@{ services=$services; pending_reboot=$pending
  mcp_directory_exists=$mcpDirectory; cuda_driver_dll_present=$cudaDriverDll
  strata_processes=$strataProcesses; updater_status=$updaterStatus } |
  ConvertTo-Json -Depth 5 -Compress
`,
  // Task Scheduler may block for tens of seconds on some Windows machines.
  // Treat this metadata as an optional, separately timed read-only source.
  pc_user_task_status: PREFIX + `
$taskStatus = 'unknown'
try {
  $task = Get-ScheduledTask -TaskName 'KTKQwenUserUpdater' -ErrorAction SilentlyContinue
  if ($task) { $taskStatus = $task.State.ToString() } else { $taskStatus = 'not_found' }
} catch {}
[pscustomobject]@{ user_task_status=$taskStatus } | ConvertTo-Json -Depth 3 -Compress
`,
});

function validate(name, args) {
  if (!isRecord(args)) throw safeError("invalid_arguments");
  const keys = Object.keys(args);
  if (["system_info", "system_monitor", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan", "pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_storage_mapping", "pc_memory_audit", "pc_install_diagnostics", "pc_user_task_status", "pc_readiness_report", "pc_maintenance_status", "update_status", "update_resume"].includes(name)) {
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
  if (name === "pc_maintenance_preview") return validateMaintenancePreview(args);
  if (name === "pc_maintenance_apply") return validateMaintenanceApply(args);
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
    ProgramFiles: process.env.ProgramFiles ?? path.win32.join(path.win32.parse(systemRoot).root, "Program Files"),
    ProgramData: process.env.ProgramData ?? path.win32.join(path.win32.parse(systemRoot).root, "ProgramData"),
    PATH: [path.win32.join(systemRoot, "System32"), systemRoot, path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"),
    QWEN_MCP_ARGS_B64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
  };
  let result;
  try {
    result = await invoke(exe, ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", script], {
      windowsHide: true, shell: false, timeout: ["pc_storage_mapping", "pc_user_task_status"].includes(name) ? 9000 : name === "system_monitor" ? 12000 : ["pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_memory_audit", "pc_install_diagnostics"].includes(name) ? 30000 : 8000, maxBuffer: MAX_TEXT, encoding: "utf8", env,
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
  pc_full_audit: {
    name: "pc_full_audit", description: "Read Windows 11 version/build, CPU, physical/committed RAM, pagefile, reboot-pending markers and execution context. CPU instruction support is not tested.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  pc_gpu_audit: {
    name: "pc_gpu_audit", description: "Read NVIDIA GPU/VRAM/driver/temperature telemetry and Windows display driver metadata. CUDA execution is NOT verified; unknowns remain unknown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  pc_storage_audit: {
    name: "pc_storage_audit", description: "Read fixed volumes, filesystems, free space and verified partition-to-disk bus mapping when available; never invent an NVMe mapping.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  pc_memory_audit: {
    name: "pc_memory_audit", description: "Read RAM pressure, 20 bounded process working sets and GPU memory statistics. Never stops processes or clears caches.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  pc_install_diagnostics: {
    name: "pc_install_diagnostics", description: "Read fixed KTK service/task/update status, installed directory, Strata process names, driver DLL and pending-reboot metadata. Per-user Strata, logs and CUDA execution stay unknown. Never repairs or installs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  pc_readiness_report: {
    name: "pc_readiness_report", description: "Combine fresh read-only Windows 11, NVIDIA, NVMe, RAM and KTK diagnostics into blockers, next actions and unknowns. No model download or execution.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  pc_maintenance_preview: {
    name: "pc_maintenance_preview", description: "Read-only preview of EXACT KTK Tunnel service start or rollback, including state, risk, a one-use owner chat confirmation and zero freed RAM. No prompt or action on the PC.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start_ktk_tunnel", "rollback_ktk_tunnel"] } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  },
  pc_maintenance_apply: {
    name: "pc_maintenance_apply", description: "Apply one recently previewed KTK Tunnel service operation after separate explicit OWNER confirmation in chat. Executes through privileged, allowlisted SYSTEM updater; NO local PC approvals. Never accepts commands, arbitrary paths or model actions.",
    inputSchema: { type: "object", properties: { plan_id: { type: "string", pattern: "^[a-f0-9]{32}$" }, confirmation: { type: "string", pattern: "^CONFIRM KTK MAINTENANCE [a-f0-9]{32}$" } }, required: ["plan_id", "confirmation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  pc_maintenance_status: {
    name: "pc_maintenance_status", description: "Read KTK-only maintenance receipt status and whether a verified one-step tunnel rollback is available. No PC modifications.",
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
  update_resume: {
    name: "update_resume", description: "Retry the pending verified user-scoped Strata/model phase through the registered non-elevated Windows task. Never accepts executable paths or commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
  const available = ["system_info", "system_monitor", "process_list", "service_status", "app_status", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan", "pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_memory_audit", "pc_install_diagnostics", "pc_readiness_report", ...(updaterKey ? ["pc_maintenance_preview", "pc_maintenance_apply", "pc_maintenance_status", "update_status", "update_apply", "update_resume"] : []), ...(allowedFileRoots.length ? ["file_read"] : [])];
  const safeGpu = async () => {
    try { return await readNvidia(); } catch { return { status: "unavailable", reason: "gpu_inventory_failed", gpus: [] }; }
  };
  const readModelCheck = async name => {
    if (name === "pc_preflight") return normalizePcPreflight(await runWindowsQuery(name, {}), await safeGpu());
    if (name === "storage_check") return normalizeStorageCheck(await runWindowsQuery(name, {}));
    if (name === "runtime_check") return normalizeRuntimeCheck(await runWindowsQuery(name, {}), await safeGpu());
    throw safeError("unknown_tool");
  };
  const readPcAudit = async name => {
    if (name === "pc_full_audit") return normalizePcFullAudit(await runWindowsQuery(name, {}));
    if (name === "pc_gpu_audit") return normalizePcGpuAudit(await runWindowsQuery(name, {}), await safeGpu());
    if (name === "pc_storage_audit") {
      const logical = await runWindowsQuery(name, {});
      let physical = null;
      try { physical = await runWindowsQuery("pc_storage_mapping", {}); } catch { /* Mapping unknown; logical capacity stays valid. */ }
      const mapping = new Map(Array.isArray(physical?.volumes) ? physical.volumes.filter(v => typeof v?.drive === "string" && /^[A-Za-z]:$/.test(v.drive)).map(v => [v.drive.toUpperCase(), v]) : []);
      return normalizePcStorageAudit({ volumes: Array.isArray(logical?.volumes) ? logical.volumes.map(v => ({ ...v,
        mapping_verified: mapping.get(v?.drive?.toUpperCase())?.mapping_verified === true,
        disk_number: mapping.get(v?.drive?.toUpperCase())?.disk_number ?? null,
        bus_type: mapping.get(v?.drive?.toUpperCase())?.bus_type ?? null,
        disk_health: mapping.get(v?.drive?.toUpperCase())?.disk_health ?? null,
      })) : null });
    }
    if (name === "pc_memory_audit") return normalizePcMemoryAudit(await runWindowsQuery(name, {}), await safeGpu());
    if (name === "pc_install_diagnostics") {
      const machine = await runWindowsQuery(name, {});
      let task = null;
      try { task = await runWindowsQuery("pc_user_task_status", {}); } catch { /* Unknown task state; retain machine facts. */ }
      return normalizePcInstallDiagnostics({ ...machine, user_task_status: task?.user_task_status ?? machine?.user_task_status });
    }
    throw safeError("unknown_tool");
  };
  return {
    list: () => available.map(name => structuredClone(DEFINITIONS[name])),
    has: name => available.includes(name),
    async call(name, args) {
      if (!available.includes(name)) throw safeError("unknown_tool");
      const params = validate(name, args);
      if (["update_status", "update_apply", "update_resume"].includes(name)) {
        if (!updaterKey) throw safeError("updater_not_configured");
        return updater(name === "update_apply" ? "update" : name === "update_resume" ? "resume" : "status", params, { keyText: updaterKey });
      }
      if (["pc_maintenance_preview", "pc_maintenance_apply", "pc_maintenance_status"].includes(name)) {
        if (!updaterKey) throw safeError("maintenance_not_configured");
        const action = name === "pc_maintenance_preview" ? "maintenance_preview" : name === "pc_maintenance_apply" ? "maintenance_apply" : "maintenance_status";
        return updater(action, params, { keyText: updaterKey });
      }
      if (name === "admin_status") return getAdminStatus({
        paired: identityConfigured,
        health: { status: "ready", version: WINDOWS_MCP_VERSION },
        queryService: async serviceName => runWindowsQuery("service_status", { name: serviceName }),
      });
      if (name === "file_read") return readAllowedFile(params.path, allowedFileRoots);
      if (name === "system_monitor") return collectWindowsMonitoring({ readSystem: () => runWindowsQuery(name, params), readGpu: readNvidia });
      if (["pc_preflight", "storage_check", "runtime_check"].includes(name)) return readModelCheck(name);
      if (["pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_memory_audit", "pc_install_diagnostics"].includes(name)) return readPcAudit(name);
      if (name === "pc_readiness_report") {
        const names = ["pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_memory_audit", "pc_install_diagnostics"];
        const outcomes = await Promise.allSettled(names.map(readPcAudit));
        const [full, gpu, storage, memory, install] = outcomes.map(outcome => outcome.status === "fulfilled" ? outcome.value : null);
        return buildPcReadinessReport({ full, gpu, storage, memory, install });
      }
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
