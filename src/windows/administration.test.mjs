import test from "node:test";
import assert from "node:assert/strict";
import { listenWindowsMcp } from "./mcp-server.mjs";
import { createWindowsToolRegistry } from "./windows-tools.mjs";
import { checkLocalHealth, createGracefulShutdown, createLocalRebootGate, createLocalServiceController, getAdminStatus, readInstalledPackageVersion, WINDOWS_MCP_VERSION, WINDOWS_SERVICE_NAME } from "./administration.mjs";
import { runAdminCli } from "./admin-cli.mjs";

test("loopback /healthz returns bounded readiness and runtime version", async t => {
  const server = await listenWindowsMcp({ port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const health = await checkLocalHealth({ port });
  assert.deepEqual(health, { status: "ready", transport: "streamable-http", model: "not_checked", version: WINDOWS_MCP_VERSION });
  const request = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(request.headers.get("cache-control"), "no-store");
  assert.equal((await request.json()).version, WINDOWS_MCP_VERSION);
});

test("health check fails closed for invalid responses, HTTP errors and transport failures", async () => {
  await assert.rejects(() => checkLocalHealth({ port: 0 }), /invalid_health_configuration/);
  await assert.rejects(() => checkLocalHealth({ timeoutMs: 6000 }), /invalid_health_configuration/);
  const invalid = await checkLocalHealth({ fetcher: async () => ({ ok: true, json: async () => ({ status: "ready", model: "loaded" }) }) });
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.reason, "invalid_health_response");
  assert.equal((await checkLocalHealth({ fetcher: async () => ({ ok: false }) })).reason, "health_http_error");
  assert.equal((await checkLocalHealth({ fetcher: async () => { throw Error("secret error"); } })).reason, "health_unreachable");
});

test("admin status reports only verifiable local service and pairing facts", async () => {
  const base = { now: () => new Date("2026-11-20T12:00:00Z"), uptime: () => 18.99, health: { status: "ready", version: "0.13.0" } };
  const ready = await getAdminStatus({ ...base, paired: true, queryService: async name => {
    assert.equal(name, WINDOWS_SERVICE_NAME);
    return [{ status: "Running" }];
  } });
  assert.equal(ready.windows_service.status, "running");
  assert.equal(ready.mcp.uptime_seconds, 18);
  assert.equal(ready.mcp.local_identity_configured, true);
  assert.equal(ready.mcp.cloud_pairing, "not_checked");
  assert.equal(ready.updates.status, "not_checked");
  assert.equal(ready.recovery.status, "not_checked");
  assert.equal(ready.recovery.automatic_os_reboot, null);
  const installed = await getAdminStatus({ ...base, readPackageVersion: async () => "0.18.3" });
  assert.deepEqual(installed.updates, { status: "installed", installed_version: "0.18.3" });
  assert.equal((await getAdminStatus({ ...base, readPackageVersion: async () => { throw Error("private"); } })).updates.installed_version, null);
  assert.equal((await getAdminStatus({ ...base, queryService: async () => [] })).windows_service.status, "not_installed");
  assert.equal((await getAdminStatus({ ...base, queryService: async () => { throw Error("secret"); } })).windows_service.status, "unavailable");
  assert.equal((await getAdminStatus()).mcp.status, "not_checked");
});

test("installed version reads only validated colocated manifest with bounded size", async () => {
  const executable = "C:\\Program Files\\KTK\\QwenMCP\\bin\\node.exe";
  const paths = [];
  const inspect = async p => { paths.push(p); return { isFile: () => true, size: 512 }; };
  const read = async p => { paths.push(p); return JSON.stringify({ schema: 1, target: "windows-x64", package_version: "0.18.3" }); };
  assert.equal(await readInstalledPackageVersion({ executable, read, inspect }), "0.18.3");
  assert.deepEqual(paths, ["C:\\Program Files\\KTK\\QwenMCP\\MANIFEST.json", "C:\\Program Files\\KTK\\QwenMCP\\MANIFEST.json"]);
  assert.equal(await readInstalledPackageVersion({ executable: "C:\\Temp\\node.exe", read, inspect }), null);
  assert.equal(await readInstalledPackageVersion({ executable, read: async () => '{"package_version":"0.18.3"}', inspect }), null);
  assert.equal(await readInstalledPackageVersion({ executable, read: async () => '{"schema":1,"target":"windows-x64","package_version":"bad"}', inspect }), null);
  assert.equal(await readInstalledPackageVersion({ executable, read, inspect: async () => ({ isFile: () => true, size: 1048577 }) }), null);
});

test("Windows service controller defaults to deny and uses fixed sc.exe arguments", async () => {
  const calls = [];
  const invoke = async (exe, args, opts) => { calls.push({ exe, args, opts }); return { stdout: "" }; };
  const forbidden = createLocalServiceController({ platform: "win32", invoke });
  await assert.rejects(() => forbidden.execute("start"), /admin_confirmation_required/);
  await assert.rejects(() => forbidden.execute("delete"), /unknown_admin_action/);
  await assert.rejects(() => createLocalServiceController({ platform: "linux", invoke, authorization: () => true }).execute("stop"), /windows_unavailable/);
  assert.equal(calls.length, 0);
  const approved = createLocalServiceController({ platform: "win32", invoke, systemRoot: "C:\\Windows", authorization: () => true });
  assert.deepEqual(await approved.execute("start"), { status: "requested", service_name: WINDOWS_SERVICE_NAME });
  await approved.execute("stop");
  await approved.execute("configure_recovery");
  assert.deepEqual(calls.map(c => c.args[0]), ["start", "stop", "failure"]);
  assert.ok(calls.every(c => c.exe === "C:\\Windows\\System32\\sc.exe" && c.opts.shell === false && c.opts.timeout === 15000));
  assert.equal(calls[2].args.includes("restart/60000/restart/120000/none/0"), true);
  assert.equal(approved.recoveryPlan().restart_computer, false);
});

test("restart waits for STOPPED before START and never loops after timeout", async () => {
  const seen = [];
  let reads = 0;
  const ctrl = createLocalServiceController({
    platform: "win32", authorization: () => true, sleep: async () => {},
    invoke: async (_, args) => {
      seen.push(args[0]);
      if (args[0] === "query") return { stdout: `STATE : ${++reads >= 3 ? "1 STOPPED" : "4 RUNNING"}` };
      return { stdout: "" };
    },
  });
  await ctrl.execute("restart");
  assert.deepEqual(seen, ["query", "stop", "query", "query", "start"]);
  const neverStops = createLocalServiceController({
    platform: "win32", authorization: () => true, sleep: async () => {},
    invoke: async (_, args) => ({ stdout: args[0] === "query" ? "STATE : 4 RUNNING" : "" }),
  });
  await assert.rejects(() => neverStops.execute("restart"), /service_stop_timeout/);
});

test("restart never issues START when Windows service state is ambiguous", async () => {
  const seen = [];
  const ctrl = createLocalServiceController({ platform: "win32", authorization: () => true,
    invoke: async (_, args) => { seen.push(args[0]); return { stdout: "unexpected localized or corrupt response" }; },
  });
  await assert.rejects(() => ctrl.execute("restart"), /service_state_unavailable/);
  assert.deepEqual(seen, ["query"]);
});

test("reboot requires one-use challenge, local cancellable countdown and no implicit /f", async () => {
  let time = 1000, granted = false;
  const calls = [], timers = [];
  const factory = () => createLocalRebootGate({
    platform: "win32", now: () => time, random: () => Buffer.alloc(16, 7),
    authorization: async () => granted,
    invoke: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: "" }; },
    setTimer: (callback, ms) => { const entry = { callback, ms, cancelled: false }; timers.push(entry); return entry; },
    clearTimer: timer => { timer.cancelled = true; },
  });
  const gate = factory();
  const first = gate.prepare();
  assert.equal(first.code.length, 32);
  await assert.rejects(() => gate.confirm("bad"), /reboot_confirmation_required/);
  await assert.rejects(() => gate.confirm(first.code), /reboot_confirmation_required/);
  const timedOut = factory();
  const expired = timedOut.prepare();
  time += 60000;
  await assert.rejects(() => timedOut.confirm(expired.code), /reboot_confirmation_required/);
  const fresh = factory();
  const code = fresh.prepare().code;
  await assert.rejects(() => fresh.confirm(code), /reboot_confirmation_required/);
  granted = true;
  const authorized = factory();
  const result = await authorized.confirm(authorized.prepare().code);
  assert.equal(result.status, "local_countdown");
  assert.equal(result.cancel_method, "local_console");
  assert.equal(timers[0].ms, 120000);
  assert.equal(calls.length, 0);
  await assert.rejects(() => Promise.resolve().then(() => authorized.prepare()), /reboot_already_pending/);
  await timers[0].callback();
  assert.deepEqual(await authorized.wait(), { status: "reboot_requested", force_close: false });
  assert.deepEqual(calls[0].args.slice(0, 3), ["/r", "/t", "0"]);
  assert.ok(!calls[0].args.includes("/f"));
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls.length, 1);
  const cancelGate = factory();
  await cancelGate.confirm(cancelGate.prepare().code);
  assert.equal(cancelGate.cancel(), true);
  assert.equal(timers[1].cancelled, true);
  assert.deepEqual(await cancelGate.wait(), { status: "cancelled" });
  assert.equal(cancelGate.cancel(), false);
  assert.equal(calls.length, 1);
});

