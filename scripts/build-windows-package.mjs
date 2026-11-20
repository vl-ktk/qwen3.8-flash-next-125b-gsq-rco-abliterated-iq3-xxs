import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWindowsPackage } from "../src/packaging/windows-package.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 3) throw Error("Usage: node scripts/build-windows-package.mjs <vendor-dir> <out.zip> <source-commit-sha>");
const packageLock = JSON.parse(await readFile(path.join(root, "config/windows-package.lock.json"), "utf8"));
const result = await buildWindowsPackage({ sourceRoot: root, vendorDir: path.resolve(args[0]), outFile: path.resolve(args[1]), sourceSha: args[2], packageLock });
process.stdout.write(JSON.stringify({ archive: result.archive, sha256: result.sha256, files: result.fileCount }) + "\n");
