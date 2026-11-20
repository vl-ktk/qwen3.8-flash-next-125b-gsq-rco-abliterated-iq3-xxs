import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import modelLock from "./sc117-model.lock.json" with { type: "json" };
import { strataInstallRoot } from "./strata-installer.mjs";

const execFileAsync = promisify(execFile);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const SOURCE = "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF";
const REVISION = "90a3350cd800ec1fe0d1660a38414ad9e985782f";
const MIN_PACK_ROOM = 20_000_000_000;
const RECOMMENDED_FREE = 130_000_000_000;
const MODEL_MARKER = "ktk-sc117-install.json";
const PACK_STAGE_MARKER = "ktk-sc117-pack-stage.json";
const HEX64 = /^[0-9a-f]{64}$/;
const PINNED = Object.freeze([
  ["IQ3_XXS/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00001-of-00002.gguf", 47342144896, "03b11926b41a3d7f7a008882b1bc7a6330a3c9c43d3cad4598d31dc73042fdc5"],
  ["IQ3_XXS/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00002-of-00002.gguf", 28800138432, "316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113"],
  ["strata/rt/dense.bin", 116099072, "c724dc0b0822ada5d2977bf5bde821605feabaa64ea2e0045b67ca656329070a"],
  ["strata/rt/dense.txt", 1880, "8773c81ebb0986e37fe94a8a9933e87be48b1fabc6889a0106bcdab179d1c2ac"],
  ["strata/rt/draft_vocab.bin", 425196, "b1e1d3a7a9e4bf862dcd5923ce661fb59bbd07907e594df5cf86a62ac235cb91"],
  ["strata/rt/experts.bin", 707788800, "09398406be61f1f54c93861f449e48b8df0bfccbc9ec9b2b7636775a6ea9244f"],
]);
const expectedBytes = PINNED.reduce((sum, item) => sum + item[1], 0);

export function validateSc117Lock(lock = modelLock) {
  if (lock?.schema !== 1 || lock.repository !== SOURCE || lock.revision !== REVISION || lock.quantization !== "IQ3_XXS" || lock.strata_version !== "0.2.17" || !Array.isArray(lock.files) || lock.files.length !== PINNED.length) fail("sc117_lock_untrusted");
  if (lock.packer?.source !== "Niko1221/Strata@v0.2.17:terminal/tools/iq_pack.py" || lock.packer.bytes !== 44648 || lock.packer.sha256 !== "95e04b4a1f6a16e4ad5d1f13b4ecad0005a4fd22e9fc9a357fe1666922b8950d") fail("sc117_lock_untrusted");
  for (let i = 0; i < PINNED.length; i++) {
    const f = lock.files[i];
    if (f?.path !== PINNED[i][0] || f.bytes !== PINNED[i][1] || f.sha256 !== PINNED[i][2] || !HEX64.test(f.sha256)) fail("sc117_lock_untrusted");
  }
  return lock;
}

export function sc117Plan(lock = modelLock) {
  validateSc117Lock(lock);
  return {
    status: "planned_no_changes", source: lock.repository, revision: lock.revision,
    quantization: lock.quantization, number_of_files: lock.files.length,
    model_and_mtp_bytes: expectedBytes, minimum_fresh_free_bytes: expectedBytes + MIN_PACK_ROOM,
    recommended_fresh_free_bytes: RECOMMENDED_FREE,
    target: "first eligible fixed NTFS/ReFS D: volume, otherwise C:",
    steps: ["fixed_volume_space_check", "resume_and_verify_two_iq3_xxs_shards", "resume_and_verify_strata_mtp_runtime", "pack_from_sc117_shard_with_pinned_strata_iq_pack", "verify_pack_outputs"],
    permissions: "local_installer_approval_required; not a remote MCP write tool",
    warnings: ["GGUF and MTP hashes are verified in full on download; 130 GB is a planning recommendation, not an upstream minimum.", "The Strata v0.2.17 upstream packer is verified by SHA-256 before running; its execution and inference remain untested on the target machine.", "Setup.exe does not run this stage until the integrated block E."],
  };
}

