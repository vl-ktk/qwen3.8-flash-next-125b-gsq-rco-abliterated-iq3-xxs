// Called only after the elevated staging installer has created protected ACLs.
// Never print gateway HMAC key or tunnel token.
import { enrollDeviceFromDisk } from "./runtime/device-enrollment.mjs";

if (process.platform !== "win32" || process.argv.length !== 5) throw Error("windows_enrollment_requires_protected_paths");
try {
  await enrollDeviceFromDisk({ identityPath: process.argv[2], secretsDir: process.argv[3], stateDir: process.argv[4] });
} catch (error) {
  process.stderr.write(`Enrollment failed: ${error.message.replace(/[^a-z_0-9]/g, "_")}\n`);
  process.exitCode = 1;
}
