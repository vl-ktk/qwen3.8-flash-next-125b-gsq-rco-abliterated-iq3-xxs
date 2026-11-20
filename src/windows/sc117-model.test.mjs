import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lock from "./sc117-model.lock.json" with { type: "json" };
import { chooseSc117Volume, downloadVerifiedSc117File, hashSc117File, prepareSc117Model, sc117AssetLocation, sc117AssetUrl, sc117Plan, selectSc117Target, validateSc117Lock, verifySc117Packer } from "./sc117-model.mjs";

const fixture = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktk-sc117-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const sha = data => createHash("sha256").update(data).digest("hex");
const tiny = text => ({ bytes: Buffer.byteLength(text), sha256: sha(text) });
const testUrl = `https://huggingface.co/${lock.repository}/resolve/${lock.revision}/IQ3_XXS/test.gguf`;
const exists = async file => { try { await stat(file); return true; } catch { return false; } };

test("SC117 model lock pins both IQ3_XXS shards, four MTP artifacts and full revision", () => {
  assert.equal(validateSc117Lock(lock), lock);
  assert.equal(sc117Plan().status, "planned_no_changes");
  assert.equal(sc117Plan().number_of_files, 6);
  assert.equal(sc117Plan().model_and_mtp_bytes, 76966598276);
  assert.equal(sc117Plan().recommended_fresh_free_bytes, 130_000_000_000);
  assert.equal(sc117AssetUrl(lock.files[0]), `https://huggingface.co/${lock.repository}/resolve/${lock.revision}/${lock.files[0].path}`);
  assert.match(sc117AssetLocation("/models", lock.files[2]), /mtp[/\\]rt[/\\]dense\.bin$/);
  for (const changed of [
    x => { x.repository = "SomeoneElse/model"; },
    x => { x.revision = "main"; },
    x => { x.quantization = "IQ2_XS"; },
    x => { x.files[0].sha256 = "0".repeat(64); },
    x => { x.files.pop(); },
    x => { x.packer.sha256 = "0".repeat(64); },
  ]) {
    const modified = structuredClone(lock);
    changed(modified);
    assert.throws(() => validateSc117Lock(modified), /sc117_lock_untrusted/);
  }
  assert.throws(() => sc117AssetUrl({ ...lock.files[0] }), /sc117_asset_untrusted/);
});

test("streamed fresh download checks exact SHA256 and leaves only final file", async t => {
  const root = await fixture(t);
  const file = path.join(root, "IQ3_XXS", "test.gguf");
  const text = "verified-shard-fixture";
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(text, { status: 200 });
  };
  assert.equal((await downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny(text), fetchImpl })).status, "downloaded_verified");
  assert.equal(await readFile(file, "utf8"), text);
  assert.equal(await hashSc117File(file), sha(text));
  assert.equal((await readdir(path.dirname(file))).length, 1);
  assert.equal(calls[0].opts.headers.Range, "bytes=0-");
  assert.equal((await downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny(text), fetchImpl: async () => { throw Error("should not fetch again"); } })).status, "already_verified");
});

test("download reports bytes for GUI and safely resumes an already verified file", async t => {
  const root = await fixture(t);
  const destination = path.join(root, "asset.gguf");
  const body = "display download progress";
  const events = [];
  await downloadVerifiedSc117File({ destination, url: testUrl, asset: tiny(body),
    fetchImpl: async () => new Response(body, { status: 200 }), onProgress: received => events.push(received) });
  assert.deepEqual(events, [0, Buffer.byteLength(body)]);
  events.length = 0;
  await downloadVerifiedSc117File({ destination, url: testUrl, asset: tiny(body),
    fetchImpl: async () => { throw Error("no new network calls"); }, onProgress: received => events.push(received) });
  assert.deepEqual(events, [Buffer.byteLength(body)]);
});