test("graceful shutdown drains streams, exits once and handles a forced deadline", () => {
  let finish, timer, exited = [], ended = 0, forced = 0;
  const fake = { endMcpStreams: () => ended++, close: cb => { finish = cb; }, closeAllConnections: () => forced++ };
  const stop = createGracefulShutdown(fake, { setTimer: fn => { timer = fn; return { unref() {} }; }, clearTimer: () => {}, exit: n => exited.push(n) });
  assert.equal(stop(), true);
  assert.equal(stop(), false);
  finish();
  timer();
  assert.deepEqual(exited, [0]);
  assert.equal(ended, 1);
  assert.equal(forced, 0);
  const exitErrors = [];
  const forcedStop = createGracefulShutdown(fake, { setTimer: fn => { timer = fn; return { unref() {} }; }, clearTimer: () => {}, exit: n => exitErrors.push(n) });
  forcedStop();
  timer();
  assert.deepEqual(exitErrors, [1]);
  assert.equal(forced, 1);
});

test("remote admin_status is strictly read-only and sends no local lifecycle commands", async () => {
  const seen = [];
  const tools = createWindowsToolRegistry({ identityConfigured: true, runWindowsQuery: async (name, args) => {
    seen.push({ name, args });
    return [{ status: "Running" }];
  } });
  const listed = tools.list().find(tool => tool.name === "admin_status");
  assert.equal(listed.annotations.readOnlyHint, true);
  assert.equal(listed.inputSchema.additionalProperties, false);
  const status = await tools.call("admin_status", {});
  assert.equal(status.windows_service.status, "running");
  assert.equal(status.mcp.status, "ready");
  assert.deepEqual(seen, [{ name: "service_status", args: { name: WINDOWS_SERVICE_NAME } }]);
  for (const bad of [{ action: "reboot" }, { command: "Stop-Service" }, null]) await assert.rejects(() => tools.call("admin_status", bad), /invalid_arguments/);
  for (const command of ["service_start", "service_stop", "reboot", "update", "shutdown"]) assert.equal(tools.has(command), false);
});

