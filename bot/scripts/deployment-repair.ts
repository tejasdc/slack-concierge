#!/usr/bin/env bun

import { DeploymentRepairSupervisor } from "../src/deployment-repair-supervisor";
import { notifyDeploymentWorker } from "../src/deployment-worker-wake";

const incidentId = process.argv[2] || process.env.CONCIERGE_DEPLOYMENT_REPAIR_INCIDENT_ID;
if (!incidentId) {
  console.error("usage: deployment-repair.ts <incident-id>");
  process.exit(2);
}

let exitCode = 0;
try {
  const incident = await new DeploymentRepairSupervisor(incidentId).run();
  console.log(JSON.stringify({ status: incident.status, incident_id: incident.id, run_id: incident.run_id }));
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  exitCode = 1;
} finally {
  notifyDeploymentWorker();
}
process.exit(exitCode);
