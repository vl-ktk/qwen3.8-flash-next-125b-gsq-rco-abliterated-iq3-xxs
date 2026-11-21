// Native Windows CI: parse the exact embedded PS 5.1 scripts and run a
// read-only host smoke. Never installs, repairs, downloads, or launches AI.
import assert from "node:assert/strict";
import { createWindowsToolRegistry, runPowerShellQuery } from "../../src/windows/windows-tools.mjs";

const names = ["pc_full_audit", "pc_gpu_audit", "pc_storage_audit", "pc_memory_audit", "pc_install_diagnostics"];
const scriptsToParse = [...names, "pc_storage_mapping", "pc_user_task_status"];
if (process.argv.length !== 3 || !["--scripts", "--smoke"].includes(process.argv[2])) throw Error("diagnostic_usage_denied");

if (process.argv[2] === "--scripts") {
  const scripts = [];
  for (const name of scriptsToParse) {
    await runPowerShellQuery(name, {}, { platform: "win32", invoke: async (_file, argv, options) => {
      assert.equal(options.shell, false);
      scripts.push({ name, script: Buffer.from(argv[4], "base64").toString("utf16le") });
      return { stdout: "{}" };
    } });
  }
  process.stdout.write(JSON.stringify(scripts) + "\n");
} else {
  if (process.platform !== "win32") throw Error("diagnostic_smoke_requires_windows");
  const registry = createWindowsToolRegistry();
  for (const name of names) {
    let data;
    try { data = await registry.call(name, {}); }
    catch (error) { throw Error(`${name} smoke failed with ${error?.code ?? "unknown_failure"}`); }
    assert.ok(["observed", "incomplete"].includes(data.status), `Unexpected diagnostic result for ${name}`);
  }
  const readiness = await registry.call("pc_readiness_report", {});
  assert.equal(readiness.mode, "read_only_no_installation");
  assert.ok(["blocked", "unknown", "needs_action", "ready_for_review"].includes(readiness.status));
  process.stdout.write("Five fixed PC queries and one readiness report completed without writes.\n");
}
