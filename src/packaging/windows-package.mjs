import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const SOURCE_FILES = Object.freeze([
  "src/windows/admin-cli.mjs", "src/windows/administration.mjs",
  "src/windows/device-identity.mjs", "src/windows/device-bootstrap.mjs",
  "src/windows/device-enrollment.mjs", "src/windows/device-selftest.mjs",
  "src/windows/device-revocation.mjs",
  "src/windows/emergency-lock.mjs",
  "src/windows/main.mjs", "src/windows/mcp-server.mjs", "src/windows/model-preflight.mjs",
  "src/windows/strata-installer.mjs", "src/windows/strata-runtime.lock.json",
  "src/windows/sc117-model.mjs", "src/windows/sc117-model.lock.json",
  "src/windows/sc117-inference.mjs",
  "src/windows/local-ai-setup.mjs",
  "src/windows/remote-update.mjs",
  "src/windows/monitoring.mjs", "src/windows/origin-auth.mjs",
  "src/windows/windows-tools.mjs",
]);
const STABLE_TIME = new Date("2020-01-01T00:00:00.000Z");
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const safeFile = name => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(name) && !name.includes("..");
const safePath = name => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,180}$/.test(name) && !name.split("/").includes("..") && !name.startsWith("/") && !name.includes("\\");

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
}

export function validatePackageLock(lock) {
  if (lock?.schema !== 1 || !/^0\.18\.\d+$/.test(lock.package_version ?? "") || lock.platform !== "win32" || lock.architecture !== "x64" || !Array.isArray(lock.artifacts) || !Array.isArray(lock.licenses)) throw Error("invalid_package_lock");
  if (lock.artifacts.length !== 3 || lock.licenses.length !== 3) throw Error("invalid_package_lock");
  if (lock.artifacts.map(x => x.id).join(",") !== "node,cloudflared,winsw") throw Error("invalid_package_lock");
  for (const artifact of lock.artifacts) {
    if (!safeFile(artifact.file) || !safePath(artifact.archive_path) || !artifact.archive_path.startsWith("bin/") || !HASH.test(artifact.sha256)) throw Error("invalid_package_lock");
    const u = new URL(artifact.url);
    if (artifact.id === "node" && (u.origin !== "https://nodejs.org" || !u.pathname.endsWith(`/v${artifact.version}/win-x64/node.exe`))) throw Error("invalid_package_lock");
    if (artifact.id === "cloudflared" && (u.origin !== "https://github.com" || u.pathname !== `/cloudflare/cloudflared/releases/download/${artifact.version}/cloudflared-windows-amd64.exe`)) throw Error("invalid_package_lock");
    if (artifact.id === "winsw" && (artifact.version !== "2.12.0" || u.origin !== "https://github.com" || u.pathname !== "/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe")) throw Error("invalid_package_lock");
  }
  for (const license of lock.licenses) {
    if (!safeFile(license.file) || !safePath(license.archive_path) || !license.archive_path.startsWith("licenses/")) throw Error("invalid_package_lock");
    if (new URL(license.url).origin !== "https://raw.githubusercontent.com") throw Error("invalid_package_lock");
  }
  const all = [...lock.artifacts, ...lock.licenses].map(x => x.archive_path);
  if (new Set(all).size !== all.length) throw Error("invalid_package_lock");
  return lock;
}

async function regularFile(file) {
  let result;
  try { result = await lstat(file); }
  catch { throw Error("package_input_missing"); }
  if (!result.isFile()) throw Error("package_input_not_regular");
  return result;
}

async function zipFiles(workingDir, output, files) {
  await new Promise((resolve, reject) => {
    const child = spawn("zip", ["-X", "-9", "-q", output, ...files.sort()], {
      cwd: workingDir, stdio: "ignore", shell: false, env: { ...process.env, TZ: "UTC" },
    });
    child.once("error", () => reject(Error("zip_unavailable")));
    child.once("close", code => code === 0 ? resolve() : reject(Error("zip_failed")));
  });
}