export function sc117AssetUrl(asset, lock = modelLock) {
  validateSc117Lock(lock);
  if (!lock.files.includes(asset)) fail("sc117_asset_untrusted");
  return `https://huggingface.co/${SOURCE}/resolve/${REVISION}/${asset.path.split("/").map(encodeURIComponent).join("/")}`;
}

export function sc117AssetLocation(root, asset, lock = modelLock) {
  validateSc117Lock(lock);
  if (!lock.files.includes(asset)) fail("sc117_asset_untrusted");
  return asset.path.startsWith("IQ3_XXS/") ? path.join(root, "IQ3_XXS", path.basename(asset.path)) : path.join(root, "mtp", "rt", path.basename(asset.path));
}

export async function hashSc117File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

const isFile = async file => {
  try { return (await lstat(file)).isFile(); } catch (err) { if (err?.code === "ENOENT") return false; fail("sc117_file_unavailable"); }
};
const maybeStat = async file => {
  try { return await lstat(file); } catch (err) { if (err?.code === "ENOENT") return null; fail("sc117_file_unavailable"); }
};
const ensureRegular = async file => {
  const info = await maybeStat(file);
  if (info && (!info.isFile() || info.isSymbolicLink())) fail("sc117_untrusted_file");
  return info;
};
const ensureDirectory = async file => {
  const info = await maybeStat(file);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) fail("sc117_untrusted_directory");
  return info;
};

const downloadHosts = name => name === "huggingface.co" || name === "cdn-lfs.hf.co" || name === "cdn-lfs-us-1.hf.co" || name === "cas-bridge.xethub.hf.co" || name === "cas-server.xethub.hf.co";
function assertDownloadResponse(response) {
  if (!response?.url) return; // Test response fixtures have no final URL.
  let parsed;
  try { parsed = new URL(response.url); } catch { fail("sc117_download_redirect_denied"); }
  if (parsed.protocol !== "https:" || !downloadHosts(parsed.hostname)) fail("sc117_download_redirect_denied");
}

// This downloader writes only the named .part file. Interruption preserves it;
// restart requires an exact matching state marker and HTTP 206 Content-Range.
// Hash mismatch removes only the bad temporary file, never a user-provided GGUF.
export async function downloadVerifiedSc117File({ asset, destination, url, fetchImpl = fetch, onProgress = null } = {}) {
  if (!asset || typeof asset.bytes !== "number" || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !HEX64.test(asset.sha256 ?? "") || !path.isAbsolute(destination)) fail("sc117_invalid_download_contract");
  const requestUrl = new URL(url);
  if (requestUrl.protocol !== "https:" || requestUrl.hostname !== "huggingface.co" || !requestUrl.pathname.startsWith(`/${SOURCE}/resolve/${REVISION}/`)) fail("sc117_asset_untrusted");
  const ready = await ensureRegular(destination);
  if (ready) {
    if (ready.size !== asset.bytes || await hashSc117File(destination) !== asset.sha256) fail("sc117_existing_file_invalid");
    if (onProgress) await onProgress(asset.bytes);
    return { status: "already_verified", bytes: asset.bytes };
  }
  const parent = path.dirname(destination);
  await ensureDirectory(parent);
  await mkdir(parent, { recursive: true });
  const partial = `${destination}.part`;
  const markerFile = `${destination}.download.json`;
  let markerInfo = await ensureRegular(markerFile);
  let partInfo = await ensureRegular(partial);
  const identity = { schema: 1, bytes: asset.bytes, sha256: asset.sha256, url };
  if (partInfo && !markerInfo) fail("sc117_partial_unowned");
  if (markerInfo) {
    let previous;
    try { previous = JSON.parse(await readFile(markerFile, "utf8")); } catch { fail("sc117_partial_unowned"); }
    if (JSON.stringify(previous) !== JSON.stringify(identity)) fail("sc117_partial_unowned");
  } else {
    await writeFile(markerFile, JSON.stringify(identity) + "\n", { flag: "wx" });
  }
  if (!partInfo) {
    const h = await open(partial, "wx");
    await h.close();
  }
  let offset = (await stat(partial)).size;
  if (offset > asset.bytes) fail("sc117_partial_oversize");
  if (onProgress) await onProgress(offset);
  while (offset < asset.bytes) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: "follow", headers: { "Range": `bytes=${offset}-`, "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(2 * 60 * 60 * 1000) });
    } catch { fail("sc117_download_interrupted"); }
    assertDownloadResponse(response);
    if (!response?.ok || !response.body || (offset > 0 && response.status !== 206) || ![200, 206].includes(response.status)) fail("sc117_range_not_supported");
    const contentRange = response.headers?.get?.("content-range");
    let allowed = asset.bytes - offset;
    if (response.status === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
      if (!match || Number(match[1]) !== offset || Number(match[3]) !== asset.bytes || Number(match[2]) < offset || Number(match[2]) >= asset.bytes) fail("sc117_range_invalid");
      allowed = Number(match[2]) - offset + 1;
    }
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && (Number(declared) !== allowed || !/^\d+$/.test(declared))) fail("sc117_range_invalid");
    const handle = await open(partial, "a");
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > allowed) fail("sc117_range_invalid");
        await handle.writeFile(Buffer.from(chunk));
        if (onProgress) await onProgress(offset + received);
      }
      await handle.sync();
    } catch (error) {
      if (error?.code === "sc117_range_invalid") throw error;
      fail("sc117_download_interrupted");
    } finally { await handle.close(); }
    if (received !== allowed) fail("sc117_download_interrupted");
    offset += received;
  }
  if ((await stat(partial)).size !== asset.bytes || await hashSc117File(partial) !== asset.sha256) {
    await rm(partial);
    await rm(markerFile);
    fail("sc117_download_hash_mismatch");
  }
  if (await maybeStat(destination)) fail("sc117_existing_file_invalid");
  await rename(partial, destination);
  await rm(markerFile);
  return { status: "downloaded_verified", bytes: asset.bytes };
}

