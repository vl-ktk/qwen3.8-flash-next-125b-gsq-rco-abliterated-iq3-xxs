// Local future one-click installer stage. Never exposed through the remote MCP.
// No drive or executable path can be supplied by a remote or CLI caller.
import { prepareSc117Model, sc117Plan } from "./runtime/sc117-model.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--plan") {
  process.stdout.write(JSON.stringify(sc117Plan()) + "\n");
} else if (args.length === 2 && args[0] === "--prepare" && args[1] === "--installer-approved") {
  try { process.stdout.write(JSON.stringify(await prepareSc117Model({ approved: true })) + "\n"); }
  catch (error) {
    process.stderr.write(JSON.stringify({ status: "error", code: /^sc117_[a-z_]+$/.test(error?.code) ? error.code : "sc117_install_failed" }) + "\n");
    process.exitCode = 1;
  }
} else {
  process.stderr.write(JSON.stringify({ status: "error", code: "invalid_local_model_action" }) + "\n");
  process.exitCode = 2;
}
