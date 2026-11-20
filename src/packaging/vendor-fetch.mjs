import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { sha256File, validatePackageLock } from "./windows-package.mjs";

export async function fetchWindowsVendors({ lock, destination, fetcher = fetch }) {
  validatePackageLock(lock);
  await mkdir(destination, { recursive: true });
  for (const entry of [...lock.artifacts, ...lock.licenses]) {
    const file = path.join(destination, entry.file);
    try {
      const present = await lstat(file);
      if (!present.isFile() || (entry.sha256 && await sha256File(file) !== entry.sha256)) throw Error("existing_vendor_untrusted");
      continue;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const response = await fetcher(entry.url, { signal: AbortSignal.timeout(180000), redirect: "follow" });
    if (!response.ok || !response.body) throw Error("vendor_download_failed");
    const partial = file + ".partial";
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.byteLength;
      callback(bytes > (entry.sha256 ? 130 * 1024 * 1024 : 1024 * 1024) ? Error("vendor_too_large") : null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(partial, { flags: "wx" }));
      if (bytes < (entry.sha256 ? 1024 * 1024 : 32)) throw Error("vendor_too_small");
      if (entry.sha256 && await sha256File(partial) !== entry.sha256) throw Error("vendor_checksum_mismatch");
      await rename(partial, file);
    } finally { await rm(partial, { force: true }); }
  }
}