// The command is static and read-only; it queries Windows fixed volumes, not
// a user-supplied shell expression. No secrets are inherited by the process.
export async function fixedModelVolumes({ invoke = execFileAsync } = {}) {
  if (process.platform !== "win32") fail("sc117_windows_required");
  const sys = process.env.SystemRoot || "C:\\Windows";
  const ps = path.win32.join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = "@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | Select-Object DeviceID, FreeSpace, FileSystem) | ConvertTo-Json -Compress";
  let out;
  try { out = await invoke(ps, ["-NoProfile", "-NonInteractive", "-Command", command], { shell: false, windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024,
    env: { SystemRoot: sys, WINDIR: sys, PATH: `${path.win32.join(sys, "System32")};${sys}`, PSModulePath: process.env.PSModulePath ?? "" } }); }
  catch { fail("sc117_volumes_unavailable"); }
  let rows;
  try { rows = JSON.parse(out.stdout); } catch { fail("sc117_volumes_unavailable"); }
  return (Array.isArray(rows) ? rows : [rows]).filter(v => /^[CD]:$/i.test(v?.DeviceID ?? "") && ["NTFS", "ReFS"].includes(v?.FileSystem) && Number.isSafeInteger(Number(v.FreeSpace)))
    .map(v => ({ drive: v.DeviceID.toUpperCase(), free_bytes: Number(v.FreeSpace) }));
}

export function chooseSc117Volume(volumes, needed = expectedBytes + MIN_PACK_ROOM) {
  if (!Array.isArray(volumes) || !Number.isSafeInteger(needed) || needed <= 0) fail("sc117_volumes_unavailable");
  for (const drive of ["D:", "C:"]) {
    const volume = volumes.find(v => v?.drive === drive && Number.isSafeInteger(v.free_bytes) && v.free_bytes >= needed);
    if (volume) return { ...volume, root: path.win32.join(`${drive}\\`, "KTK", "Models", "SC117-IQ3_XXS"), recommended_free_bytes: RECOMMENDED_FREE };
  }
  fail("sc117_disk_insufficient");
}

