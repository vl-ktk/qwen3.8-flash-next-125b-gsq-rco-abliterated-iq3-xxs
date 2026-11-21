import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const invoke = promisify(execFile);
const PLAN_LIFETIME_MS = 5 * 60 * 1000;
const SERVICE = "KTKQwenTunnel";
const SERVICE_ACTIONS = Object.freeze({
  start_ktk_tunnel: SERVICE, rollback_ktk_tunnel: SERVICE,
  enable_ktk_tunnel_autostart: SERVICE, rollback_ktk_tunnel_autostart: SERVICE,
  enable_ktk_mcp_autostart: "KTKQwenMCP", rollback_ktk_mcp_autostart: "KTKQwenMCP",
  enable_ktk_updater_autostart: "KTKQwenUpdater", rollback_ktk_updater_autostart: "KTKQwenUpdater",
  quarantine_ktk_staging: "KTKUpdaterStaging", restore_ktk_staging: "KTKUpdaterStaging",
});
const ROLLBACK_ACTION = Object.freeze({
  start_ktk_tunnel: "rollback_ktk_tunnel",
  enable_ktk_tunnel_autostart: "rollback_ktk_tunnel_autostart",
  enable_ktk_mcp_autostart: "rollback_ktk_mcp_autostart",
  enable_ktk_updater_autostart: "rollback_ktk_updater_autostart",
  quarantine_ktk_staging: "restore_ktk_staging",
});
const PLAN_ACTIONS = new Set(Object.keys(SERVICE_ACTIONS));
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

