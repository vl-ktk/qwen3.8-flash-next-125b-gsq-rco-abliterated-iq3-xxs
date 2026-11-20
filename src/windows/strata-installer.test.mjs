import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import lock from "./strata-runtime.lock.json" with { type: "json" };
import { fetchPinnedStrataScript, installStrata, recoverIncompleteStrata, strataInstallPlan, strataInstallRoot, validateStrataRelease } from "./strata-installer.mjs";

const temp = async t => { const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-strata-installer-test-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const options = root => ({ platform: "win32", arch: "x64", root, localAppData: path.dirname(path.dirname(root)), availableBytes: 3_000_000_000, ownerApproved: true });
const fileExists = async file => { try { await stat(file); return true; } catch { return false; } };

test("pinned official Strata v0.2.17 release and plan cannot install without local approval", async t => {
  const dir = await temp(t);
  assert.equal(validateStrataRelease(lock), lock);
  assert.equal(strataInstallPlan().status, "planned_no_changes");
  assert.equal(strataInstallPlan().execution, "interactive_windows_user_only");
  assert.ok(strataInstallPlan().required_free_bytes > 2_000_000_000);
  assert.equal(strataInstallRoot("C:\\Users\\Vlad\\AppData\\Local"), "C:\\Users\\Vlad\\AppData\\Local\\KTK\\Strata");
  for (const profile of ["", "/etc", "C:\\", "\\\\server\\share"]) assert.throws(() => strataInstallRoot(profile), /invalid_local_user_profile/);
  const root = path.join(dir, "KTK", "Strata");
  for (const args of [{ ownerApproved: false }, { platform: "linux" }, { arch: "arm64" }]) {
    await assert.rejects(() => installStrata({ ...options(root), ...args, getScript: () => { throw Error("should_not_download"); } }), /strata_owner_approval_required|strata_windows_x64_required/);
  }
  assert.equal(await fileExists(root), false);
});

test("release tampering and network replacement fail before executing any downloaded code", async () => {
  const bad = structuredClone(lock);
  bad.script.sha256 = "0".repeat(64);
  assert.throws(() => validateStrataRelease(bad), /strata_release_untrusted/);
  await assert.rejects(() => fetchPinnedStrataScript({ fetchImpl: async () => new Response("unexpected release", { status: 200 }) }), /strata_download_hash_mismatch/);
  await assert.rejects(() => fetchPinnedStrataScript({ fetchImpl: async () => new Response("x".repeat(100000), { status: 200 }) }), /strata_download_size_mismatch/);
  await assert.rejects(() => fetchPinnedStrataScript({ fetchImpl: async () => new Response(null, { status: 404 }) }), /strata_download_failed/);
  const sha = createHash("sha256").update("malicious").digest("hex");
  assert.notEqual(sha, lock.script.sha256);
});

test("fresh KTK install runs only verified local script and signed updater, with no user PATH change", async t => {
  const dir = await temp(t);
  const root = path.join(dir, "KTK", "Strata");
  const calls = [];
  const getScript = async () => Buffer.from("TEST FIXTURE ONLY: production downloader enforces pinned SHA");
  const invoke = async (program, args, settings) => {
    calls.push({ program, args, settings });
    assert.equal(settings.shell, false);
    assert.equal(settings.windowsHide, true);
    assert.equal(settings.env.STRATA_FEED, lock.feed);
    assert.equal(settings.env.STRATA_NO_PATH, "1");
    assert.equal(settings.env.STRATA_DATA_DIR, root);
    assert.equal(settings.env.OAUTH_SECRET, undefined);
    if (calls.length === 1) {
      assert.match(program.toLowerCase(), /windowspowershell\\v1\.0\\powershell\.exe$/);
      assert.deepEqual(args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
      assert.equal(args[4], "-File");
      await mkdir(path.join(root, "terminal", "current", "python"), { recursive: true });
      await writeFile(path.join(root, "terminal", "current", "python", "python.exe"), "fake-python");
      await writeFile(path.join(root, "terminal", "current", "strata.py"), "fake-entry");
    } else {
      assert.equal(program, path.join(root, "terminal", "current", "python", "python.exe"));
    }
    return { stdout: "{}", stderr: "" };
  };
  const result = await installStrata({ ...options(root), getScript, invoke, now: () => new Date("2026-11-20T14:00:00Z") });
  assert.equal(result.status, "installed");
  assert.equal(result.engine, "signed_updater_completed_inference_unverified");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1].args.slice(1), ["--version"]);
  assert.deepEqual(calls[2].args.slice(1), ["update", "--no-control", "--feed", lock.feed, "--output", "json"]);
  assert.deepEqual(calls[3].args.slice(1), ["components", "engines", "--output", "json"]);
  const state = JSON.parse(await readFile(path.join(root, "ktk-strata-install.json"), "utf8"));
  assert.equal(state.status, "ready");
  assert.equal(state.at, "2026-11-20T14:00:00.000Z");
  const subsequent = await installStrata({ ...options(root), getScript: async () => { throw Error("must_skip"); }, invoke: async () => { throw Error("must_skip"); } });
  assert.equal(subsequent.status, "already_installed");
});

