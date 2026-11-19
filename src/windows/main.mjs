import { readFile } from "node:fs/promises";
import { listenWindowsMcp } from "./mcp-server.mjs";

// Step 15 installer will provide a Windows-ACL-protected identity file and
// provision the paired device ID. Neither is bundled with distributables.
const identityPath = process.env.QWEN_DEVICE_IDENTITY_PATH;
const deviceId = process.env.QWEN_DEVICE_ID;
if (Boolean(identityPath) !== Boolean(deviceId)) throw Error("incomplete_device_identity_configuration");

const identity = identityPath ? JSON.parse(await readFile(identityPath, "utf8")) : null;
const server = await listenWindowsMcp({
  port: Number(process.env.QWEN_MCP_PORT ?? "8765"),
  identity,
  deviceId,
});

process.stdout.write(`Qwen MCP loopback listening on 127.0.0.1:${server.address().port}\n`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