test("local CLI refuses unattended changes and requires literal confirmations", async () => {
  let stdout = "", invocations = 0;
  const write = v => stdout += v;
  const denied = await runAdminCli({ args: ["reboot"], platform: "win32", interactive: false, write,
    makeRebootGate: () => { invocations++; throw Error("must not execute"); } });
  assert.equal(denied, 2);
  assert.equal(invocations, 0);
  assert.match(stdout, /admin_confirmation_required/);
  stdout = "";
  const calls = [];
  const code = await runAdminCli({ args: ["start"], platform: "win32", interactive: true, write,
    ask: async () => "CONFIRM START KTKQwenMCP",
    makeController: opts => ({ execute: async action => { assert.equal(await opts.authorization(action), true); calls.push(action); return { status: "requested" }; } }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["start"]);
  const declined = await runAdminCli({ args: ["start"], platform: "win32", interactive: true, write,
    ask: async () => "yes", makeController: opts => ({ execute: async action => { assert.equal(await opts.authorization(action), false); throw Object.assign(Error(), { code: "admin_confirmation_required" }); } }),
  });
  assert.equal(declined, 1);
  assert.match(stdout, /admin_confirmation_required/);
  assert.equal(await runAdminCli({ args: ["unknown"], write }), 2);
});

test("local CLI status never claims a deployed update, even without Windows", async () => {
  let output = "";
  const code = await runAdminCli({ args: ["status"], platform: "linux", paired: false,
    write: v => output += v, healthCheck: async () => ({ status: "unavailable", reason: "health_unreachable" }),
    readService: async () => { throw Error("should not query Windows"); },
  });
  assert.equal(code, 0);
  const status = JSON.parse(output);
  assert.equal(status.mcp.status, "unavailable");
  assert.equal(status.windows_service.status, "unavailable");
  assert.equal(status.updates.installed_version, null);
  assert.equal(status.recovery.automatic_os_reboot, null);
});

test("local reboot CLI accepts only both confirmations and cancels on Enter", async () => {
  let output = "", cancelCount = 0, confirmed = 0;
  let resolveCount;
  const waiting = new Promise(resolve => { resolveCount = resolve; });
  const gate = {
    prepare: () => ({ code: "challenge-123", expires_in_seconds: 60 }),
    confirm: async code => { assert.equal(code, "challenge-123"); confirmed++; return { status: "local_countdown" }; },
    wait: () => waiting,
    cancel: () => { cancelCount++; resolveCount({ status: "cancelled" }); return true; },
  };
  const result = await runAdminCli({ args: ["reboot"], platform: "win32", interactive: true,
    write: str => { output += str; },
    ask: async question => question.startsWith("Введите CONFIRM") ? "CONFIRM REBOOT KTKQwenMCP" : question.startsWith("Повторите код") ? "challenge-123" : "",
    makeRebootGate: () => gate,
  });
  assert.equal(result, 0);
  assert.equal(confirmed, 1);
  assert.ok(cancelCount >= 1);
  assert.match(output, /cancelled/);
});

test("local reboot CLI rejects a wrong code before scheduling", async () => {
  let scheduled = 0, output = "";
  const code = await runAdminCli({ args: ["reboot"], platform: "win32", interactive: true,
    write: str => { output += str; },
    ask: async question => question.startsWith("Повторите код") ? "WRONG" : "CONFIRM REBOOT KTKQwenMCP",
    makeRebootGate: options => createLocalRebootGate({ ...options,
      random: () => Buffer.alloc(16, 9), setTimer: () => { scheduled++; return {}; },
    }),
  });
  assert.equal(code, 1);
  assert.equal(scheduled, 0);
  assert.match(output, /reboot_confirmation_required/);
});
