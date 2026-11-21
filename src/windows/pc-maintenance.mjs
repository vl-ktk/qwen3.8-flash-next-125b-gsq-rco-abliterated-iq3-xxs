import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const invoke = promisify(execFile);
const PLAN_LIFETIME_MS = 5 * 60 * 1000;
const SERVICE = "KTKQwenTunnel";
const PLAN_ACTIONS = new Set(["start_ktk_tunnel", "rollback_ktk_tunnel",
  "enable_ktk_tunnel_autostart", "rollback_ktk_tunnel_autostart"]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hexId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

export function validateMaintenancePreview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).join() !== "action" || !PLAN_ACTIONS.has(value.action)) fail("invalid_maintenance_action");
  return { action: value.action };
}

export function validateMaintenancePlanId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).join() !== "plan_id" || !hexId(value.plan_id)) fail("invalid_maintenance_plan_id");
  return { plan_id: value.plan_id };
}

export function validateMaintenanceApply(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "confirmation,plan_id" || !hexId(value.plan_id) ||
      value.confirmation !== `CONFIRM KTK MAINTENANCE ${value.plan_id}`) fail("maintenance_owner_confirmation_required");
  return { plan_id: value.plan_id, confirmation: value.confirmation };
}

// Privileged operations affect only the exact verified KTK Tunnel WinSW service:
// start a previously stopped service, or enable automatic startup. Each action
// has a separate, state-checked rollback. Never accepts arbitrary commands,
// process names, paths, OS cleanup, driver actions or model activation.
export function createPcMaintenanceController({
  queryService, startService, stopService, configureService = async () => fail("maintenance_not_configured"),
  readReceipt = async () => null,
  writeReceipt = async () => {}, now = () => Date.now(), newId = () => randomBytes(16).toString("hex"),
} = {}) {
  if (![queryService, startService, stopService, configureService, readReceipt, writeReceipt, now, newId].every(f => typeof f === "function")) fail("maintenance_unconfigured");
  const plans = new Map();
  let busy = false;
  const service = async () => {
    const state = await queryService(SERVICE);
    if (!state || state.name !== SERVICE || state.owner_verified !== true ||
        !["Running", "Stopped"].includes(state.status) || !["Manual", "Automatic"].includes(state.start_type)) fail("ktk_service_not_trusted");
    return state;
  };
  const receipt = async () => {
    const value = await readReceipt();
    if (value === null) return null;
    if (!value || value.schema !== 1 || !hexId(value.transaction_id) ||
        !["pending", "applied", "rolling_back", "rolled_back"].includes(value.status) || value.service !== SERVICE ||
        !["start_ktk_tunnel", "enable_ktk_tunnel_autostart"].includes(value.action) ||
        (value.action === "start_ktk_tunnel" ? value.before !== "Stopped" || !["Manual", "Automatic"].includes(value.before_start_type) :
          value.before !== "Running" || value.before_start_type !== "Manual")) fail("maintenance_receipt_invalid");
    return value;
  };
  const plan = async args => {
    const { action } = validateMaintenancePreview(args);
    if (busy) fail("maintenance_busy");
    const current = await service();
    const previous = await receipt();
    const isStart = action === "start_ktk_tunnel";
    const isEnable = action === "enable_ktk_tunnel_autostart";
    const isNew = isStart || isEnable;
    const active = previous && ["pending", "applied", "rolling_back"].includes(previous.status);
    const reason = isNew ? active ? "previous_maintenance_active" :
      isStart ? current.status !== "Stopped" ? "tunnel_not_stopped" : null :
        current.status !== "Running" || current.start_type !== "Manual" ? "tunnel_not_running_manual" : null :
      !previous || !["pending", "applied", "rolling_back"].includes(previous.status) ? "no_reversible_maintenance" :
        previous.action !== (action === "rollback_ktk_tunnel" ? "start_ktk_tunnel" : "enable_ktk_tunnel_autostart") ? "different_rollback_action" :
          previous.action === "start_ktk_tunnel" ? current.start_type !== previous.before_start_type ? "service_state_changed" : null :
            current.status !== "Running" || !["Manual", "Automatic"].includes(current.start_type) ? "service_state_changed" : null;
    const details = {
      status: reason ? "blocked" : "ready_for_owner_confirmation", action,
      service: SERVICE, current_state: current.status, current_start_type: current.start_type, reason,
      effect: isStart ? "Start only the verified KTK-owned Cloudflare Tunnel service without changing its configuration." :
        action === "rollback_ktk_tunnel" ? "Stop only the same KTK Tunnel service that this maintenance controller started, restoring its previous Stopped state." :
          isEnable ? "Enable delayed automatic startup of only the verified KTK Tunnel service; never starts AI or changes other services." :
            "Restore Manual startup to the same KTK Tunnel service, leaving its Running status untouched.",
      risk: isStart ? "May establish a Cloudflare connection; does not download or start the AI model." :
        action === "rollback_ktk_tunnel" ? "Stops the remote MCP tunnel and may disconnect this chat; use local recovery if needed." :
          "Changes only when the KTK tunnel connects after Windows starts. Does not start the AI model.",
      requires_pc_confirmation: false, requires_owner_chat_confirmation: true,
      executed_by: "KTKQwenUpdater (LocalSystem)", requires_reboot: false, estimated_freed_bytes: 0,
      rollback: isStart ? "rollback_ktk_tunnel (separate owner chat confirmation)" :
        isEnable ? "rollback_ktk_tunnel_autostart (separate owner chat confirmation)" :
          action === "rollback_ktk_tunnel" ? "Restores the recorded Stopped state" : "Restores Manual startup type",
    };
    if (reason) return details;
    const planId = newId();
    if (!hexId(planId)) fail("maintenance_nonce_unavailable");
    plans.clear(); // A newer preview invalidates an older unapproved plan.
    plans.set(planId, { action, before: current.status, before_start_type: current.start_type, expires: now() + PLAN_LIFETIME_MS,
      transaction_id: previous?.transaction_id ?? null });
    return { ...details, plan_id: planId, expires_in_seconds: PLAN_LIFETIME_MS / 1000,
      owner_chat_confirmation: `CONFIRM KTK MAINTENANCE ${planId}` };
  };
  const apply = async args => {
    const { plan_id } = validateMaintenanceApply(args);
    const entry = plans.get(plan_id);
    plans.delete(plan_id); // One-shot: even a failed apply cannot be replayed.
    if (!entry || entry.expires <= now()) fail("maintenance_plan_expired");
    if (busy) fail("maintenance_busy");
    busy = true;
    try {
      const current = await service();
      if (current.status !== entry.before || current.start_type !== entry.before_start_type) fail("maintenance_state_changed");
      const previous = await receipt();
      if (["start_ktk_tunnel", "enable_ktk_tunnel_autostart"].includes(entry.action)) {
        if (previous && ["pending", "applied", "rolling_back"].includes(previous.status)) fail("maintenance_state_changed");
        if (entry.action === "start_ktk_tunnel" ? current.status !== "Stopped" : current.status !== "Running" || current.start_type !== "Manual") fail("maintenance_state_changed");
        const tx = { schema: 1, transaction_id: newId(), service: SERVICE, action: entry.action,
          before: current.status, before_start_type: current.start_type, status: "pending" };
        if (!hexId(tx.transaction_id)) fail("maintenance_nonce_unavailable");
        await writeReceipt(tx); // Durable recovery intent BEFORE modifying SCM.
        if (entry.action === "start_ktk_tunnel") await startService(SERVICE);
        else await configureService(SERVICE, "Automatic");
        const final = await service();
        if (final.status !== "Running" || (entry.action === "enable_ktk_tunnel_autostart" && final.start_type !== "Automatic")) fail("maintenance_verification_failed");
        await writeReceipt({ ...tx, status: "applied" });
        return { status: "applied", transaction_id: tx.transaction_id, service: SERVICE,
          before: tx.before, after: final.status, before_start_type: tx.before_start_type, after_start_type: final.start_type,
          rollback_action: entry.action === "start_ktk_tunnel" ? "rollback_ktk_tunnel" : "rollback_ktk_tunnel_autostart" };
      }
      if (!previous || !["pending", "applied", "rolling_back"].includes(previous.status) || previous.transaction_id !== entry.transaction_id ||
          previous.action !== (entry.action === "rollback_ktk_tunnel" ? "start_ktk_tunnel" : "enable_ktk_tunnel_autostart")) fail("maintenance_rollback_unavailable");
      if (previous.action === "start_ktk_tunnel" && current.start_type !== previous.before_start_type ||
          previous.action === "enable_ktk_tunnel_autostart" && current.status !== "Running") fail("maintenance_rollback_unavailable");
      await writeReceipt({ ...previous, status: "rolling_back" });
      if (entry.action === "rollback_ktk_tunnel" && current.status !== "Stopped") await stopService(SERVICE);
      else if (entry.action === "rollback_ktk_tunnel_autostart" && current.start_type !== "Manual") await configureService(SERVICE, "Manual");
      const restored = await service();
      if (entry.action === "rollback_ktk_tunnel" ? restored.status !== "Stopped" :
        restored.status !== "Running" || restored.start_type !== "Manual") fail("maintenance_verification_failed");
      await writeReceipt({ ...previous, status: "rolled_back" });
      return { status: "rolled_back", transaction_id: previous.transaction_id, service: SERVICE,
        restored: restored.status, restored_start_type: restored.start_type };
    } finally { busy = false; }
  };
  const status = async () => {
    const latest = await receipt();
    return { status: latest?.status ?? "no_previous_maintenance", service: SERVICE,
      transaction_id: latest?.transaction_id ?? null, rollback_available: ["pending", "applied", "rolling_back"].includes(latest?.status) };
  };
  return { preview: plan, apply, status, isBusy: () => busy };
}

