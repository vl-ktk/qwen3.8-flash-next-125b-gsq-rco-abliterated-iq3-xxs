import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWindowsToolRegistry, runPowerShellQuery } from "./windows-tools.mjs";
import { listenWindowsMcp } from "./mcp-server.mjs";

test("read-only allowlist has stable schemas; no arbitrary command, script, write or service control", () => {
  const tools = createWindowsToolRegistry();
  assert.deepEqual(tools.list().map(item => item.name), ["system_info", "system_monitor", "process_list", "service_status", "app_status", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan"]);
  assert.equal(tools.has("powershell"), false);
  assert.equal(tools.has("file_read"), false); // default-deny until installer configures roots
  for (const name of ["system_info", "system_monitor", "process_list", "service_status", "app_status", "admin_status", "pc_preflight", "storage_check", "runtime_check", "installation_plan"]) {
    const definition = tools.list().find(item => item.name === name);
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.inputSchema.additionalProperties, false);
  }
  const copy = tools.list();
  copy[0].name = "hijacked";
  assert.equal(tools.list()[0].name, "system_info");
});

test("configured gateway exposes only pinned update operations, never arbitrary commands", async () => {
  const calls = [];
  const registry = createWindowsToolRegistry({ updaterKey: "test-key", updater: async (action, args) => {
    calls.push({ action, args }); return { status: "ok" };
  } });
  assert.equal(registry.has("update_status"), true);
  assert.equal(registry.has("update_apply"), true);
  assert.equal(registry.has("update_resume"), true);
  assert.deepEqual(await registry.call("update_resume", {}), { status: "ok" });
  assert.deepEqual(await registry.call("update_status", {}), { status: "ok" });
  assert.deepEqual(calls.map(call => call.action), ["resume", "status"]);
  await assert.rejects(() => registry.call("update_resume", { command: "cmd.exe" }), /invalid_arguments/);
  await assert.rejects(() => registry.call("update_apply", { version: "0.18.7" }), /invalid_update_offer/);
});

test("all PowerShell tool arguments are validated and mapped to static query kinds", async () => {
  const calls = [];
  const tools = createWindowsToolRegistry({ runWindowsQuery: async (name, args) => { calls.push({ name, args }); return { ok: true }; } });
  for (const [name, args] of [
    ["system_info", {}],
    ["process_list", {}],
    ["process_list", { name: "chrome", limit: 25 }],
    ["service_status", { name: "WinDefend" }],
    ["app_status", { name: "steam" }],
  ]) assert.deepEqual(await tools.call(name, args), { ok: true });
  assert.deepEqual(calls[0], { name: "system_info", args: {} });
  assert.deepEqual(calls[1], { name: "process_list", args: { name: null, limit: 20 } });
  assert.deepEqual(calls[2], { name: "process_list", args: { name: "chrome", limit: 25 } });
  assert.equal(calls.length, 5);
});

test("injection, wildcard, arbitrary args and resource-abuse inputs fail before PowerShell", async () => {
  let called = 0;
  const tools = createWindowsToolRegistry({ runWindowsQuery: async () => { called++; return {}; } });
  const bad = [
    ["system_info", { command: "whoami" }],
    ["system_monitor", { command: "Get-Process" }],
    ["system_monitor", { interval: 1 }],
    ["pc_preflight", { command: "whoami" }],
    ["storage_check", { volume: "C:" }],
    ["runtime_check", { script: "curl" }],
    ["installation_plan", { install: true }],
    ["process_list", { limit: 0 }],
    ["process_list", { limit: 5000 }],
    ["process_list", { name: "*" }],
    ["process_list", { name: "chrome; Stop-Service WinDefend" }],
    ["process_list", { name: "$(Remove-Item C:\\)" }],
    ["process_list", { name: "chrome", command: "whoami" }],
    ["service_status", { name: "Spooler | Out-File C:\\tmp" }],
    ["app_status", { name: "steam`whoami" }],
    ["service_status", {}],
    ["app_status", { name: "" }],
    ["process_list", null],
    ["powershell", { command: "echo pwnd" }],
  ];
  for (const [name, args] of bad) await assert.rejects(() => tools.call(name, args));
  assert.equal(called, 0);
});

test("PowerShell uses static -EncodedCommand, isolated environment, no shell and bounded resources", async () => {
  const payload = "WinDefend";
  const captures = [];
  const result = await runPowerShellQuery("service_status", { name: payload }, {
    platform: "win32",
    invoke: async (file, argv, options) => {
      captures.push({ file, argv, options });
      return { stdout: '[{"name":"WinDefend","status":"Running"}]\r\n', stderr: "" };
    },
  });
  assert.deepEqual(result, [{ name: "WinDefend", status: "Running" }]);
  const { file, argv, options } = captures[0];
  assert.match(file.toLowerCase(), /windows\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/);
  assert.deepEqual(argv.slice(0, 3), ["-NoProfile", "-NonInteractive", "-NoLogo"]);
  assert.equal(argv[3], "-EncodedCommand");
  const script = Buffer.from(argv[4], "base64").toString("utf16le");
  assert.match(script, /Get-Service/);
  assert.equal(script.includes(payload), false);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 8000);
  assert.equal(options.maxBuffer, 40960);
  assert.deepEqual(JSON.parse(Buffer.from(options.env.QWEN_MCP_ARGS_B64, "base64").toString("utf8")), { name: payload });
  for (const key of Object.keys(options.env)) assert.ok(["SystemRoot", "WINDIR", "PSModulePath", "COMPUTERNAME", "QWEN_MCP_ARGS_B64"].includes(key));
});

