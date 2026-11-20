import { readFile } from "node:fs/promises";
import { listenWindowsMcp } from "./mcp-server.mjs";
import { createWindowsToolRegistry } from "./windows-tools.mjs";
import { createGracefulShutdown } from "./administration.mjs";

// Step 15 installer will provide a Windows-ACL-protected identity file and
// provision the paired device ID. Neither is bundled with distributables.
const identityPath = process.env.QWEN_DEVICE_IDENTITY_PATH;
const deviceId = process.env.QWEN_DEVICE_ID;
if (Boolean(identityPath) !== Boolean(deviceId)) throw Error("incomplete_device_identity_configuration");

const identity = identityPath ? JSON.parse(await readFile(identityPath, "utf8")) : null;
const allowedFileRoots = process.env.QWEN_MCP_ALLOWED_FILE_ROOTS ? JSON.parse(process.env.QWEN_MCP_ALLOWED_FILE_ROOTS) : [];
const server = await listenWindowsMcp({
  port: Number(process.env.QWEN_MCP_PORT ?? "8765"),
  identity,
  deviceId,
  toolRegistry: createWindowsToolRegistry({ allowedFileRoots, identityConfigured: Boolean(identity && deviceId) }),
});

process.stdout.write(`Qwen MCP loopback listening on 127.0.0.1:${server.address().port}\n`);
const gracefulShutdown = createGracefulShutdown(server, { exit: code => process.exit(code) });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, gracefulShutdown);