test("interrupted HTTP download resumes only with matching metadata and strict 206 range", async t => {
  const root = await fixture(t);
  const file = path.join(root, "shard.gguf");
  const text = "resume-range-body";
  let first = 0;
  const fetchImpl = async (_url, opts) => {
    if (first++ === 0) {
      assert.equal(opts.headers.Range, "bytes=0-");
      return new Response(text.slice(0, 7), { status: 206, headers: { "content-range": `bytes 0-6/${text.length}` } });
    }
    throw Error("internet disconnected");
  };
  await assert.rejects(() => downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny(text), fetchImpl }), /sc117_download_interrupted/);
  assert.equal((await readFile(file + ".part", "utf8")), text.slice(0, 7));
  await assert.rejects(() => downloadVerifiedSc117File({ destination: file, url: testUrl, asset: { ...tiny(text), sha256: "1".repeat(64) }, fetchImpl }), /sc117_partial_unowned/);
  const resumed = async (_url, opts) => {
    assert.equal(opts.headers.Range, "bytes=7-");
    return new Response(text.slice(7), { status: 206, headers: { "content-range": `bytes 7-${text.length - 1}/${text.length}` } });
  };
  assert.equal((await downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny(text), fetchImpl: resumed })).status, "downloaded_verified");
  assert.equal(await readFile(file, "utf8"), text);
  assert.equal(await exists(file + ".part"), false);
});

test("user cancellation preserves owned partial model bytes and its resume marker", async t => {
  const root = await fixture(t);
  const destination = path.join(root, "cancelled.gguf");
  const body = "resume-after-cancel";
  const encoded = new TextEncoder();
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.encode(body.slice(0, 7)));
      controller.enqueue(encoded.encode(body.slice(7)));
      controller.close();
    },
  }), { status: 200 });
  await assert.rejects(downloadVerifiedSc117File({
    destination, url: testUrl, asset: tiny(body), fetchImpl,
    onProgress: received => {
      if (received >= 7) throw Object.assign(new Error("localai_user_cancelled"), { code: "localai_user_cancelled" });
    },
  }), /localai_user_cancelled/);
  assert.equal(await readFile(destination + ".part", "utf8"), body.slice(0, 7));
  assert.equal(await exists(destination + ".download.json"), true);
  assert.equal(await exists(destination), false);
  const resume = async (_url, opts) => {
    assert.equal(opts.headers.Range, "bytes=7-");
    return new Response(body.slice(7), { status: 206,
      headers: { "content-range": "bytes 7-" + (body.length - 1) + "/" + body.length } });
  };
  assert.equal((await downloadVerifiedSc117File({ destination, url: testUrl, asset: tiny(body), fetchImpl: resume })).status, "downloaded_verified");
});

test("cancellation aborts a stalled HTTPS fetch without waiting for the two-hour timeout", async t => {
  const root = await fixture(t);
  const destination = path.join(root, "stalled.gguf");
  const controller = new AbortController();
  const pending = downloadVerifiedSc117File({
    destination, url: testUrl, asset: tiny("missing response"), signal: controller.signal,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  setTimeout(() => controller.abort(Object.assign(new Error("localai_user_cancelled"), { code: "localai_user_cancelled" })), 10);
  await assert.rejects(pending, /localai_user_cancelled/);
  assert.equal(await exists(destination + ".part"), true);
  assert.equal(await exists(destination + ".download.json"), true);
});

test("resumed downloads refuse full 200, wrong ranges, redirect to untrusted host", async t => {
  const root = await fixture(t);
  const text = "abcdefghij";
  const bads = [
    { response: new Response(text, { status: 200 }), code: /sc117_range_not_supported/ },
    { response: new Response(text.slice(5), { status: 206, headers: { "content-range": "bytes 6-9/10" } }), code: /sc117_range_invalid/ },
  ];
  for (const [i, bad] of bads.entries()) {
    const file = path.join(root, `test-${i}.bin`);
    const first = async () => new Response(text.slice(0, 5), { status: 206, headers: { "content-range": "bytes 0-4/10" } });
    let requests = 0;
    await assert.rejects(() => downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny(text), fetchImpl: async (...args) => (++requests === 1 ? first(...args) : new Response(null, { status: 500 })) }), /sc117_range_not_supported/);
    await assert.rejects(() => downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny(text), fetchImpl: async () => bad.response }), bad.code);
    assert.equal(await readFile(file + ".part", "utf8"), text.slice(0, 5));
  }
  await assert.rejects(() => downloadVerifiedSc117File({ destination: path.join(root, "no-network.bin"), url: "https://evil.example/asset", asset: tiny(text) }), /sc117_asset_untrusted/);
});

