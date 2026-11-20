import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

const execFileAsync = promisify(execFile);
export const WINDOWS_SERVICE_NAME = "KTKQwenMCP";
export const WINDOWS_MCP_VERSION = "0.13.0";
const MAX_OUTPUT = 16 * 1024;
const ACTIONS = Object.freeze({
  start: ["start", WINDOWS_SERVICE_NAME],
  stop: ["stop", WINDOWS_SERVICE_NAME],
  // First two unplanned failures restart the service; no automatic OS reboot.
  configure_recovery: ["failure", WINDOWS_SERVICE_NAME, "reset=", "86400", "actions=", "restart/60000/restart/120000/none/0"],
});
const permitted = new Set(["start", "stop", "restart", "configure_recovery"]);
const safeError = code => Object.assign(new Error(code), { code });
const serviceState = text => {
  const value = /^\s*STATE\s*:\s*([0-9]+)\b/im.exec(text ?? "");
  return value?.[1] === "1" ? "stopped" : value?.[1] === "4" ? "running" : "unknown";
};

export async function checkLocalHealth({ fetcher = fetch, port = 8765, timeoutMs = 2000 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw safeError("invalid_health_configuration");
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/healthz`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" },
    });
    if (!response.ok) return { status: "unavailable", reason: "health_http_error" };
    const data = await response.json();
    if (!data || data.status !== "ready" || data.transport !== "streamable-http" || data.model !== "not_checked") return { status: "unavailable", reason: "invalid_health_response" };
    return { status: "ready", model: "not_checked", transport: "streamable-http", version: data.version ?? null };
  } catch { return { status: "unavailable", reason: "health_unreachable" }; }
}

export async function getAdminStatus({ queryService, uptime = () => process.uptime(), now = () => new Date(), paired = false } = {}) {
  const checkedAt = now().toISOString();
  let service = { status: "unavailable" };
  if (typeof queryService === "function") {
    try {
      const result = await queryService(WINDOWS_SERVICE_NAME);
      const entries = Array.isArray(result) ? result : result ? [result] : [];
      if (!entries.length) service = { status: "not_installed" };
      else {
        const value = String(entries[0]?.status || "").toLowerCase();
        service = { status: value === "running" ? "running" : value === "stopped" ? "stopped" : "unknown" };
      }
    } catch { service = { status: "unavailable" }; }
  }
  return {
    checked_at: checkedAt,
    mcp: { status: "ready", version: WINDOWS_MCP_VERSION, uptime_seconds: Math.max(0, Math.floor(uptime())), local_identity_configured: Boolean(paired), cloud_pairing: "not_checked", model: "not_checked" },
    windows_service: service,
    updates: { status: "installer_required", installed_version: null },
    recovery: { status: "pending_installer", automatic_os_reboot: false },
  };
}

// This controller is for a physically authorized, elevated local console only.
// It is intentionally not registered as an MCP tool or HTTP endpoint.
export function createLocalServiceController({ platform = process.platform, invoke = execFileAsync, systemRoot = process.env.SystemRoot ?? "C:\\Windows", authorization = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const exe = path.win32.join(systemRoot, "System32", "sc.exe");
  const check = async action => {
    if (!permitted.has(action)) throw safeError("unknown_admin_action");
    if (platform !== "win32") throw safeError("windows_unavailable");
    if (!await authorization(action)) throw safeError("admin_confirmation_required");
  };
  const run = async args => {
    try {
      await invoke(exe, args, {
        windowsHide: true, shell: false, timeout: 15000, maxBuffer: MAX_OUTPUT, encoding: "utf8",
        env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      });
      return { status: "requested", service_name: WINDOWS_SERVICE_NAME };
    } catch { throw safeError("service_control_unavailable"); }
  };
  const queryState = async () => {
    try {
      const { stdout } = await invoke(exe, ["query", WINDOWS_SERVICE_NAME], {
        windowsHide: true, shell: false, timeout: 5000, maxBuffer: MAX_OUTPUT, encoding: "utf8",
        env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      });
      return serviceState(stdout);
    } catch { return "unknown"; }
  };
  return {
    async execute(action) {
      await check(action);
      if (action !== "restart") return run(ACTIONS[action]);
      // A Windows service can remain STOP_PENDING after sc stop succeeds.
      // Never start it again until Windows reports STOPPED.
      let state = await queryState();
      if (state === "unknown") throw safeError("service_state_unavailable");
      if (state === "running") {
        await run(ACTIONS.stop);
        for (let i = 0; i < 20; i++) {
          state = await queryState();
          if (state === "stopped") break;
          if (i < 19) await sleep(1000);
        }
        if (state !== "stopped") throw safeError("service_stop_timeout");
      }
      return run(ACTIONS.start);
    },
    recoveryPlan: () => ({ service_name: WINDOWS_SERVICE_NAME, restart_delays_seconds: [60, 120], restart_computer: false, installed: false }),
  };
}

const secretMatches = (actual, expected) => {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual, "utf8"), b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

// Requires a second, short-lived interactive confirmation and schedules a
// cancellable reboot after 120 seconds. Never uses /f or instant reboot.
export function createLocalRebootGate({ platform = process.platform, now = () => Date.now(), random = () => randomBytes(16), invoke = execFileAsync, systemRoot = process.env.SystemRoot ?? "C:\\Windows", authorization = () => false } = {}) {
  let pending = null;
  return {
    prepare() {
      if (platform !== "win32") throw safeError("windows_unavailable");
      const value = random();
      if (!Buffer.isBuffer(value) || value.length < 16) throw safeError("reboot_challenge_unavailable");
      pending = { code: value.toString("hex"), until: now() + 60000 };
      return { code: pending.code, expires_in_seconds: 60, cancel_command: "shutdown /a" };
    },
    async confirm(code) {
      const request = pending;
      pending = null; // Single use, including a failed attempt.
      if (platform !== "win32") throw safeError("windows_unavailable");
      if (!request || now() >= request.until || !secretMatches(code, request.code) || !await authorization("reboot")) throw safeError("reboot_confirmation_required");
      const exe = path.win32.join(systemRoot, "System32", "shutdown.exe");
      try {
        await invoke(exe, ["/r", "/t", "120", "/c", "KTK Qwen MCP locally confirmed maintenance"], {
          windowsHide: true, shell: false, timeout: 5000, maxBuffer: MAX_OUTPUT, encoding: "utf8",
          env: { SystemRoot: systemRoot, WINDIR: systemRoot },
        });
        return { status: "scheduled", delay_seconds: 120, cancel_command: "shutdown /a" };
      } catch { throw safeError("reboot_schedule_unavailable"); }
    },
  };
}

// Testable graceful shutdown; releases long-lived SSE connections first.
export function createGracefulShutdown(server, { timeoutMs = 5000, exit = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let stopping = false;
  let finished = false;
  return () => {
    if (stopping) return false;
    stopping = true;
    server.endMcpStreams?.();
    const finish = code => { if (finished) return; finished = true; exit(code); };
    const timer = setTimer(() => { server.closeAllConnections?.(); finish(1); }, timeoutMs);
    timer.unref?.();
    server.close(() => { clearTimer(timer); finish(0); });
    return true;
  };
}
