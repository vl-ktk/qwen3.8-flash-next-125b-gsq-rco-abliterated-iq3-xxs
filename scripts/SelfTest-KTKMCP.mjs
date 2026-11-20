import { readFile } from "node:fs/promises";
import { selfTestWindowsOrigin } from "./runtime/device-selftest.mjs";

if (process.platform !== "win32" || process.argv.length !== 5) throw Error("windows_selftest_requires_files");
const [identityFile, enrollmentFile, gatewayFile] = process.argv.slice(2);
try {
  const identity = JSON.parse(await readFile(identityFile, "utf8"));
  const { device_id } = JSON.parse(await readFile(enrollmentFile, "utf8"));
  const gatewayKey = (await readFile(gatewayFile, "utf8")).trim();
  const result = await selfTestWindowsOrigin({ identity, deviceId: device_id, gatewayKey });
  process.stdout.write(`Local MCP self-test: ${result.health}, Ed25519 ${result.attestation}\n`);
} catch {
  process.stderr.write("Local MCP self-test failed\n");
  process.exitCode = 1;
}
