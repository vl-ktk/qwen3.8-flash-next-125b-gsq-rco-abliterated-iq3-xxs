import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWindowsVendors } from "../src/packaging/vendor-fetch.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.resolve(process.argv[2] ?? ".generated/windows-vendors");
const lock = JSON.parse(await readFile(path.join(root, "config/windows-package.lock.json"), "utf8"));
await fetchWindowsVendors({ lock, destination });
process.stdout.write("Verified pinned vendor payloads (no credentials).\n");
