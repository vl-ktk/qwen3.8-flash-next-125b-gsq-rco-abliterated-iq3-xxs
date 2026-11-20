// Called automatically by a future one-click Setup as the original Windows
// user. No arbitrary input, shell command, model download, or MCP write API.
import { installStrata, recoverIncompleteStrata, strataInstallPlan } from "./runtime/strata-installer.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--plan") {
  process.stdout.write(JSON.stringify(strataInstallPlan()) + "\n");
} else if (args.length === 2 && args[0] === "--install" && args[1] === "--installer-approved") {
  try { process.stdout.write(JSON.stringify(await installStrata({ ownerApproved: true })) + "\n"); }
  catch (error) {
    process.stderr.write(JSON.stringify({ status: "error", code: /^strata_[a-z_]+$/.test(error?.code) ? error.code : "strata_install_failed" }) + "\n");
    process.exitCode = 1;
  }
} else if (args.length === 2 && args[0] === "--recover" && args[1] === "--installer-approved") {
  try { process.stdout.write(JSON.stringify(await recoverIncompleteStrata({ ownerApproved: true })) + "\n"); }
  catch (error) {
    process.stderr.write(JSON.stringify({ status: "error", code: /^strata_[a-z_]+$/.test(error?.code) ? error.code : "strata_recovery_failed" }) + "\n");
    process.exitCode = 1;
  }
} else {
  process.stderr.write(JSON.stringify({ status: "error", code: "invalid_local_installer_action" }) + "\n");
  process.exitCode = 2;
}
