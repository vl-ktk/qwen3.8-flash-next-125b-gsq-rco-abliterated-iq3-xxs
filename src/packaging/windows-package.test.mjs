import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWindowsPackage, sha256File, validatePackageLock } from "./windows-package.mjs";
import { fetchWindowsVendors } from "./vendor-fetch.mjs";

const run = promisify(execFile);
const fakeHash = content => createHash("sha256").update(content).digest("hex");
const readZip = async (archive, name) => (await run("unzip", ["-p", archive, name], { encoding: "buffer", maxBuffer: 5 * 1024 * 1024 })).stdout;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktk-packaging-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "repo"), vendorDir = path.join(root, "vendor");
  await mkdir(path.join(sourceRoot, "src/windows"), { recursive: true });
  await mkdir(path.join(sourceRoot, "scripts"), { recursive: true });
  await mkdir(path.join(sourceRoot, "config"), { recursive: true });
  for (const name of ["admin-cli", "administration", "device-identity", "device-bootstrap", "device-enrollment", "device-selftest", "device-revocation", "emergency-lock", "main", "mcp-server", "model-preflight", "pc-diagnostics", "pc-maintenance", "pc-updater-staging", "monitoring", "origin-auth", "windows-tools", "strata-installer", "sc117-model", "sc117-inference", "local-ai-setup", "remote-update"]) {
    await writeFile(path.join(sourceRoot, `src/windows/${name}.mjs`), `export const ${name.replace(/-/g, "_")} = true;\n`);
  }
  await writeFile(path.join(sourceRoot, "src/windows/strata-runtime.lock.json"), '{}\n');
  await writeFile(path.join(sourceRoot, "src/windows/sc117-model.lock.json"), '{}\n');
  await writeFile(path.join(sourceRoot, "scripts/Verify-KTKPackage.ps1"), "# check sha256\n");
  await writeFile(path.join(sourceRoot, "scripts/Install-KTKMCP.ps1"), "# stage only; no startup\n");
  await writeFile(path.join(sourceRoot, "scripts/Generate-KTKIdentity.mjs"), "export const generate = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Enroll-KTKMCP.mjs"), "export const enroll = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/SelfTest-KTKMCP.mjs"), "export const selftest = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Activate-KTKMCP.ps1"), "# owner approval required\n");
  await writeFile(path.join(sourceRoot, "scripts/Maintain-KTKMCP.ps1"), "# confirmed repair, update, rollback, uninstall\n");
  await writeFile(path.join(sourceRoot, "scripts/Revoke-KTKMCP.mjs"), "export const revoke = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Install-KTKStrata.mjs"), "export const strata = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Prepare-KTKSC117.mjs"), "export const sc117 = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Test-KTKSC117.mjs"), "export const inference = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Install-KTKLocalAI.mjs"), "export const localAi = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Show-KTKLocalAI.ps1"), "# GUI runner for original user\n");
  await writeFile(path.join(sourceRoot, "scripts/Run-KTKIntegratedAcceptance.ps1"), "# exact MCP version resume\n");
  await writeFile(path.join(sourceRoot, "scripts/Install-KTKUpdater.ps1"), "# initialize authorized updater\n");
  await writeFile(path.join(sourceRoot, "scripts/Set-KTKLocalAIOptIn.ps1"), "# admin-only opt-in after local AI acceptance\n");
  await writeFile(path.join(sourceRoot, "scripts/Install-KTKUserUpdater.ps1"), "# user task registration\n");
  await writeFile(path.join(sourceRoot, "scripts/Run-KTKUserUpdate.mjs"), "export const userUpdater = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Apply-KTKUnifiedRelease.ps1"), "# fixed verified release transaction\n");
  await writeFile(path.join(sourceRoot, "scripts/Run-KTKRemoteUpdate.ps1"), "# fixed privileged update\n");
  await writeFile(path.join(sourceRoot, "scripts/Run-KTKUpdater.mjs"), "export const updater = true;\n");
  await writeFile(path.join(sourceRoot, "scripts/Run-KTKAcceptance.ps1"), "# one entry acceptance and report\n");
  await writeFile(path.join(sourceRoot, "scripts/Assert-KTKStaged.ps1"), "# safety gate before enrollment resume\n");
  await writeFile(path.join(sourceRoot, "scripts/Start-KTKMCP.cmd"), "@echo off\n");
  await writeFile(path.join(sourceRoot, "config/KTKQwenMCP.xml"), "<service><id>KTKQwenMCP</id></service>\n");
  await writeFile(path.join(sourceRoot, "config/KTKQwenTunnel.xml"), "<service><id>KTKQwenTunnel</id></service>\n");
  await writeFile(path.join(sourceRoot, "config/KTKQwenUpdater.xml"), "<service><id>KTKQwenUpdater</id></service>\n");
  await writeFile(path.join(sourceRoot, "config/windows-mcp.defaults.json"), '{"bind":"127.0.0.1"}\n');
  await writeFile(path.join(sourceRoot, "src/windows/private-key.pem"), "DO_NOT_BUNDLE_SECRET");
  await writeFile(path.join(sourceRoot, ".env"), "DO_NOT_BUNDLE_SECRET");
  await mkdir(vendorDir);
  const node = Buffer.alloc(1024 * 1024 + 20, 5), cloudflared = Buffer.alloc(1024 * 1024 + 30, 7), winsw = Buffer.alloc(1024 * 1024 + 40, 9);
  const lock = { schema: 1, package_version: "0.18.0", platform: "win32", architecture: "x64", artifacts: [
    { id: "node", version: "24.22.3", file: "node.exe", archive_path: "bin/node.exe", url: "https://nodejs.org/dist/v24.22.3/win-x64/node.exe", sha256: fakeHash(node) },
    { id: "cloudflared", version: "2026.11.1", file: "cloudflared.exe", archive_path: "bin/cloudflared.exe", url: "https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-windows-amd64.exe", sha256: fakeHash(cloudflared) },
    { id: "winsw", version: "2.12.0", file: "WinSW-x64.exe", archive_path: "bin/WinSW.exe", url: "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe", sha256: fakeHash(winsw) },
  ], licenses: [
    { file: "node-LICENSE", archive_path: "licenses/node-LICENSE", url: "https://raw.githubusercontent.com/nodejs/node/v24.22.3/LICENSE" },
    { file: "cloudflared-LICENSE", archive_path: "licenses/cloudflared-LICENSE", url: "https://raw.githubusercontent.com/cloudflare/cloudflared/2026.11.1/LICENSE" },
    { file: "winsw-LICENSE", archive_path: "licenses/winsw-LICENSE", url: "https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt" },
  ] };
  await writeFile(path.join(vendorDir, "node.exe"), node);
  await writeFile(path.join(vendorDir, "cloudflared.exe"), cloudflared);
  await writeFile(path.join(vendorDir, "WinSW-x64.exe"), winsw);
  await writeFile(path.join(vendorDir, "node-LICENSE"), "Node test license for packaging verification\n");
  await writeFile(path.join(vendorDir, "cloudflared-LICENSE"), "Cloudflare test license for packaging verification\n");
  await writeFile(path.join(vendorDir, "winsw-LICENSE"), "WinSW test license for packaging verification\n");
  return { root, sourceRoot, vendorDir, lock, packageLock: lock, node, cloudflared, winsw, sourceSha: "a".repeat(40), outFile: path.join(root, "out", "KTK-Windows-MCP-0.18.0.zip") };
}