test("PowerShell failure and malformed output do not disclose stderr or command", async () => {
  await assert.rejects(() => runPowerShellQuery("process_list", { limit: 1 }, { platform: "linux" }), /windows_unavailable/);
  await assert.rejects(() => runPowerShellQuery("bogus", {}, { platform: "win32" }), /unknown_tool/);
  await assert.rejects(() => runPowerShellQuery("process_list", {}, { platform: "win32", invoke: async () => { throw Error("super-secret stderr"); } }), /powershell_unavailable/);
  await assert.rejects(() => runPowerShellQuery("process_list", {}, { platform: "win32", invoke: async () => ({ stdout: "not JSON" }) }), /powershell_unavailable/);
});

async function tempRoots(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "qwen-mcp-allowlist-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  return { base, allowed, outside };
}

test("file_read grants only explicit roots, uses canonical paths and limits output", async t => {
  const { allowed, outside } = await tempRoots(t);
  const inside = path.join(allowed, "report.log");
  const denied = path.join(outside, "private.log");
  await writeFile(inside, "Line 1\nLine 2\n", "utf8");
  await writeFile(denied, "NEVER EXPOSE", "utf8");
  const tools = createWindowsToolRegistry({ allowedFileRoots: [allowed] });
  assert.equal(tools.has("file_read"), true);
  assert.deepEqual(await tools.call("file_read", { path: inside }), { path: inside, content: "Line 1\nLine 2\n" });
  await assert.rejects(() => tools.call("file_read", { path: denied }), /file_denied/);
  await assert.rejects(() => tools.call("file_read", { path: path.join(allowed, "..", "outside", "private.log") }), /file_denied/);
  await symlink(denied, path.join(allowed, "alias.log"));
  await assert.rejects(() => tools.call("file_read", { path: path.join(allowed, "alias.log") }), /file_denied/);
  await writeFile(path.join(allowed, ".env"), "API_KEY=secret");
  await assert.rejects(() => tools.call("file_read", { path: path.join(allowed, ".env") }), /file_denied/);
  await writeFile(path.join(allowed, "client.key"), "private key");
  await assert.rejects(() => tools.call("file_read", { path: path.join(allowed, "client.key") }), /file_denied/);
  const large = path.join(allowed, "large.log");
  await writeFile(large, "x".repeat(32769));
  await assert.rejects(() => tools.call("file_read", { path: large }), /file_denied/);
});

test("file_read never advertises access without roots and rejects relative/malformed paths", async t => {
  const { allowed } = await tempRoots(t);
  assert.throws(() => createWindowsToolRegistry({ allowedFileRoots: ["relative/path"] }), /invalid_file_roots/);
  const tools = createWindowsToolRegistry({ allowedFileRoots: [allowed] });
  for (const filepath of ["report.log", "", "../secret.log", "x\0y.log", "x".repeat(1100)]) {
    await assert.rejects(() => tools.call("file_read", { path: filepath }));
  }
  await assert.rejects(() => tools.call("file_read", { path: "/some/log", extra: "x" }), /invalid_arguments/);
});

test("MCP tool call returns structured data and safely redacted failures", async t => {
  const reg = createWindowsToolRegistry({ runWindowsQuery: async (name) => name === "system_info" ? { os: "Windows 10", cores: 16 } : Promise.reject(Error("SECRET-STDERR")) });
  const server = await listenWindowsMcp({ port: 0, originVerifier: () => true, toolRegistry: reg });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (name, args = {}) => fetch(root + "/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  });
  const good = await post("system_info");
  assert.equal(good.status, 200);
  const result = (await good.json()).result;
  assert.deepEqual(JSON.parse(result.content[0].text), { os: "Windows 10", cores: 16 });
  assert.equal(result.isError, false);
  const bad = await post("service_status", { name: "WinDefend" });
  assert.equal(bad.status, 200);
  const failed = (await bad.json()).result;
  assert.equal(failed.isError, true);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET-STDERR/);
  const injected = await post("service_status", { name: "name;whoami" });
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).error.code, -32602);
  const forbidden = await post("powershell", { command: "Get-Process" });
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json()).error.code, -32602);
});
