import test from "node:test";
import assert from "node:assert/strict";
import { parseNvidiaCsv, parseNvidiaSmiOutput, queryNvidiaGpus, normalizeSystemCounters, collectWindowsMonitoring } from "./monitoring.mjs";
import { createWindowsToolRegistry, runPowerShellQuery } from "./windows-tools.mjs";
import { listenWindowsMcp } from "./mcp-server.mjs";

const MIB = 1024 * 1024;
const sample = {
  cpu_usage_percent: 32,
  ram_total_bytes: 64 * MIB,
  ram_free_bytes: 16 * MIB,
  fixed_disks: [
    { drive: "C:", total_bytes: 2048 * MIB, free_bytes: 512 * MIB },
    { drive: "D:", total_bytes: 4096 * MIB, free_bytes: 2048 * MIB },
  ],
  events: [{ event_id: 41, provider: "Microsoft-Windows-Kernel-Power", at: "2026-11-19T14:00:00.000Z", level: "Critical" }],
  events_status: "ok",
};

test("NVIDIA CSV supports quoted GPU names, quoted commas and literal escaped quotes", () => {
  assert.deepEqual(parseNvidiaCsv('0, "NVIDIA, RTX ""test""", 999.12, 100, 8192, 0, 73'),
    ["0", 'NVIDIA, RTX "test"', "999.12", "100", "8192", "0", "73"]);
  assert.deepEqual(parseNvidiaSmiOutput('0, "NVIDIA, RTX ""test""", 999.12, 100, 8192, 0, 73\r\n'), [{
    index: 0, name: 'NVIDIA, RTX "test"', driver_version: "999.12", utilization_percent: 100,
    vram_total_bytes: 8192 * MIB, vram_used_bytes: 0, temperature_c: 73,
  }]);
});

test("NVIDIA absent counters stay null, multiple GPUs allowed, never fabricate temperature", () => {
  const output = "0, NVIDIA GeForce RTX 3090 Ti, 566.36, N/A, 24576, [Not Supported], N/A\n1, Test GPU, 566.36, 0, 12288, 1024, 0";
  const [a, b] = parseNvidiaSmiOutput(output);
  assert.equal(a.vram_total_bytes, 24576 * MIB);
  assert.equal(a.vram_used_bytes, null);
  assert.equal(a.utilization_percent, null);
  assert.equal(a.temperature_c, null);
  assert.equal(b.vram_used_bytes, 1024 * MIB);
  assert.equal(b.temperature_c, 0);
});

test("NVIDIA parser rejects missing fields, bad identifiers, duplicate indices and oversized output", () => {
  for (const bad of ["", "0,RTX", "not-int, GPU, 1, 1, 1, 1, 1", "0, GPU, 1, 1, 1, 1, 1\n0, GPU, 1, 1, 1, 1, 1", '0, "GPU, 1, 1, 1, 1, 1', "x".repeat(16385)]) {
    assert.throws(() => parseNvidiaSmiOutput(bad), /invalid_gpu_output/);
  }
});

test("NVIDIA executable is selected from restricted Windows paths and invoked without shell or secrets", async () => {
  const calls = [];
  const result = await queryNvidiaGpus({
    platform: "win32", systemRoot: "C:\\Windows", programFiles: "C:\\Program Files",
    exists: async filepath => { calls.push({ probe: filepath }); return { isFile: () => filepath.endsWith("System32\\nvidia-smi.exe") }; },
    invoke: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "0, NVIDIA GeForce RTX 3090 Ti, 566.36, 11, 24576, 2048, 64\r\n" };
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.gpus[0].vram_used_bytes, 2048 * MIB);
  assert.equal(result.gpus[0].temperature_c, 64);
  const call = calls.find(entry => entry.file);
  assert.equal(call.file, "C:\\Windows\\System32\\nvidia-smi.exe");
  assert.deepEqual(call.args, ["--query-gpu=index,name,driver_version,utilization.gpu,memory.total,memory.used,temperature.gpu", "--format=csv,noheader,nounits"]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 5000);
  assert.equal(call.options.maxBuffer, 16384);
  assert.deepEqual(Object.keys(call.options.env).sort(), ["SystemRoot", "WINDIR"]);
});

test("NVIDIA unavailable is explicit for wrong platform, absent driver, command failure and malformed data", async () => {
  assert.deepEqual(await queryNvidiaGpus({ platform: "linux" }), { status: "unavailable", reason: "not_windows", gpus: [] });
  const base = { platform: "win32", exists: async () => { throw Error("absent"); } };
  assert.deepEqual(await queryNvidiaGpus(base), { status: "unavailable", reason: "nvidia_smi_not_found", gpus: [] });
  const present = { platform: "win32", exists: async () => ({ isFile: () => true }) };
  assert.equal((await queryNvidiaGpus({ ...present, invoke: async () => { throw Error("driver error secret"); } })).reason, "nvidia_smi_failed");
  assert.equal((await queryNvidiaGpus({ ...present, invoke: async () => ({ stdout: "bad data" }) })).reason, "invalid_gpu_output");
});