// Absolute, trusted Windows SCM paths only. The service's installed binary
// must match KTK's WinSW wrapper before any change can be planned or applied.
export function createWindowsTunnelAdapter({
  platform = process.platform, invokeCommand = invoke,
  windowsRoot = process.env.SystemRoot ?? "C:\\Windows",
  programFiles = process.env.ProgramFiles ?? "C:\\Program Files",
} = {}) {
  if (platform !== "win32") fail("maintenance_windows_only");
  const native = path.win32.join(windowsRoot, "System32", "sc.exe");
  const expected = path.win32.join(programFiles, "KTK", "QwenMCP", "KTKQwenTunnel.exe").toLowerCase();
  const run = async (verb, timeout = 7000, extra = []) => {
    try {
      const { stdout } = await invokeCommand(native, [verb, SERVICE, ...extra], { shell: false, windowsHide: true,
        timeout, maxBuffer: 8192, encoding: "utf8",
        env: { SystemRoot: windowsRoot, WINDIR: windowsRoot, PATH: [path.win32.join(windowsRoot, "System32"), windowsRoot].join(";") },
      });
      return String(stdout ?? "");
    } catch { fail("maintenance_scm_unavailable"); }
  };
  return {
    async queryService() {
      const config = await run("qc");
      const state = await run("query");
      const command = config.match(/^\s*BINARY_PATH_NAME\s*:\s*(.+)$/mi)?.[1]?.trim().replace(/^"|"$/g, "").toLowerCase();
      // Windows may append "(DELAYED)" to an automatic service start type.
      const start = config.match(/^\s*START_TYPE\s*:\s*\d+\s+(AUTO_START|DEMAND_START)(?:\s+\(DELAYED\))?\s*$/mi)?.[1];
      const observed = state.match(/^\s*STATE\s*:\s*\d+\s+([A-Z_]+)\s*$/mi)?.[1];
      return { name: SERVICE, owner_verified: command === expected,
        status: observed === "RUNNING" ? "Running" : observed === "STOPPED" ? "Stopped" : "Unknown",
        start_type: start === "DEMAND_START" ? "Manual" : start === "AUTO_START" ? "Automatic" : "Unknown" };
    },
    async startService() { await run("start", 10000); },
    async stopService() { await run("stop", 10000); },
    async configureService(_name, type) {
      if (!["Automatic", "Manual"].includes(type)) fail("invalid_maintenance_action");
      await run("config", 10000, ["start=", type === "Automatic" ? "delayed-auto" : "demand"]);
    },
  };
}