// Privileged operations affect only exact verified KTK WinSW services:
// start a previously stopped Tunnel, or enable automatic startup. Each action
// has a separate, state-checked rollback. Never accepts arbitrary commands,
// process names, paths, OS cleanup, driver actions or model activation.
export function createPcMaintenanceController({
  queryService, startService, stopService, configureService = async () => fail("maintenance_not_configured"),
  staging = null,
  readReceipt = async () => null,
  writeReceipt = async () => {}, now = () => Date.now(), newId = () => randomBytes(16).toString("hex"),
} = {}) {
  if (![queryService, startService, stopService, configureService, readReceipt, writeReceipt, now, newId].every(f => typeof f === "function")) fail("maintenance_unconfigured");
  const plans = new Map();
  let busy = false;
  const service = async name => {
    const state = await queryService(name);
    if (!state || state.name !== name || state.owner_verified !== true ||
        !["Running", "Stopped"].includes(state.status) || !["Manual", "Automatic"].includes(state.start_type)) fail("ktk_service_not_trusted");
    return state;
  };
  const receipt = async () => {
    const value = await readReceipt();
    if (value === null) return null;
    if (!value || value.schema !== 1 || !hexId(value.transaction_id) ||
        !["pending", "applied", "rolling_back", "rolled_back"].includes(value.status) ||
        ROLLBACK_ACTION[value.action] === undefined || value.service !== SERVICE_ACTIONS[value.action]) fail("maintenance_receipt_invalid");
    if (value.action === "quarantine_ktk_staging") {
      if (value.before !== "Active" || value.before_start_type !== "N/A" ||
          !/^update-[A-Za-z0-9]{6}$/.test(value.staging_name) || !/^[a-f0-9]{64}$/.test(value.staging_signature) ||
          !Number.isSafeInteger(value.staging_bytes) || value.staging_bytes < 0) fail("maintenance_receipt_invalid");
    } else if (
        (value.action === "start_ktk_tunnel" ? value.before !== "Stopped" || !["Manual", "Automatic"].includes(value.before_start_type) :
          value.before !== "Running" || value.before_start_type !== "Manual")) fail("maintenance_receipt_invalid");
    return value;
  };
  const stageMatches = (item, entry) => item && item.signature === entry.staging_signature && item.bytes === entry.staging_bytes;
  const plan = async args => {
    const { action } = validateMaintenancePreview(args);
    if (busy) fail("maintenance_busy");
    const target = SERVICE_ACTIONS[action];
    const previous = await receipt();
    if (target === "KTKUpdaterStaging") {
      if (!staging) fail("maintenance_not_configured");
      const isNew = action === "quarantine_ktk_staging";
      const active = previous && ["pending", "applied", "rolling_back"].includes(previous.status);
      const selected = isNew && !active ? (await staging.inspectCandidate()).candidate : null;
      const existing = !isNew && active && previous?.action === "quarantine_ktk_staging" ?
        await staging.inspect(previous.staging_name, "active") : null;
      const archived = !isNew && active && previous?.action === "quarantine_ktk_staging" ?
        await staging.inspect(previous.staging_name, "quarantine") : null;
      const reason = isNew ? active ? "previous_maintenance_active" : !selected ? "no_verified_stale_staging" : null :
        !active ? "no_reversible_maintenance" : previous.action !== "quarantine_ktk_staging" ? "different_rollback_action" :
          (!!existing === !!archived || !stageMatches(existing ?? archived, previous)) ? "maintenance_stage_changed" : null;
      const item = isNew ? selected : previous;
      const details = { status: reason ? "blocked" : "ready_for_owner_confirmation", action,
        service: target, reason, staging_name: item?.staging_name ?? item?.name ?? null,
        staging_bytes: item?.staging_bytes ?? item?.bytes ?? 0,
        effect: isNew ? "Quarantine one stale, HMAC-owned KTK updater download folder on the same drive; preserve its bytes for rollback." :
          "Restore exactly the KTK updater staging folder previously moved by this controller; never overwrite other files.",
        risk: "Disk space is NOT freed; quarantine uses the same volume. Never removes local model weights, user files, Windows Temp or other apps.",
        requires_pc_confirmation: false, requires_owner_chat_confirmation: true,
        executed_by: "KTKQwenUpdater (LocalSystem)", requires_reboot: false, estimated_freed_bytes: 0,
        rollback: isNew ? "restore_ktk_staging (separate owner chat confirmation)" : "Restores original verified KTK staging folder" };
      if (reason) return details;
      const planId = newId();
      if (!hexId(planId)) fail("maintenance_nonce_unavailable");
      plans.clear();
      plans.set(planId, { action, service: target, before: isNew ? "Active" : "Quarantined", before_start_type: "N/A",
        staging_name: item.staging_name ?? item.name, staging_signature: item.staging_signature ?? item.signature,
        staging_bytes: item.staging_bytes ?? item.bytes, expires: now() + PLAN_LIFETIME_MS,
        transaction_id: previous?.transaction_id ?? null });
      return { ...details, plan_id: planId, expires_in_seconds: PLAN_LIFETIME_MS / 1000,
        owner_chat_confirmation: `CONFIRM KTK MAINTENANCE ${planId}` };
    }
    const current = await service(target);
    const isStart = action === "start_ktk_tunnel";
    const isEnable = Object.hasOwn(ROLLBACK_ACTION, action) && !isStart;
    const isNew = isStart || isEnable;
    const active = previous && ["pending", "applied", "rolling_back"].includes(previous.status);
    const reason = isNew ? active ? "previous_maintenance_active" :
      isStart ? current.status !== "Stopped" ? "tunnel_not_stopped" : null :
        current.status !== "Running" || current.start_type !== "Manual" ? "tunnel_not_running_manual" : null :
      !previous || !["pending", "applied", "rolling_back"].includes(previous.status) ? "no_reversible_maintenance" :
        ROLLBACK_ACTION[previous.action] !== action || previous.service !== target ? "different_rollback_action" :
          previous.action === "start_ktk_tunnel" ? current.start_type !== previous.before_start_type ? "service_state_changed" : null :
            current.status !== "Running" || !["Manual", "Automatic"].includes(current.start_type) ? "service_state_changed" : null;
    const details = {
      status: reason ? "blocked" : "ready_for_owner_confirmation", action,
      service: target, current_state: current.status, current_start_type: current.start_type, reason,
      effect: isStart ? "Start only the verified KTK-owned Cloudflare Tunnel service without changing its configuration." :
        action === "rollback_ktk_tunnel" ? "Stop only the same KTK Tunnel service that this maintenance controller started, restoring its previous Stopped state." :
          isEnable ? `Enable delayed automatic startup of only the verified ${target} service; never starts AI or changes other services.` :
            `Restore Manual startup to the same verified ${target} service, leaving its Running status untouched.`,
      risk: isStart ? "May establish a Cloudflare connection; does not download or start the AI model." :
        action === "rollback_ktk_tunnel" ? "Stops the remote MCP tunnel and may disconnect this chat; use local recovery if needed." :
          "Changes only the future Windows startup behavior of this KTK-owned service. Does not start the AI model.",
      requires_pc_confirmation: false, requires_owner_chat_confirmation: true,
      executed_by: "KTKQwenUpdater (LocalSystem)", requires_reboot: false, estimated_freed_bytes: 0,
      rollback: isStart ? "rollback_ktk_tunnel (separate owner chat confirmation)" :
        isEnable ? `${ROLLBACK_ACTION[action]} (separate owner chat confirmation)` :
          action === "rollback_ktk_tunnel" ? "Restores the recorded Stopped state" : "Restores Manual startup type",
    };
    if (reason) return details;
    const planId = newId();
    if (!hexId(planId)) fail("maintenance_nonce_unavailable");
    plans.clear(); // A newer preview invalidates an older unapproved plan.
    plans.set(planId, { action, service: target, before: current.status, before_start_type: current.start_type, expires: now() + PLAN_LIFETIME_MS,
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
      if (entry.service === "KTKUpdaterStaging") {
        if (!staging) fail("maintenance_not_configured");
        const previous = await receipt();
        const isNew = entry.action === "quarantine_ktk_staging";
        if (isNew) {
          if (previous && ["pending", "applied", "rolling_back"].includes(previous.status)) fail("maintenance_state_changed");
          if (!stageMatches(await staging.inspect(entry.staging_name, "active"), entry)) fail("maintenance_stage_changed");
          const tx = { schema: 1, transaction_id: newId(), service: entry.service, action: entry.action,
            before: "Active", before_start_type: "N/A", status: "pending",
            staging_name: entry.staging_name, staging_signature: entry.staging_signature, staging_bytes: entry.staging_bytes };
          if (!hexId(tx.transaction_id)) fail("maintenance_nonce_unavailable");
          await writeReceipt(tx);
          await staging.quarantine(entry.staging_name);
          if (!stageMatches(await staging.inspect(entry.staging_name, "quarantine"), tx)) fail("maintenance_stage_verification_failed");
          await writeReceipt({ ...tx, status: "applied" });
          return { status: "applied", service: entry.service, transaction_id: tx.transaction_id,
            staging_name: entry.staging_name, preserved_bytes: entry.staging_bytes,
            estimated_freed_bytes: 0, rollback_action: "restore_ktk_staging" };
        }
        if (!previous || previous.action !== "quarantine_ktk_staging" ||
            !["pending", "applied", "rolling_back"].includes(previous.status) ||
            previous.transaction_id !== entry.transaction_id || previous.staging_name !== entry.staging_name ||
            !stageMatches({ signature: entry.staging_signature, bytes: entry.staging_bytes }, previous)) fail("maintenance_rollback_unavailable");
        const original = await staging.inspect(entry.staging_name, "active");
        const archived = await staging.inspect(entry.staging_name, "quarantine");
        if (!!original === !!archived || !stageMatches(original ?? archived, previous)) fail("maintenance_stage_changed");
        await writeReceipt({ ...previous, status: "rolling_back" });
        if (archived) await staging.restore(entry.staging_name);
        if (!stageMatches(await staging.inspect(entry.staging_name, "active"), previous)) fail("maintenance_stage_verification_failed");
        await writeReceipt({ ...previous, status: "rolled_back" });
        return { status: "rolled_back", service: entry.service, transaction_id: previous.transaction_id,
          staging_name: entry.staging_name, restored_bytes: entry.staging_bytes };
      }
      const target = entry.service;
      const current = await service(target);
      if (current.status !== entry.before || current.start_type !== entry.before_start_type) fail("maintenance_state_changed");
      const previous = await receipt();
      if (Object.hasOwn(ROLLBACK_ACTION, entry.action)) {
        if (previous && ["pending", "applied", "rolling_back"].includes(previous.status)) fail("maintenance_state_changed");
        if (entry.action === "start_ktk_tunnel" ? current.status !== "Stopped" : current.status !== "Running" || current.start_type !== "Manual") fail("maintenance_state_changed");
        const tx = { schema: 1, transaction_id: newId(), service: target, action: entry.action,
          before: current.status, before_start_type: current.start_type, status: "pending" };
        if (!hexId(tx.transaction_id)) fail("maintenance_nonce_unavailable");
        await writeReceipt(tx); // Durable recovery intent BEFORE modifying SCM.
        if (entry.action === "start_ktk_tunnel") await startService(target);
        else await configureService(target, "Automatic");
        const final = await service(target);
        if (final.status !== "Running" || (entry.action !== "start_ktk_tunnel" && final.start_type !== "Automatic")) fail("maintenance_verification_failed");
        await writeReceipt({ ...tx, status: "applied" });
        return { status: "applied", transaction_id: tx.transaction_id, service: target,
          before: tx.before, after: final.status, before_start_type: tx.before_start_type, after_start_type: final.start_type,
          rollback_action: ROLLBACK_ACTION[entry.action] };
      }
      if (!previous || !["pending", "applied", "rolling_back"].includes(previous.status) || previous.transaction_id !== entry.transaction_id ||
          ROLLBACK_ACTION[previous.action] !== entry.action || previous.service !== target) fail("maintenance_rollback_unavailable");
      if (previous.action === "start_ktk_tunnel" && current.start_type !== previous.before_start_type ||
          previous.action === "enable_ktk_tunnel_autostart" && current.status !== "Running") fail("maintenance_rollback_unavailable");
      await writeReceipt({ ...previous, status: "rolling_back" });
      if (entry.action === "rollback_ktk_tunnel" && current.status !== "Stopped") await stopService(target);
      else if (entry.action !== "rollback_ktk_tunnel" && current.start_type !== "Manual") await configureService(target, "Manual");
      const restored = await service(target);
      if (entry.action === "rollback_ktk_tunnel" ? restored.status !== "Stopped" :
        restored.status !== "Running" || restored.start_type !== "Manual") fail("maintenance_verification_failed");
      await writeReceipt({ ...previous, status: "rolled_back" });
      return { status: "rolled_back", transaction_id: previous.transaction_id, service: target,
        restored: restored.status, restored_start_type: restored.start_type };
    } finally { busy = false; }
  };
  const status = async () => {
    const latest = await receipt();
    return { status: latest?.status ?? "no_previous_maintenance", service: latest?.service ?? SERVICE,
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
  const expected = {
    KTKQwenTunnel: path.win32.join(programFiles, "KTK", "QwenMCP", "KTKQwenTunnel.exe").toLowerCase(),
    KTKQwenMCP: path.win32.join(programFiles, "KTK", "QwenMCP", "KTKQwenMCP.exe").toLowerCase(),
    KTKQwenUpdater: path.win32.join(programFiles, "KTK", "Updater", "KTKQwenUpdater.exe").toLowerCase(),
  };
  const run = async (verb, name, timeout = 7000, extra = []) => {
    if (!Object.hasOwn(expected, name) || (!["qc", "query", "config"].includes(verb) && name !== SERVICE)) fail("invalid_maintenance_action");
    try {
      const { stdout } = await invokeCommand(native, [verb, name, ...extra], { shell: false, windowsHide: true,
        timeout, maxBuffer: 8192, encoding: "utf8",
        env: { SystemRoot: windowsRoot, WINDIR: windowsRoot, PATH: [path.win32.join(windowsRoot, "System32"), windowsRoot].join(";") },
      });
      return String(stdout ?? "");
    } catch { fail("maintenance_scm_unavailable"); }
  };
  return {
    async queryService(name = SERVICE) {
      const config = await run("qc", name);
      const state = await run("query", name);
      const command = config.match(/^\s*BINARY_PATH_NAME\s*:\s*(.+)$/mi)?.[1]?.trim().replace(/^"|"$/g, "").toLowerCase();
      const account = config.match(/^\s*SERVICE_START_NAME\s*:\s*(.+)$/mi)?.[1]?.trim();
      const accountTrusted = name === "KTKQwenUpdater" ? account === "LocalSystem" :
        /^(?:NT AUTHORITY\\)?LocalService$/i.test(account ?? "");
      // Windows may append "(DELAYED)" to an automatic service start type.
      const start = config.match(/^\s*START_TYPE\s*:\s*\d+\s+(AUTO_START|DEMAND_START)(?:\s+\(DELAYED\))?\s*$/mi)?.[1];
      const observed = state.match(/^\s*STATE\s*:\s*\d+\s+([A-Z_]+)\s*$/mi)?.[1];
      return { name, owner_verified: command === expected[name] && accountTrusted,
        status: observed === "RUNNING" ? "Running" : observed === "STOPPED" ? "Stopped" : "Unknown",
        start_type: start === "DEMAND_START" ? "Manual" : start === "AUTO_START" ? "Automatic" : "Unknown" };
    },
    async startService(name = SERVICE) { await run("start", name, 10000); },
    async stopService(name = SERVICE) { await run("stop", name, 10000); },
    async configureService(name = SERVICE, type) {
      if (!["Automatic", "Manual"].includes(type)) fail("invalid_maintenance_action");
      await run("config", name, 10000, ["start=", type === "Automatic" ? "delayed-auto" : "demand"]);
    },
  };
}