test("system counters normalize RAM, CPU, fixed drives, 24-hour event metadata; CPU sensor unavailable", () => {
  const result = normalizeSystemCounters(sample);
  assert.deepEqual(result.cpu, { usage_percent: 32, temperature_c: null, temperature_status: "unsupported_without_sensor_provider" });
  assert.deepEqual(result.ram, { total_bytes: 64 * MIB, free_bytes: 16 * MIB, used_bytes: 48 * MIB, used_percent: 75 });
  assert.deepEqual(result.fixed_disks[0], { drive: "C:", total_bytes: 2048 * MIB, free_bytes: 512 * MIB, media_type: "unknown" });
  assert.deepEqual(result.diagnostics.recent_system_events[0], sample.events[0]);
  assert.equal(result.diagnostics.window_hours, 24);
});

test("missing or invalid performance data is null; never report SSD when volume media is unknown", () => {
  const result = normalizeSystemCounters({
    cpu_usage_percent: "N/A", ram_total_bytes: null, ram_free_bytes: 100,
    fixed_disks: [{ drive: "C:", total_bytes: 10, free_bytes: 20 }, { drive: "\\\\attacker", total_bytes: 1, free_bytes: 1 }],
    events: Array.from({ length: 20 }, (_, i) => ({ event_id: i, provider: "x".repeat(200), message: "secret" })),
  });
  assert.equal(result.cpu.usage_percent, null);
  assert.equal(result.ram.used_bytes, null);
  assert.equal(result.fixed_disks.length, 1);
  assert.equal(result.fixed_disks[0].free_bytes, null);
  assert.equal(result.fixed_disks[0].media_type, "unknown");
  assert.equal(result.diagnostics.recent_system_events.length, 5);
  assert.equal(result.diagnostics.recent_system_events[0].provider.length, 120);
  assert.equal("message" in result.diagnostics.recent_system_events[0], false);
  assert.equal(result.diagnostics.status, "unavailable_or_empty");
  assert.throws(() => normalizeSystemCounters(null), /invalid_system_counters/);
});

test("collector combines bounded system and GPU snapshots; missing GPU preserves Windows metrics", async () => {
  const observedAt = new Date("2026-11-19T17:30:00Z");
  const readSystem = async () => sample;
  const failedGpu = await collectWindowsMonitoring({ readSystem, readGpu: async () => { throw Error("secret error"); }, now: () => observedAt });
  assert.equal(failedGpu.observed_at, observedAt.toISOString());
  assert.equal(failedGpu.cpu.usage_percent, 32);
  assert.deepEqual(failedGpu.gpu, { status: "unavailable", reason: "gpu_monitor_failed", gpus: [] });
  const malformedGpu = await collectWindowsMonitoring({ readSystem, readGpu: async () => ({ status: "ok", gpus: null }) });
  assert.equal(malformedGpu.gpu.status, "unavailable");
  await assert.rejects(() => collectWindowsMonitoring({ readGpu: async () => ({}) }), /monitor_query_unconfigured/);
});

test("PowerShell monitoring executes static read-only query with 12 second bound and no request params", async () => {
  let call;
  const response = await runPowerShellQuery("system_monitor", {}, {
    platform: "win32",
    invoke: async (file, argv, options) => {
      call = { file, argv, options };
      return { stdout: JSON.stringify(sample) };
    },
  });
  assert.deepEqual(response, sample);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 12000);
  assert.equal(call.options.maxBuffer, 40960);
  const script = Buffer.from(call.argv[4], "base64").toString("utf16le");
  assert.match(script, /Get-WinEvent/);
  assert.match(script, /Win32_LogicalDisk/);
  assert.doesNotMatch(script, /Invoke-Expression|Set-Service|Remove-Item|Start-Process/);
});

test("registry exposes monitoring read-only to MCP and rejects unsupported arguments", async t => {
  const observedAt = new Date("2026-11-19T17:30:00Z");
  const registry = createWindowsToolRegistry({
    runWindowsQuery: async name => { assert.equal(name, "system_monitor"); return sample; },
    readNvidia: async () => ({ status: "unavailable", reason: "not_installed", gpus: [] }),
  });
  assert.equal(registry.list().find(tool => tool.name === "system_monitor").annotations.readOnlyHint, true);
  await assert.rejects(() => registry.call("system_monitor", { process: "explorer" }), /invalid_arguments/);
  const metrics = await registry.call("system_monitor", {});
  assert.equal(metrics.cpu.usage_percent, 32);
  assert.equal(metrics.gpu.reason, "not_installed");
  assert.notEqual(metrics.observed_at, observedAt.toISOString());

  const server = await listenWindowsMcp({ port: 0, toolRegistry: registry });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const send = args => fetch(`${root}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "system_monitor" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system_monitor", arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  });
  const ok = await send({});
  assert.equal(ok.status, 200);
  const body = (await ok.json()).result;
  assert.equal(body.isError, false);
  assert.equal(JSON.parse(body.content[0].text).gpu.status, "unavailable");
  const bad = await send({ command: "Get-Process" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32602);
});
