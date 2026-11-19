import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { realpath, stat, open } from "node:fs/promises";
import path from "node:path";

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
});

function validate(name, args) {
  if (!isRecord(args)) throw safeError("invalid_arguments");
  const keys = Object.keys(args);
  if (name === "system_info") {
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
      windowsHide: true, shell: false, timeout: 8000, maxBuffer: MAX_TEXT, encoding: "utf8", env,
    });
  } catch { throw safeError("powershell_unavailable"); }
  if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > MAX_TEXT) throw safeError("powershell_unavailable");
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()); }
  catch { throw safeError("powershell_unavailable"); }
}

const DEFINITIONS = Object.freeze({
  system_info: {
    name: "system_info", description: "Read Windows version, processor, core count and installed RAM. No changes.",
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

export function createWindowsToolRegistry({ allowedFileRoots = [], runWindowsQuery = runPowerShellQuery } = {}) {
  if (!Array.isArray(allowedFileRoots) || allowedFileRoots.some(root => typeof root !== "string" || !path.isAbsolute(root))) throw safeError("invalid_file_roots");
  const available = ["system_info", "process_list", "service_status", "app_status", ...(allowedFileRoots.length ? ["file_read"] : [])];
  return {
    list: () => available.map(name => structuredClone(DEFINITIONS[name])),
    has: name => available.includes(name),
    async call(name, args) {
      if (!available.includes(name)) throw safeError("unknown_tool");
      const params = validate(name, args);
      if (name === "file_read") return readAllowedFile(params.path, allowedFileRoots);
      return runWindowsQuery(name, params);
    },
  };
}
