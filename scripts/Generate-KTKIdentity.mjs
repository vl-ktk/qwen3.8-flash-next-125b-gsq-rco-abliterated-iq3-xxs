// Runs locally in the elevated Windows installer. Never write private material to stdout.
import { writeFile } from "node:fs/promises";
import { generateDeviceIdentity } from "./runtime/device-identity.mjs";

const destination = process.argv[2];
if (!destination || !/^([a-zA-Z]:\\|\\\\)/.test(destination) || destination.includes('"')) {
  process.stderr.write("invalid_identity_destination\n");
  process.exit(2);
}
const identity = await generateDeviceIdentity();
await writeFile(destination, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(`device_public_key=${identity.public_key}\ndevice_fingerprint=${identity.fingerprint}\n`);
