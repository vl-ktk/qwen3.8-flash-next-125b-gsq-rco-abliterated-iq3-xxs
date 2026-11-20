// Immutable bootstrap installed once with Setup.exe. On service restarts,
// load the updated MCP-owned module so ordinary verified releases can upgrade
// the updater's logic. A working bootstrap remains as an offline fallback.
import path from "node:path";
import { pathToFileURL } from "node:url";

const current = path.win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "KTK", "QwenMCP", "runtime", "remote-update.mjs");
let module;
try { module = await import(pathToFileURL(current).href); }
catch { module = await import("./remote-update.mjs"); }
await module.runUpdaterService();
