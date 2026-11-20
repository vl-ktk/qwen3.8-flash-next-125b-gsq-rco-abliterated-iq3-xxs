import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOriginVerifier } from "./origin-auth.mjs";
import { validateUpdateOffer, signUpdateRequest, createUpdaterServer, callLocalUpdater, downloadVerifiedRelease, applyVerifiedRelease, runFixedUserTask } from "./remote-update.mjs";

const key = randomBytes(32).toString("base64url");
const bytes = Buffer.from("signed trusted release fixture");
const offer = { version: "0.18.6", url: "https://github.com/vl-ktk/repo/releases/download/v0.18.6/payload.zip", sha256: createHash("sha256").update(bytes).digest("hex") };

test("remote upgrade offers reject arbitrary commands, paths, hosts and malformed hashes", () => {
  assert.deepEqual(validateUpdateOffer(offer), offer);
  for (const candidate of [
    { ...offer, command: "powershell.exe" }, { ...offer, path: "C:\\Windows" },
    { ...offer, version: "0.18.5;shutdown" }, { ...offer, sha256: "0".repeat(63) },
    { ...offer, url: "http://github.com/payload" }, { ...offer, url: "https://evil.example/payload" },
    { ...offer, url: "https://attacker:password@github.com/payload" },
    { ...offer, url: "file:///C:/payload.zip" },
  ]) assert.throws(() => validateUpdateOffer(candidate));
});

test("local HMAC verifier binds method, route, body and single-use nonce", () => {
  const verify = createOriginVerifier(key);
  const body = JSON.stringify(offer);
  const headers = signUpdateRequest(key, "POST", "/v1/update", body);
  assert.equal(verify(headers, "POST", "/v1/update", body), true);
  assert.equal(verify(headers, "POST", "/v1/update", body), false);
  assert.equal(verify(signUpdateRequest(key, "POST", "/v1/update", body), "POST", "/v1/status", body), false);
  assert.equal(verify(signUpdateRequest(key, "POST", "/v1/update", body), "POST", "/v1/update", "tampered"), false);
});

test("remote updater accepts only authenticated localhost offers and exposes bounded status", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-remote-updater-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  let finished;
  const gate = new Promise(resolve => { finished = resolve; });
  const server = createUpdaterServer({ keyText: key, port: 0, dataRoot: dir, updaterRoot: dir,
    apply: async input => { calls++; assert.deepEqual(input, offer); await gate; return { status: "updated" }; } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + "/v1/status")).status, 403);
  assert.equal((await fetch(base + "/v1/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(offer) })).status, 403);
  assert.deepEqual(await callLocalUpdater("update", offer, { keyText: key, port }), { status: "accepted", version: offer.version });
  assert.equal(calls, 1);
  assert.equal((await callLocalUpdater("status", null, { keyText: key, port })).status, "running");
  assert.equal((await callLocalUpdater("update", offer, { keyText: key, port }).catch(e => e.code)), "updater_unavailable");
  finished();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await callLocalUpdater("status", null, { keyText: key, port })).status, "updated");
  assert.equal(JSON.parse(await readFile(path.join(dir, "status.json"), "utf8")).status, "updated");
});