// An interrupted D: installation takes precedence over a new empty C:
// installation. Disk admission accounts for bytes already on disk, without
// trusting them as verified content (the downloader still hashes them).
export async function selectSc117Target(volumes, lock = modelLock,
  rootForDrive = drive => path.win32.join(`${drive}\\`, "KTK", "Models", "SC117-IQ3_XXS"), measureFile = ensureRegular) {
  validateSc117Lock(lock);
  for (const drive of ["D:", "C:"]) {
    const volume = volumes.find(v => v?.drive === drive && Number.isSafeInteger(v.free_bytes));
    if (!volume) continue;
    const root = rootForDrive(drive);
    await ensureDirectory(path.dirname(path.dirname(root)));
    await ensureDirectory(path.dirname(root));
    if (!(await ensureDirectory(root))) continue;
    const prior = await stateRead(path.join(root, MODEL_MARKER));
    if (prior?.schema !== 1 || prior.revision !== lock.revision || prior.quantization !== lock.quantization || !/^[0-9a-f]{32}$/.test(prior.nonce ?? "") || !["downloading", "packaging", "ready"].includes(prior.status)) fail("sc117_existing_install_unrecognized");
    if (prior.status === "ready") return { ...volume, root, resuming: true };
    let remaining = 0;
    for (const asset of lock.files) {
      const dst = sc117AssetLocation(root, asset, lock);
      const complete = await measureFile(dst);
      const partial = await measureFile(`${dst}.part`);
      remaining += complete?.size === asset.bytes ? 0 : asset.bytes - (partial ? Math.min(partial.size, asset.bytes) : 0);
    }
    if (volume.free_bytes < remaining + MIN_PACK_ROOM) fail("sc117_disk_insufficient_resume");
    return { ...volume, root, resuming: true, remaining_bytes: remaining };
  }
  return chooseSc117Volume(volumes);
}

async function stateRead(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { fail("sc117_existing_install_unrecognized"); }
}
async function saveState(file, state) {
  const temp = `${file}.new`;
  await writeFile(temp, JSON.stringify(state) + "\n", { flag: "w" });
  await rename(temp, file);
}
const PACK_OUTPUTS = ["native_experts.txt", "index.txt", "dense.bin", "tokenizer/vocab.json", "tokenizer/chat_template.jinja"];
async function checkPack(pack) {
  for (const rel of PACK_OUTPUTS) if (!(await isFile(path.join(pack, rel)))) fail("sc117_pack_incomplete");
}

export async function verifySc117Packer(file, lock = modelLock) {
  validateSc117Lock(lock);
  const details = await ensureRegular(file);
  if (!details || details.size !== lock.packer.bytes || await hashSc117File(file) !== lock.packer.sha256) fail("sc117_packer_unverified");
  return true;
}

