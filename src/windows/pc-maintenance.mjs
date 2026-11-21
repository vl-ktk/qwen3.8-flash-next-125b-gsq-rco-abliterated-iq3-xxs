import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const invoke = promisify(execFile);
const PLAN_LIFETIME_MS = 5 * 60 * 1000;
const SERVICE = "KTKQwenTunnel";
const PLAN_ACTIONS = new Set(["start_ktk_tunnel", "rollback_ktk_tunnel"]);
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

// The only privileged PC operation allowed in this first maintenance slice is
// starting our own previously stopped tunnel service. No configuration edits,
// arbitrary process selection, OS cleanup, driver changes or model activation.
export function createPcMaintenanceController({
  queryService, startService, stopService, readReceipt = async () => null,
  writeReceipt = async () => {}, now = () => Date.now(), newId = () => randomBytes(16).toString("hex"),
} = {}) {
  if (![queryService, startService, stopService, readReceipt, writeReceipt, now, newId].every(f => typeof f === "function")) fail("maintenance_unconfigured");
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
        value.before !== "Stopped") fail("maintenance_receipt_invalid");
    return value;
  };
  const plan = async args => {
    const { action } = validateMaintenancePreview(args);
    if (busy) fail("maintenance_busy");
    const current = await service();
    const previous = await receipt();
    const isStart = action === "start_ktk_tunnel";
    const reason = isStart ? current.status !== "Stopped" ? "tunnel_not_stopped" :
      previous && ["pending", "applied", "rolling_back"].includes(previous.status) ? "previous_maintenance_active" : null :
      !previous || previous.status !== "applied" ? "no_reversible_maintenance" :
        current.status !== "Running" ? "service_state_changed" : null;
    const details = {
      status: reason ? "blocked" : "ready_for_owner_confirmation", action,
      service: SERVICE, current_state: current.status, reason,
      effect: isStart ? "Start only the verified KTK-owned Cloudflare Tunnel service without changing its configuration." :
        "Stop only the same KTK Tunnel service that this maintenance controller started, restoring its previous Stopped state.",
      risk: isStart ? "May establish a Cloudflare connection; does not download or start the AI model." :
        "Stops the remote MCP tunnel and may disconnect this chat; use local recovery if needed.",
      requires_pc_confirmation: false, requires_owner_chat_confirmation: true,
      executed_by: "KTKQwenUpdater (LocalSystem)", requires_reboot: false, estimated_freed_bytes: 0,
      rollback: isStart ? "rollback_ktk_tunnel (separate owner chat confirmation)" : "Restores the recorded Stopped state",
    };
    if (reason) return details;
    const planId = newId();
    if (!hexId(planId)) fail("maintenance_nonce_unavailable");
    plans.clear(); // A newer preview invalidates an older unapproved plan.
    plans.set(planId, { action, before: current.status, expires: now() + PLAN_LIFETIME_MS,
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
      if (current.status !== entry.before) fail("maintenance_state_changed");
      const previous = await receipt();
      if (entry.action === "start_ktk_tunnel") {
        if (current.status !== "Stopped" || previous && ["pending", "applied", "rolling_back"].includes(previous.status)) fail("maintenance_state_changed");
        const tx = { schema: 1, transaction_id: newId(), service: SERVICE, before: "Stopped", status: "pending" };
        if (!hexId(tx.transaction_id)) fail("maintenance_nonce_unavailable");
        await writeReceipt(tx); // Durable recovery intent BEFORE modifying SCM.
        await startService(SERVICE);
        if ((await service()).status !== "Running") fail("maintenance_verification_failed");
        await writeReceipt({ ...tx, status: "applied" });
        return { status: "applied", transaction_id: tx.transaction_id, service: SERVICE,
          before: "Stopped", after: "Running", rollback_action: "rollback_ktk_tunnel" };
      }
      if (!previous || previous.status !== "applied" || previous.transaction_id !== entry.transaction_id || current.status !== "Running") fail("maintenance_rollback_unavailable");
      await writeReceipt({ ...previous, status: "rolling_back" });
      await stopService(SERVICE);
      if ((await service()).status !== "Stopped") fail("maintenance_verification_failed");
      await writeReceipt({ ...previous, status: "rolled_back" });
      return { status: "rolled_back", transaction_id: previous.transaction_id, service: SERVICE, restored: "Stopped" };
    } finally { busy = false; }
  };
  const status = async () => {
    const latest = await receipt();
    return { status: latest?.status ?? "no_previous_maintenance", service: SERVICE,
      transaction_id: latest?.transaction_id ?? null, rollback_available: latest?.status === "applied" };
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
  const run = async (verb, timeout = 7000) => {
    try {
      const { stdout } = await invokeCommand(native, [verb, SERVICE], { shell: false, windowsHide: true,
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
      const start = config.match(/^\s*START_TYPE\s*:\s*\d+\s+([A-Z_]+)\s*$/mi)?.[1];
      const observed = state.match(/^\s*STATE\s*:\s*\d+\s+([A-Z_]+)\s*$/mi)?.[1];
      return { name: SERVICE, owner_verified: command === expected,
        status: observed === "RUNNING" ? "Running" : observed === "STOPPED" ? "Stopped" : "Unknown",
        start_type: start === "DEMAND_START" ? "Manual" : start === "AUTO_START" ? "Automatic" : "Unknown" };
    },
    async startService() { await run("start", 10000); },
    async stopService() { await run("stop", 10000); },
  };
}
