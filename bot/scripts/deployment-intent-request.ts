#!/usr/bin/env bun

import { requestDeploymentIntent } from "../src/deployment-intent-ingress";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

try {
  const expectedCommit = option("--expected-commit");
  if (!expectedCommit) throw new Error("--expected-commit is required.");
  const result = await requestDeploymentIntent({ expectedCommit });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
