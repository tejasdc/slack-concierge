#!/usr/bin/env bun

import { DeploymentRepairSupervisor } from "../src/deployment-repair-supervisor";

const incidentId = process.argv[2] || process.env.CONCIERGE_DEPLOYMENT_REPAIR_INCIDENT_ID;
if (!incidentId) {
  console.error("usage: deployment-repair.ts <incident-id>");
  process.exit(2);
}

try {
  const incident = await new DeploymentRepairSupervisor(incidentId).run();
  console.log(JSON.stringify({ status: incident.status, incident_id: incident.id, run_id: incident.run_id }));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
