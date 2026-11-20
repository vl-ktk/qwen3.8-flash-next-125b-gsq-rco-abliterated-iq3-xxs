// Local Windows uninstall companion. Never prints the private signing key.
import { readFile } from "node:fs/promises";
import { revokeDevice } from "./runtime/device-revocation.mjs";

if (process.platform !== "win32" || process.argv.length !== 4) throw Error("windows_unpair_requires_paths");
try {
  const identity = JSON.parse(await readFile(process.argv[2], "utf8"));
  const receipt = JSON.parse(await readFile(process.argv[3], "utf8"));
  if (receipt.schema !== 1) throw Error("invalid_enrollment_receipt");
  await revokeDevice(identity, receipt.device_id);
  process.stdout.write("Remote device pairing revoked\n");
} catch {
  process.stderr.write("Remote device revocation failed; uninstall must remain locked and incomplete\n");
  process.exitCode = 1;
}