test("step 15 payload is reproducible, manifest-verified, without secrets or install actions", async t => {
  const f = await fixture(t);
  const result = await buildWindowsPackage(f);
  assert.equal(result.fileCount, 61);
  assert.equal(result.manifest.ready_for_installation, false);
  assert.equal(result.manifest.source_commit, f.sourceSha);
  assert.equal(result.manifest.target, "windows-x64");
  assert.equal(result.manifest.executables[0].sha256, fakeHash(f.node));
  assert.equal(result.manifest.executables[1].sha256, fakeHash(f.cloudflared));
  assert.equal(result.manifest.executables[2].sha256, fakeHash(f.winsw));
  assert.equal(result.sha256, await sha256File(f.outFile));
  assert.equal((await readFile(f.outFile + ".sha256", "utf8")).trim(), `${result.sha256}  ${path.basename(f.outFile)}`);
  const zipFiles = (await run("unzip", ["-Z1", f.outFile])).stdout.trim().split("\n");
  assert.equal(zipFiles.length, 61);
  assert.equal(zipFiles.includes("runtime/main.mjs"), true);
  assert.equal(zipFiles.includes("runtime/model-preflight.mjs"), true);
  assert.equal(zipFiles.includes("runtime/pc-diagnostics.mjs"), true);
  assert.equal(zipFiles.includes("runtime/pc-maintenance.mjs"), true);
  assert.equal(zipFiles.includes("runtime/pc-updater-staging.mjs"), true);
  assert.equal(zipFiles.includes("runtime/strata-installer.mjs"), true);
  assert.equal(zipFiles.includes("runtime/strata-runtime.lock.json"), true);
  assert.equal(zipFiles.includes("runtime/sc117-model.mjs"), true);
  assert.equal(zipFiles.includes("runtime/sc117-model.lock.json"), true);
  assert.equal(zipFiles.includes("runtime/sc117-inference.mjs"), true);
  assert.equal(zipFiles.includes("runtime/local-ai-setup.mjs"), true);
  assert.equal(zipFiles.includes("runtime/remote-update.mjs"), true);
  assert.equal(zipFiles.includes("runtime/Run-KTKUpdater.mjs"), true);
  assert.equal(zipFiles.includes("Install-KTKUpdater.ps1"), true);
  assert.equal(zipFiles.includes("Set-KTKLocalAIOptIn.ps1"), true);
  assert.equal(zipFiles.includes("Install-KTKUserUpdater.ps1"), true);
  assert.equal(zipFiles.includes("Run-KTKUserUpdate.mjs"), true);
  assert.equal(zipFiles.includes("Apply-KTKUnifiedRelease.ps1"), true);
  assert.equal(zipFiles.includes("Run-KTKRemoteUpdate.ps1"), true);
  assert.equal(zipFiles.includes("services/KTKQwenUpdater.xml"), true);
  assert.equal(zipFiles.includes("Install-KTKStrata.mjs"), true);
  assert.equal(zipFiles.includes("Prepare-KTKSC117.mjs"), true);
  assert.equal(zipFiles.includes("Test-KTKSC117.mjs"), true);
  assert.equal(zipFiles.includes("Install-KTKLocalAI.mjs"), true);
  assert.equal(zipFiles.includes("Show-KTKLocalAI.ps1"), true);
  assert.equal(zipFiles.includes("Run-KTKIntegratedAcceptance.ps1"), true);
  assert.equal(zipFiles.includes("Verify-KTKPackage.ps1"), true);
  assert.equal(zipFiles.includes("bin/cloudflared.exe"), true);
  assert.equal(zipFiles.includes("bin/node.exe"), true);
  assert.equal(zipFiles.includes("bin/WinSW.exe"), true);
  assert.equal(zipFiles.includes("Install-KTKMCP.ps1"), true);
  assert.equal(zipFiles.includes("Activate-KTKMCP.ps1"), true);
  assert.equal(zipFiles.includes("Maintain-KTKMCP.ps1"), true);
  assert.equal(zipFiles.includes("Run-KTKAcceptance.ps1"), true);
  assert.equal(zipFiles.includes("Assert-KTKStaged.ps1"), true);
  assert.equal(zipFiles.includes("Revoke-KTKMCP.mjs"), true);
  assert.equal(zipFiles.includes("runtime/device-revocation.mjs"), true);
  assert.equal(zipFiles.includes("Start-KTKMCP.cmd"), true);
  assert.equal(zipFiles.includes("Enroll-KTKMCP.mjs"), true);
  assert.equal(zipFiles.includes("SelfTest-KTKMCP.mjs"), true);
  assert.equal(zipFiles.includes("services/KTKQwenMCP.xml"), true);
  assert.equal(zipFiles.includes("services/KTKQwenTunnel.xml"), true);
  assert.equal(zipFiles.some(name => /(?:^|\/)\.env(?:$|\.)|\.test\.mjs$|key\.pem|private|\.git|token/i.test(name)), false);
  assert.doesNotMatch((await readZip(f.outFile, "README.txt")).toString("utf8"), /DO_NOT_BUNDLE_SECRET/);
  const manifest = JSON.parse(await readZip(f.outFile, "MANIFEST.json"));
  assert.equal(manifest.files.length, 59);
  for (const record of manifest.files) assert.equal(fakeHash(await readZip(f.outFile, record.path)), record.sha256);
  await assert.rejects(() => buildWindowsPackage(f), /package_output_exists/);
  const other = { ...f, outFile: path.join(f.root, "out", "second.zip") };
  const duplicate = await buildWindowsPackage(other);
  assert.equal(duplicate.sha256, result.sha256);
});

