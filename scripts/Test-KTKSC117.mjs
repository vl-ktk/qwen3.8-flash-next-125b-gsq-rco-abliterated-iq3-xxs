#!/usr/bin/env node
import { sc117InferencePlan, testSc117Inference } from "./runtime/sc117-inference.mjs";

const flags = process.argv.slice(2);
if (flags.length === 1 && flags[0] === "--plan") {
  console.log(JSON.stringify(sc117InferencePlan(), null, 2));
} else if (flags.length === 2 && flags.includes("--test") && flags.includes("--installer-approved")) {
  try {
    const result = await testSc117Inference({ approved: true });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", code: error?.code || "sc117_inference_failed" }));
    process.exitCode = 1;
  }
} else {
  console.error("Usage: Test-KTKSC117.mjs --plan | --test --installer-approved");
  process.exitCode = 2;
}
