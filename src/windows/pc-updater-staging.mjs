import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeGatewayKey } from "./origin-auth.mjs";

const STAGE = /^update-[A-Za-z0-9]{6}$/;
const MARKER = "ktk-stage-owner.json";
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function signature(key, name, createdAt) {
  return createHmac("sha256", key).update(`KTK-STAGING-V1\n${name}\n${createdAt}`).digest("hex");
}

function noLink(meta, directory) {
  return meta && !meta.isSymbolicLink() && (directory ? meta.isDirectory() : meta.isFile());
}

// Called only by our restricted SYSTEM updater after mkdtemp, before it writes
// artifact.zip. The HMAC proves ownership independently of a folder name.
export async function markKtkUpdateStage(folder, keyText, now = Date.now()) {
  const name = path.basename(folder);
  if (!STAGE.test(name)) fail("maintenance_stage_untrusted");
  const marker = { schema: 1, owner: "KTKQwenUpdater", name, created_at: now,
    signature: signature(decodeGatewayKey(keyText), name, now) };
  await writeFile(path.join(folder, MARKER), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
  return marker;
}

// Read-only inventory and bounded, reversible quarantine of verified, stale,
// private KTK updater staging. NEVER purges or touches arbitrary .part files,
// model weights, Downloads, user Temp or other Windows data. Quarantine is on
// the SAME volume, so it deliberately does NOT free any disk capacity.
export function createKtkStageAdapter({ dataRoot, keyText, now = () => Date.now() } = {}) {
  const key = decodeGatewayKey(keyText);
  const archive = path.join(dataRoot, "quarantine");
  const root = async () => {
    const meta = await lstat(dataRoot).catch(() => fail("maintenance_stage_untrusted"));
    if (!noLink(meta, true)) fail("maintenance_stage_untrusted");
  };
  const read = async (name, area = "active") => {
    if (!STAGE.test(name) || !["active", "quarantine"].includes(area)) fail("maintenance_stage_untrusted");
    await root();
    const parent = area === "active" ? dataRoot : archive;
    if (area === "quarantine") {
      const meta = await lstat(parent).catch(error => error?.code === "ENOENT" ? null : fail("maintenance_stage_untrusted"));
      if (!meta) return null;
      if (!noLink(meta, true)) fail("maintenance_stage_untrusted");
    }
    const folder = path.join(parent, name);
    const dir = await lstat(folder).catch(error => error?.code === "ENOENT" ? null : fail("maintenance_stage_untrusted"));
    if (!dir) return null;
    if (!noLink(dir, true)) fail("maintenance_stage_untrusted");
    const members = await readdir(folder);
    if (members.length > 2 || members.some(member => ![MARKER, "artifact.zip"].includes(member)) || !members.includes(MARKER)) fail("maintenance_stage_untrusted");
    const markerPath = path.join(folder, MARKER);
    const m = await lstat(markerPath);
    if (!noLink(m, false) || m.size > 512) fail("maintenance_stage_untrusted");
    let marker;
    try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
    catch { fail("maintenance_stage_untrusted"); }
    if (!marker || Object.keys(marker).sort().join() !== "created_at,name,owner,schema,signature" ||
        marker.schema !== 1 || marker.owner !== "KTKQwenUpdater" || marker.name !== name ||
        !Number.isSafeInteger(marker.created_at) || marker.created_at < 0 || marker.created_at > now() ||
        typeof marker.signature !== "string" || !/^[a-f0-9]{64}$/.test(marker.signature)) fail("maintenance_stage_untrusted");
    const expected = Buffer.from(signature(key, name, marker.created_at), "hex");
    if (!timingSafeEqual(expected, Buffer.from(marker.signature, "hex"))) fail("maintenance_stage_untrusted");
    const age = now() - marker.created_at;
    const zip = members.includes("artifact.zip") ? await lstat(path.join(folder, "artifact.zip")) : null;
    if (zip && !noLink(zip, false)) fail("maintenance_stage_untrusted");
    return { name, signature: marker.signature, created_at: marker.created_at, stale: age >= MIN_AGE_MS,
      bytes: zip?.size ?? 0 };
  };
  const inspectCandidate = async () => {
    await root();
    const names = (await readdir(dataRoot)).filter(name => name.startsWith("update-"));
    if (names.length > 64) fail("maintenance_stage_inventory_too_large");
    let candidate = null;
    let rejected = 0;
    for (const name of names) {
      try {
        const item = await read(name);
        if (item?.stale && (!candidate || item.created_at < candidate.created_at)) candidate = item;
        else if (!item?.stale) rejected++;
      } catch { rejected++; }
    }
    return { candidate, rejected, scanned: names.length, estimated_freed_bytes: 0 };
  };
  const move = async (name, from, to) => {
    const existing = await read(name, from);
    if (!existing || (from === "active" && !existing.stale)) fail("maintenance_stage_changed");
    if (await read(name, to)) fail("maintenance_stage_destination_exists");
    if (to === "quarantine") {
      await mkdir(archive, { recursive: false, mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") fail("maintenance_stage_unavailable"); });
      const meta = await lstat(archive);
      if (!noLink(meta, true)) fail("maintenance_stage_untrusted");
    }
    await rename(path.join(from === "active" ? dataRoot : archive, name),
      path.join(to === "active" ? dataRoot : archive, name)).catch(() => fail("maintenance_stage_move_failed"));
    const verified = await read(name, to);
    if (!verified || verified.signature !== existing.signature || verified.bytes !== existing.bytes) fail("maintenance_stage_verification_failed");
    return verified;
  };
  return { inspectCandidate, inspect: read,
    quarantine: name => move(name, "active", "quarantine"),
    restore: name => move(name, "quarantine", "active") };
}