export async function prepareSc117Model({ approved = false, platform = process.platform, arch = process.arch,
  localAppData = process.env.LOCALAPPDATA, getVolumes = fixedModelVolumes, root = null,
  strataRoot = null, downloadFile = downloadVerifiedSc117File, verifyPacker = verifySc117Packer, invoke = execFileAsync, lock = modelLock,
  onStage = null, onProgress = null } = {}) {
  validateSc117Lock(lock);
  if (!approved) fail("sc117_owner_approval_required");
  if (platform !== "win32" || arch !== "x64") fail("sc117_windows_x64_required");
  const installedStrata = strataRoot ?? strataInstallRoot(localAppData);
  const strata = await stateRead(path.join(installedStrata, "ktk-strata-install.json"));
  if (strata.schema !== 1 || strata.status !== "ready" || strata.version !== lock.strata_version) fail("sc117_strata_not_ready");
  const bin = path.join(installedStrata, "terminal", "current");
  const python = path.join(bin, "python", "python.exe");
  const tool = path.join(bin, "tools", "iq_pack.py");
  if (!(await isFile(python)) || !(await isFile(tool))) fail("sc117_packer_missing");
  await verifyPacker(tool, lock);
  const volume = root ? null : await selectSc117Target(await getVolumes(), lock);
  const chosenRoot = root ?? volume.root;
  if (!path.isAbsolute(chosenRoot) || chosenRoot.length < 8) fail("sc117_root_invalid");
  await ensureDirectory(path.dirname(path.dirname(chosenRoot)));
  await ensureDirectory(path.dirname(chosenRoot));
  const rootInfo = await ensureDirectory(chosenRoot);
  const stateFile = path.join(chosenRoot, MODEL_MARKER);
  let state;
  if (rootInfo) {
    state = await stateRead(stateFile);
    if (state.schema !== 1 || state.revision !== lock.revision || state.quantization !== lock.quantization || !/^[0-9a-f]{32}$/.test(state.nonce ?? "") || !["downloading", "packaging", "ready"].includes(state.status)) fail("sc117_existing_install_unrecognized");
    if (state.status === "ready") {
      await checkPack(path.join(chosenRoot, "pack"));
      if (onStage) await onStage("already_prepared");
      return { status: "already_prepared_not_rehashed", root: chosenRoot, revision: lock.revision };
    }
  } else {
    await mkdir(path.dirname(chosenRoot), { recursive: true });
    try { await mkdir(chosenRoot); } catch { fail("sc117_root_exists"); }
    state = { schema: 1, revision: lock.revision, quantization: lock.quantization, nonce: randomBytes(16).toString("hex"), status: "downloading" };
    await writeFile(stateFile, JSON.stringify(state) + "\n", { flag: "wx" });
  }
  // Preserve verified finished files and partial downloads across network failures.
  // Re-verify every completed shard when resuming before invoking the packer.
  let completedBytes = 0;
  for (const [index, file] of lock.files.entries()) {
    if (onStage) await onStage("downloading", { file_index: index + 1, files_total: lock.files.length });
    await downloadFile({ asset: file, destination: sc117AssetLocation(chosenRoot, file, lock), url: sc117AssetUrl(file, lock),
      onProgress: onProgress ? async received => onProgress({ file_index: index + 1, files_total: lock.files.length,
        bytes_done: completedBytes + received, bytes_total: expectedBytes }) : null });
    completedBytes += file.bytes;
  }
  const pack = path.join(chosenRoot, "pack");
  const stage = path.join(chosenRoot, "pack-incomplete");
  if (await ensureDirectory(pack)) {
    await checkPack(pack);
  } else {
    if (onStage) await onStage("packing");
    const existing = await ensureDirectory(stage);
    if (existing) {
      const stageMarker = await stateRead(path.join(stage, PACK_STAGE_MARKER));
      if (state.status !== "packaging" || stageMarker.schema !== 1 || stageMarker.nonce !== state.nonce) fail("sc117_pack_stage_unowned");
      await rm(stage, { recursive: true, force: false }); // Only a KTK-owned interrupted pack stage.
    }
    state.status = "packaging";
    await saveState(stateFile, state);
    await mkdir(stage);
    await writeFile(path.join(stage, PACK_STAGE_MARKER), JSON.stringify({ schema: 1, nonce: state.nonce }) + "\n", { flag: "wx" });
    const sys = process.env.SystemRoot || "C:\\Windows";
    const env = { SystemRoot: sys, WINDIR: sys, PATH: `${path.win32.join(sys, "System32")};${sys}`,
      STRATA_DATA_DIR: installedStrata, STRATA_HOME: path.join(installedStrata, "home"), PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONHOME: "", PYTHONPATH: "" };
    try {
      const result = await invoke(python, [tool, "--gguf", sc117AssetLocation(chosenRoot, lock.files[0], lock), "--out", stage],
        { shell: false, windowsHide: true, cwd: bin, env, timeout: 4 * 60 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
      if (result?.exitCode && result.exitCode !== 0) fail("sc117_pack_failed");
      await checkPack(stage);
      await rename(stage, pack);
    } catch {
      // Only a stage created by this transaction can be deleted; downloaded
      // and verified shards/MTP stay intact for a one-click retry.
      const m = await stateRead(path.join(stage, PACK_STAGE_MARKER));
      if (m.schema === 1 && m.nonce === state.nonce) await rm(stage, { recursive: true, force: false });
      fail("sc117_pack_failed");
    }
  }
  state.status = "ready";
  state.pack = "pack";
  state.verified_asset_count = lock.files.length;
  await saveState(stateFile, state);
  if (onStage) await onStage("prepared");
  return { status: "prepared_for_inference_test", root: chosenRoot, source: lock.repository, revision: lock.revision,
    first_shard: sc117AssetLocation(chosenRoot, lock.files[0], lock), second_shard: sc117AssetLocation(chosenRoot, lock.files[1], lock), mtp: path.join(chosenRoot, "mtp", "rt"), pack, inference_tested: false };
}