export async function buildWindowsPackage({ sourceRoot, vendorDir, outFile, sourceSha, packageLock, buildZip = zipFiles }) {
  validatePackageLock(packageLock);
  if (!SHA.test(sourceSha ?? "")) throw Error("invalid_source_sha");
  if (!path.isAbsolute(outFile) || path.extname(outFile) !== ".zip") throw Error("invalid_output_path");
  try { await stat(outFile); throw Error("package_output_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const stage = await mkdtemp(path.join(os.tmpdir(), "ktk-windows-package-"));
  const fileRecords = [];
  try {
    const include = async (from, dest, expectedHash = null) => {
      if (!safePath(dest)) throw Error("invalid_package_path");
      const meta = await regularFile(from);
      if (meta.size === 0 || meta.size > 128 * 1024 * 1024) throw Error("invalid_package_size");
      const digest = await sha256File(from);
      if (expectedHash && digest !== expectedHash) throw Error("vendor_checksum_mismatch");
      const staged = path.join(stage, dest);
      await mkdir(path.dirname(staged), { recursive: true });
      await copyFile(from, staged);
      await utimes(staged, STABLE_TIME, STABLE_TIME);
      fileRecords.push({ path: dest, sha256: digest, bytes: meta.size });
    };
    for (const item of packageLock.artifacts) await include(path.join(vendorDir, item.file), item.archive_path, item.sha256);
    for (const item of packageLock.licenses) await include(path.join(vendorDir, item.file), item.archive_path);
    for (const name of SOURCE_FILES) await include(path.join(sourceRoot, name), `runtime/${path.basename(name)}`);
    await include(path.join(sourceRoot, "config/windows-mcp.defaults.json"), "config/windows-mcp.defaults.json");
    await include(path.join(sourceRoot, "scripts/Verify-KTKPackage.ps1"), "Verify-KTKPackage.ps1");
    await include(path.join(sourceRoot, "scripts/Install-KTKMCP.ps1"), "Install-KTKMCP.ps1");
    await include(path.join(sourceRoot, "scripts/Generate-KTKIdentity.mjs"), "Generate-KTKIdentity.mjs");
    await include(path.join(sourceRoot, "scripts/Enroll-KTKMCP.mjs"), "Enroll-KTKMCP.mjs");
    await include(path.join(sourceRoot, "scripts/SelfTest-KTKMCP.mjs"), "SelfTest-KTKMCP.mjs");
    await include(path.join(sourceRoot, "scripts/Activate-KTKMCP.ps1"), "Activate-KTKMCP.ps1");
    await include(path.join(sourceRoot, "scripts/Maintain-KTKMCP.ps1"), "Maintain-KTKMCP.ps1");
    await include(path.join(sourceRoot, "scripts/Revoke-KTKMCP.mjs"), "Revoke-KTKMCP.mjs");
    await include(path.join(sourceRoot, "scripts/Install-KTKStrata.mjs"), "Install-KTKStrata.mjs");
    await include(path.join(sourceRoot, "scripts/Prepare-KTKSC117.mjs"), "Prepare-KTKSC117.mjs");
    await include(path.join(sourceRoot, "scripts/Test-KTKSC117.mjs"), "Test-KTKSC117.mjs");
    await include(path.join(sourceRoot, "scripts/Install-KTKLocalAI.mjs"), "Install-KTKLocalAI.mjs");
    await include(path.join(sourceRoot, "scripts/Show-KTKLocalAI.ps1"), "Show-KTKLocalAI.ps1");
    await include(path.join(sourceRoot, "scripts/Run-KTKIntegratedAcceptance.ps1"), "Run-KTKIntegratedAcceptance.ps1");
    await include(path.join(sourceRoot, "scripts/Install-KTKUpdater.ps1"), "Install-KTKUpdater.ps1");
    await include(path.join(sourceRoot, "scripts/Run-KTKRemoteUpdate.ps1"), "Run-KTKRemoteUpdate.ps1");
    await include(path.join(sourceRoot, "scripts/Run-KTKUpdater.mjs"), "runtime/Run-KTKUpdater.mjs");
    await include(path.join(sourceRoot, "scripts/Run-KTKAcceptance.ps1"), "Run-KTKAcceptance.ps1");
    await include(path.join(sourceRoot, "scripts/Assert-KTKStaged.ps1"), "Assert-KTKStaged.ps1");
    await include(path.join(sourceRoot, "scripts/Start-KTKMCP.cmd"), "Start-KTKMCP.cmd");
    await include(path.join(sourceRoot, "config/KTKQwenMCP.xml"), "services/KTKQwenMCP.xml");
    await include(path.join(sourceRoot, "config/KTKQwenTunnel.xml"), "services/KTKQwenTunnel.xml");
    await include(path.join(sourceRoot, "config/KTKQwenUpdater.xml"), "services/KTKQwenUpdater.xml");
    const notice = `KTK Windows MCP ${packageLock.package_version}\nSource: ${sourceSha}\nINTEGRATED OWNER ACCEPTANCE CANDIDATE - NOT VERIFIED ON OWNER GPU OR READY FOR FRIEND PC.\nSetup.exe live mode installs/updates the privileged Windows MCP, then launches original-user Local AI GUI: Strata v0.2.17, verified SC117 IQ3_XXS+MTP download and native pack, loopback-only inference acceptance.\nThe integrated installer may download over 77 GB and take hours. Offline mode NEVER downloads model weights or starts CUDA.\nRun-KTKIntegratedAcceptance.ps1 skips an already healthy matching MCP version so the same EXE can retry interrupted per-user AI work.\nShow-KTKLocalAI.ps1 shows coarse progress and file bytes; no manual PowerShell commands are needed.\nInstall-KTKMCP.ps1 stages Windows services disabled, generates device identity, and validates ACLs.\nMaintain-KTKMCP.ps1 supports confirmed update, repair, rollback and remote-revoked uninstall; defaults to locked/stopped.\nActivate-KTKMCP.ps1 requires a Worker already supporting encrypted bootstrap and holding separately configured secrets.\nFirst device pairing still needs owner approval in a browser. No signed production release, credentials or model files are included.\nDo not deploy to a friend's PC until owner Windows GPU acceptance succeeds.\n`;
    await writeFile(path.join(stage, "README.txt"), notice, "utf8");
    await utimes(path.join(stage, "README.txt"), STABLE_TIME, STABLE_TIME);
    fileRecords.push({ path: "README.txt", sha256: createHash("sha256").update(notice).digest("hex"), bytes: Buffer.byteLength(notice) });
    fileRecords.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const manifest = { schema: 1, package_version: packageLock.package_version, source_commit: sourceSha,
      target: "windows-x64", executables: packageLock.artifacts.map(({ id, version, archive_path, sha256 }) => ({ id, version, path: archive_path, sha256 })),
      ready_for_installation: false, files: fileRecords };
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(path.join(stage, "MANIFEST.json"), manifestText, "utf8");
    await utimes(path.join(stage, "MANIFEST.json"), STABLE_TIME, STABLE_TIME);
    const manifestDigest = createHash("sha256").update(manifestText).digest("hex");
    const checksums = [...fileRecords.map(f => `${f.sha256}  ${f.path}`), `${manifestDigest}  MANIFEST.json`].join("\n") + "\n";
    await writeFile(path.join(stage, "SHA256SUMS.txt"), checksums, "utf8");
    await utimes(path.join(stage, "SHA256SUMS.txt"), STABLE_TIME, STABLE_TIME);
    await mkdir(path.dirname(outFile), { recursive: true });
    await buildZip(stage, outFile, [...fileRecords.map(f => f.path), "MANIFEST.json", "SHA256SUMS.txt"]);
    const archiveSha = await sha256File(outFile);
    await writeFile(outFile + ".sha256", `${archiveSha}  ${path.basename(outFile)}\n`, { flag: "wx" });
    return { archive: outFile, sha256: archiveSha, manifest, fileCount: fileRecords.length + 2 };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