test("checksum errors clean only owned .part; an existing unverified final is never overwritten", async t => {
  const root = await fixture(t);
  const file = path.join(root, "test.bin");
  await assert.rejects(() => downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny("expected"), fetchImpl: async () => new Response("altered!", { status: 200 }) }), /sc117_download_hash_mismatch/);
  assert.equal(await exists(file), false);
  assert.equal(await exists(file + ".part"), false);
  await writeFile(file, "keep-me");
  await assert.rejects(() => downloadVerifiedSc117File({ destination: file, url: testUrl, asset: tiny("expected"), fetchImpl: async () => { throw Error("no network"); } }), /sc117_existing_file_invalid/);
  assert.equal(await readFile(file, "utf8"), "keep-me");
});

test("volume selection prefers fixed D:, falls back to C:, and requires enough measured space", () => {
  const needed = sc117Plan().minimum_fresh_free_bytes;
  assert.match(chooseSc117Volume([{ drive: "C:", free_bytes: needed + 1 }, { drive: "D:", free_bytes: needed + 1 }]).root, /^D:\\/);
  assert.match(chooseSc117Volume([{ drive: "C:", free_bytes: needed + 1 }, { drive: "D:", free_bytes: needed - 1 }]).root, /^C:\\/);
  assert.throws(() => chooseSc117Volume([{ drive: "D:", free_bytes: needed - 1 }]), /sc117_disk_insufficient/);
});

test("incomplete download stays on D: after free space drops below fresh-install admission", async t => {
  const dir = await fixture(t);
  const rootD = path.join(dir, "D-model");
  const rootC = path.join(dir, "C-model");
  await mkdir(rootD);
  await writeFile(path.join(rootD, "ktk-sc117-install.json"), JSON.stringify({ schema: 1, revision: lock.revision, quantization: "IQ3_XXS", nonce: "a".repeat(32), status: "downloading" }));
  const partial = sc117AssetLocation(rootD, lock.files[0]) + ".part";
  await mkdir(path.dirname(partial), { recursive: true });
  await writeFile(partial, "");
  const measureFile = async file => {
    const info = await stat(file).catch(() => null);
    return file === partial && info ? { size: 30_000_000_000 } : info;
  }; // Fixture simulates 30 GB of resumed data without allocating it on Windows.
  const picked = await selectSc117Target([{ drive: "D:", free_bytes: 80_000_000_000 }, { drive: "C:", free_bytes: 200_000_000_000 }], lock,
    drive => drive === "D:" ? rootD : rootC, measureFile);
  assert.equal(picked.root, rootD);
  assert.equal(picked.resuming, true);
  assert.ok(picked.remaining_bytes < 50_000_000_000);
});

async function mockStrata(t) {
  const root = await fixture(t);
  const strata = path.join(root, "Strata");
  const bin = path.join(strata, "terminal", "current");
  await mkdir(path.join(bin, "python"), { recursive: true });
  await mkdir(path.join(bin, "tools"));
  await writeFile(path.join(strata, "ktk-strata-install.json"), JSON.stringify({ schema: 1, status: "ready", version: "0.2.17" }));
  await writeFile(path.join(bin, "python", "python.exe"), "fake-runtime");
  await writeFile(path.join(bin, "tools", "iq_pack.py"), "fake-official-pack-script");
  return { root, strata, bin, modelRoot: path.join(root, "KTK", "Models", "SC117-IQ3_XXS") };
}
const fakeDownloads = async ({ destination }) => { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, "fixture"); return { status: "downloaded_verified" }; };
const makePack = async (_exe, args, options) => {
  assert.equal(options.shell, false);
  assert.equal(options.env.OAUTH_SECRET, undefined);
  assert.deepEqual(args.slice(1, 2), ["--gguf"]);
  const stage = args[args.length - 1];
  for (const p of ["native_experts.txt", "index.txt", "dense.bin", "tokenizer/vocab.json", "tokenizer/chat_template.jinja"]) {
    await mkdir(path.dirname(path.join(stage, p)), { recursive: true });
    await writeFile(path.join(stage, p), "fixture");
  }
  return { stdout: "test pack complete", exitCode: 0 };
};

