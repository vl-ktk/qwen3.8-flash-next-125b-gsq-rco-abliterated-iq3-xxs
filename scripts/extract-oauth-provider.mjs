// Offline reproduction from an owner-authorized export. No Cloudflare writes or credentials.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const input = process.argv[2];
if (!input) throw Error("Usage: node scripts/extract-oauth-provider.mjs <authorized multipart export or oauth.js>");
const sha = text => createHash("sha256").update(text).digest("hex");
let source = await readFile(input, "utf8");
if (source.startsWith("--")) {
  const boundary = source.slice(0, source.indexOf("\r\n"));
  const part = source.split(boundary).find(p => /name="oauth.js"/.test(p));
  if (!part) throw Error("oauth.js module missing");
  source = part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
}
const provenance = JSON.parse(await readFile(new URL("../src/cloudflare/vendor/provenance.json", import.meta.url)));
if (sha(source) !== provenance.source_module_sha256) throw Error("Source is not the verified v38 oauth.js module");
const end = source.indexOf("// ../generated-legacy-oauth.mjs");
if (end < 0) throw Error("Provider boundary missing");
const provider = source.slice(0, end).replace('// oauth.mjs\nimport { WorkerEntrypoint as WorkerEntrypoint3 } from "cloudflare:workers";\n\n', "");
if (sha(provider) !== provenance.extracted_provider_sha256) throw Error("Provider hash mismatch");
const output = provider + "\nexport { OAuthAuthorizationServer, AuthorizationError, openTransaction };\n";
if (sha(output) !== provenance.vendored_sha256) throw Error("Vendored hash mismatch");
await writeFile(new URL("../src/cloudflare/vendor/oauth-provider.mjs", import.meta.url), output);
console.log("Verified v38 OAuth provider extracted; social modules were not written.");