test("package rejects unsigned vendor modification, missing binary and symlinks", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vendorDir, "cloudflared.exe"), "tampered");
  await assert.rejects(() => buildWindowsPackage(f), /vendor_checksum_mismatch|invalid_package_size/);
  await rm(path.join(f.vendorDir, "cloudflared.exe"));
  await assert.rejects(() => buildWindowsPackage(f), /package_input_missing/);
  await symlink(path.join(f.vendorDir, "node.exe"), path.join(f.vendorDir, "cloudflared.exe"));
  await assert.rejects(() => buildWindowsPackage(f), /package_input_not_regular/);
  await assert.rejects(() => buildWindowsPackage({ ...f, sourceSha: "invalid" }), /invalid_source_sha/);
});

test("lock validates official host and canonical target; a bad hash is denied", async t => {
  const f = await fixture(t);
  assert.equal(validatePackageLock(f.lock).artifacts.length, 3);
  assert.throws(() => validatePackageLock({ ...f.lock, artifacts: [f.lock.artifacts[0]] }), /invalid_package_lock/);
  assert.throws(() => validatePackageLock({ ...f.lock, artifacts: [{ ...f.lock.artifacts[0], url: "https://evil.example/node.exe" }, ...f.lock.artifacts.slice(1)] }), /invalid_package_lock/);
  assert.throws(() => validatePackageLock({ ...f.lock, artifacts: [{ ...f.lock.artifacts[0], archive_path: "../../evil" }, ...f.lock.artifacts.slice(1)] }), /invalid_package_lock/);
  assert.throws(() => validatePackageLock({ ...f.lock, artifacts: [{ ...f.lock.artifacts[0], sha256: "abc" }, ...f.lock.artifacts.slice(1)] }), /invalid_package_lock/);
  assert.throws(() => validatePackageLock({ ...f.lock, artifacts: [...f.lock.artifacts.slice(0,2), { ...f.lock.artifacts[2], url: "https://github.com/evil/release/WinSW.exe" }] }), /invalid_package_lock/);
});

