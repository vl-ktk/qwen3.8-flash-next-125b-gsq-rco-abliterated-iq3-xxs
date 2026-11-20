#!/usr/bin/env node
import { localAiSetupPlan, runLocalAiSetup } from "./runtime/local-ai-setup.mjs";

const flags = process.argv.slice(2);
if (flags.length === 1 && flags[0] === "--plan") {
  console.log(JSON.stringify(localAiSetupPlan(), null, 2));
} else if (flags.length === 2 && flags.includes("--install") && flags.includes("--installer-approved")) {
  try {
    const result = await runLocalAiSetup({ approved: true });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", code: error?.code || "localai_setup_failed" }));
    process.exitCode = 1;
  }
} else {
  console.error("Usage: Install-KTKLocalAI.mjs --plan | --install --installer-approved");
  process.exitCode = 2;
}