test("model preparation requires approval and preinstalled pinned Strata", async t => {
  const f = await mockStrata(t);
  const args = { platform: "win32", arch: "x64", root: f.modelRoot, strataRoot: f.strata, downloadFile: fakeDownloads, verifyPacker: async () => true, invoke: makePack };
  await assert.rejects(() => prepareSc117Model({ ...args, approved: false }), /sc117_owner_approval_required/);
  await assert.rejects(() => prepareSc117Model({ ...args, approved: true, platform: "linux" }), /sc117_windows_x64_required/);
  assert.equal(await exists(f.modelRoot), false);
  await writeFile(path.join(f.strata, "ktk-strata-install.json"), JSON.stringify({ schema: 1, status: "installing", version: "0.2.17" }));
  await assert.rejects(() => prepareSc117Model({ ...args, approved: true }), /sc117_strata_not_ready/);
});

test("official packer must match pinned Strata script before any model write", async t => {
  const f = await mockStrata(t);
  await assert.rejects(() => verifySc117Packer(path.join(f.bin, "tools", "iq_pack.py")), /sc117_packer_unverified/);
  await assert.rejects(() => prepareSc117Model({ approved: true, platform: "win32", arch: "x64", root: f.modelRoot, strataRoot: f.strata, downloadFile: fakeDownloads }), /sc117_packer_unverified/);
  assert.equal(await exists(f.modelRoot), false);
});

test("one approved local transaction downloads six files and builds only SC117 pack", async t => {
  const f = await mockStrata(t);
  const calls = [];
  const args = { approved: true, platform: "win32", arch: "x64", root: f.modelRoot, strataRoot: f.strata,
    verifyPacker: async () => true,
    downloadFile: async params => { calls.push(params); return fakeDownloads(params); },
    invoke: async (exe, packArgs, settings) => {
      assert.equal(exe, path.join(f.bin, "python", "python.exe"));
      assert.equal(packArgs[0], path.join(f.bin, "tools", "iq_pack.py"));
      assert.equal(packArgs[1], "--gguf");
      assert.equal(packArgs[3], "--out");
      assert.match(packArgs[2], /-00001-of-00002\.gguf$/);
      return makePack(exe, packArgs, settings);
    } };
  const result = await prepareSc117Model(args);
  assert.equal(result.status, "prepared_for_inference_test");
  assert.equal(result.inference_tested, false);
  assert.equal(calls.length, 6);
  assert.equal((await readFile(path.join(f.modelRoot, "ktk-sc117-install.json"), "utf8")).includes('"status":"ready"'), true);
  assert.equal(await exists(path.join(f.modelRoot, "pack-incomplete")), false);
  assert.equal((await prepareSc117Model({ ...args, downloadFile: async () => { throw Error("must skip"); }, invoke: async () => { throw Error("must skip"); } })).status, "already_prepared_not_rehashed");
});

test("pack failure cleans only its stage and retains download files for retry", async t => {
  const f = await mockStrata(t);
  const args = { approved: true, platform: "win32", arch: "x64", root: f.modelRoot, strataRoot: f.strata, downloadFile: fakeDownloads };
  args.verifyPacker = async () => true;
  await assert.rejects(() => prepareSc117Model({ ...args, invoke: async () => { throw Error("contains secret should not leak"); } }), /sc117_pack_failed/);
  const shard = sc117AssetLocation(f.modelRoot, lock.files[0]);
  assert.equal(await exists(shard), true);
  assert.equal(await exists(path.join(f.modelRoot, "pack-incomplete")), false);
  assert.equal((await prepareSc117Model({ ...args, invoke: makePack })).status, "prepared_for_inference_test");
});

test("existing arbitrary model root is preserved and never replaced", async t => {
  const f = await mockStrata(t);
  await mkdir(f.modelRoot, { recursive: true });
  await writeFile(path.join(f.modelRoot, "user-data.txt"), "protected");
  await assert.rejects(() => prepareSc117Model({ approved: true, platform: "win32", arch: "x64", root: f.modelRoot, strataRoot: f.strata, downloadFile: fakeDownloads, verifyPacker: async () => true }), /sc117_existing_install_unrecognized/);
  assert.equal(await readFile(path.join(f.modelRoot, "user-data.txt"), "utf8"), "protected");
});