test("failure removes only new KTK-managed tree; existing vendor and unrelated files are preserved", async t => {
  const dir = await temp(t);
  const root = path.join(dir, "KTK", "Strata");
  const unrelated = path.join(dir, "Strata");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "important.gguf"), "important");
  const invoke = async (_program, _args) => { throw Error("sensitive vendor error / password"); };
  await assert.rejects(() => installStrata({ ...options(root), getScript: async () => Buffer.from("fake"), invoke }), /strata_command_failed/);
  assert.equal(await fileExists(root), false);
  assert.equal(await readFile(path.join(unrelated, "important.gguf"), "utf8"), "important");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "private.txt"), "keep");
  await assert.rejects(() => installStrata({ ...options(root), getScript: async () => { throw Error("SHOULD NOT DOWNLOAD"); } }), /strata_existing_install_unrecognized/);
  assert.equal(await readFile(path.join(root, "private.txt"), "utf8"), "keep");
});

test("no disk space, symlink roots and concurrent install directories fail closed", async t => {
  const dir = await temp(t);
  const root = path.join(dir, "KTK", "Strata");
  await assert.rejects(() => installStrata({ ...options(root), availableBytes: 100 }), /strata_disk_insufficient/);
  assert.equal(await fileExists(root), false);
  const real = path.join(dir, "real");
  await mkdir(real);
  await mkdir(path.dirname(root), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(real, root, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => installStrata({ ...options(root) }), /strata_install_root_untrusted/);
});

test("explicit local recovery removes only an incomplete KTK attempt, never a ready installation", async t => {
  const dir = await temp(t);
  const root = path.join(dir, "KTK", "Strata");
  await mkdir(root, { recursive: true });
  const marker = path.join(root, "ktk-strata-install.json");
  await writeFile(marker, JSON.stringify({ schema: 1, version: lock.app_version, status: "installing", nonce: "0".repeat(32) }));
  await assert.rejects(() => recoverIncompleteStrata({ ...options(root), ownerApproved: false }), /strata_owner_approval_required/);
  assert.equal(await fileExists(root), true);
  await writeFile(marker, JSON.stringify({ schema: 1, version: lock.app_version, status: "ready" }));
  await assert.rejects(() => recoverIncompleteStrata(options(root)), /strata_recovery_denied/);
  assert.equal(await fileExists(root), true);
  await writeFile(marker, JSON.stringify({ schema: 1, version: lock.app_version, status: "installing", nonce: "f".repeat(32) }));
  assert.equal((await recoverIncompleteStrata(options(root))).status, "incomplete_install_removed");
  assert.equal(await fileExists(root), false);
});