test("vendor download validates hashes before activating files, offline mock", async t => {
  const f = await fixture(t);
  const destination = path.join(f.root, "downloaded");
  const values = { "node.exe": f.node, "cloudflared.exe": f.cloudflared, "WinSW-x64.exe": f.winsw, "node-LICENSE": Buffer.from("Node test license for packaging verification\n"), "cloudflared-LICENSE": Buffer.from("Cloudflare test license for packaging verification\n"), "winsw-LICENSE": Buffer.from("WinSW test license for packaging verification\n") };
  let downloaded = 0;
  const fetcher = async url => {
    downloaded++;
    const file = [...f.lock.artifacts, ...f.lock.licenses].find(x => x.url === url)?.file;
    return new Response(values[file], { status: 200 });
  };
  await fetchWindowsVendors({ lock: f.lock, destination, fetcher });
  assert.equal(downloaded, 6);
  await fetchWindowsVendors({ lock: f.lock, destination, fetcher });
  assert.equal(downloaded, 6);
  assert.equal(await sha256File(path.join(destination, "node.exe")), fakeHash(f.node));
  const tampered = path.join(f.root, "bad-download");
  await assert.rejects(() => fetchWindowsVendors({ lock: f.lock, destination: tampered, fetcher: async () => new Response(Buffer.alloc(1024 * 1024 + 3, 1)) }), /vendor_checksum_mismatch/);
});