test("unified status waits for the user task and recognizes verified completion", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-updater-user-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createUpdaterServer({ keyText: key, dataRoot: dir, updaterRoot: dir,
    initialStatus: { status: "user_pending", version: "0.18.7", started_at: new Date(Date.now() - 10000).toISOString() },
    checkUser: async () => ({ state: "Ready", last_result: 0, last_run: new Date().toISOString() }),
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const status = await callLocalUpdater("status", null, { keyText: key, port: server.address().port });
  assert.equal(status.status, "updated");
  assert.equal(status.version, "0.18.7");
});

test("a failed user phase can be retried only through authenticated fixed resume", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-updater-user-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const server = createUpdaterServer({ keyText: key, dataRoot: dir, updaterRoot: dir,
    initialStatus: { status: "user_failed", version: "0.18.7" },
    resumeUser: async () => { calls++; return { status: "queued" }; },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/resume`, { method: "POST" })).status, 403);
  assert.equal((await callLocalUpdater("resume", null, { keyText: key, port })).status, "queued");
  assert.equal(calls, 1);
  assert.equal((await callLocalUpdater("status", null, { keyText: key, port })).status, "user_pending");
});

test("resume rotates the fixed user job attempt, never runs caller-chosen commands", async () => {
  const initial = { schema: 1, version: "0.18.7", attempt: "b".repeat(32), manifest_sha256: "a".repeat(64) };
  const wrote = [];
  const calls = [];
  const result = await runFixedUserTask({ read: async () => JSON.stringify(initial), write: async (file, body) => wrote.push({ file, job: JSON.parse(body) }),
    invoke: async (exe, args, options) => { calls.push({ exe, args, options }); return { stdout: "ok" }; },
  });
  assert.equal(result.status, "queued");
  assert.match(wrote[0].file, /\\KTK\\Updater\\public\\job\.json$/);
  assert.notEqual(wrote[0].job.attempt, initial.attempt);
  assert.deepEqual(calls[0].args, ["/run", "/tn", "KTKQwenUserUpdater"]);
  assert.equal(calls[0].options.shell, false);
});

test("release fetch hashes actual bytes, rejects redirects and size mismatch", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-release-stream-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetcher = async () => new Response(bytes, { status: 200 });
  assert.equal(await downloadVerifiedRelease(offer, path.join(dir, "valid.zip"), { fetcher }), bytes.length);
  assert.deepEqual(await readFile(path.join(dir, "valid.zip")), bytes);
  await assert.rejects(() => downloadVerifiedRelease({ ...offer, sha256: "f".repeat(64) }, path.join(dir, "bad.zip"), { fetcher }), /update_checksum_mismatch/);
  await assert.rejects(() => downloadVerifiedRelease(offer, path.join(dir, "limit.zip"), { fetcher, maxBytes: 2 }), /update_too_large/);
  await assert.rejects(() => downloadVerifiedRelease(offer, path.join(dir, "redirect.zip"), { fetcher: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/installer" } }) }), /update_source_denied/);
});

test("privileged updater runs only its bundled fixed PS script with fixed argument flags", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktk-updater-run-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  await applyVerifiedRelease(offer, { updaterRoot: dir, dataRoot: dir,
    download: async () => bytes.length,
    invoke: async (exe, args, options) => { calls.push({ exe, args, options }); return { stdout: "KTK_USER_UPDATE_QUEUED\n" }; },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.equal(calls[0].args[5], path.join(dir, "Run-KTKRemoteUpdate.ps1"));
  assert.equal(calls[0].args.at(-2), "-Version");
  assert.equal(calls[0].args.at(-1), offer.version);
  assert.equal(calls[0].options.shell, false);
});

test("PowerShell privileged update uses SYSTEM gate and packaged maintenance, never arbitrary scripts", async () => {
  const script = await readFile(new URL("../../scripts/Run-KTKRemoteUpdate.ps1", import.meta.url), "utf8");
  const installer = await readFile(new URL("../../scripts/Install-KTKUpdater.ps1", import.meta.url), "utf8");
  const maintenance = await readFile(new URL("../../scripts/Maintain-KTKMCP.ps1", import.meta.url), "utf8");
  const unified = await readFile(new URL("../../scripts/Apply-KTKUnifiedRelease.ps1", import.meta.url), "utf8");
  assert.match(script, /S-1-5-18/);
  assert.match(script, /ZipFile\]::OpenRead/);
  assert.match(script, /Apply-KTKUnifiedRelease\.ps1/);
  assert.match(unified, /-Action Update -PackagePath \$PackagePath -Resume -UpdaterApproved/);
  assert.match(unified, /KTKQwenUserUpdater/);
  assert.match(maintenance, /updater_approval_requires_localsystem_live_update/);
  assert.match(installer, /KTKQwenUpdater\.exe/);
  assert.match(installer, /updater_existing_service_not_owned/);
  assert.doesNotMatch(installer, /(?<![A-Za-z])Invoke-Expression|\biex\b|Set-ExecutionPolicy/i);
});
