import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebClient } from "@slack/web-api";

const [action, stateDirectory, configPath, turnText, root] = process.argv.slice(2);
if (!resolve(stateDirectory).startsWith("/var/lib/slack-concierge-sandbox/lanes/")
  || !stateDirectory.includes("/runs/") || !["repair", "park", "project"].includes(action)) {
  throw new Error("Repair fixture requires an isolated claimed sandbox run.");
}
process.env.CONCIERGE_STATE_DIR = stateDirectory;
process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT = join(stateDirectory, "repair-fixture");
const state = await import("../../../src/deployment-state");
const { db, registerProcessInstance } = await import("../../../src/state");
const { currentProcessIdentity } = await import("../../../src/runtime-identity");
const { DeploymentRepairSupervisor } = await import("../../../src/deployment-repair-supervisor");
const { reconcileDeploymentWork } = await import("../../../src/deployment-worker");
const turnId = Number(turnText);
const turn = db.query(`SELECT t.*, s.slack_channel_id FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=?`).get(turnId) as any;
if (!turn || turn.status !== "done" || turn.delivery_status !== "delivered") throw new Error("Exact Slack turn must be delivered.");
const identity = currentProcessIdentity();
registerProcessInstance("repair-sandbox-fixture", identity.pid, identity.bootId, identity.startTicks);
let incident: any;
if (action === "repair") {
  const run = state.requestOperatorDeployment().run;
  state.claimDeploymentRun({ runId: run.id, pid: 990099, bootId: "sandbox-dead", startTicks: "1" });
  for (const phase of ["updating", "restarting", "verifying", "releasing"] as const) state.recordDeploymentRunPhase(run.id, phase);
  const final = db.query("SELECT slack_ts FROM turn_delivery_chunks WHERE turn_id=? ORDER BY chunk_index LIMIT 1").get(turnId) as any;
  state.registerDeploymentTurnReactionTargets(run.id, [{ turnId, slackChannelId: turn.slack_channel_id,
    slackUserMessageTs: turn.slack_user_msg_ts, slackMessageTs: final.slack_ts }]);
  incident = state.beginDeploymentRepair({ runId: run.id, failedCommit: "c".repeat(40), restoredCommit: "d".repeat(40),
    failureFingerprint: "sandbox-drain-lock", error: "Controlled database lock" });
  state.claimDeploymentRepair({ incidentId: incident.id, ...identity });
  const directory = join(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT!, "incidents", incident.id);
  mkdirSync(directory, { recursive: true });
  const uuid = "01a039f1-9e1b-71d1-8f89-a6431c3d53b0";
  const supervisor = new DeploymentRepairSupervisor(incident.id, root, {
    command: () => { throw new Error("No host commands in Slack fixture"); }, isAlive: () => false,
    async runAgent(input) {
      input.onSpawn(process.pid);
      input.onSession(uuid);
      writeFileSync(input.finalMessagePath, "Controlled repair complete.");
      return 0;
    },
  });
  await (supervisor as any).runPersistedAgent("repair", { ...incident, worktree_path: directory }, "First repair", null);
  state.recordDeploymentRepairCommit(incident.id, "e".repeat(40));
  state.recordDeploymentRepairReview(incident.id, "NO_SHIP", { verdict: "NO_SHIP", blockers: ["Built control remains old"] });
  await (supervisor as any).runPersistedAgent("repair", { ...incident, worktree_path: directory }, "Correction", uuid);
  const corrected = state.latestDeploymentRepairAgentRun(incident.id, "repair");
  if (corrected?.launch_state !== "completed" || corrected.requested_session_uuid !== uuid
    || corrected.session_uuid !== uuid || corrected.child_pid !== process.pid) throw new Error("Correction resume lost its identities.");
} else {
  incident = db.query(`SELECT i.* FROM deployment_repair_incidents i JOIN deployment_turn_reactions r ON r.run_id=i.run_id WHERE r.turn_id=?`).get(turnId) as any;
  if (!incident) throw new Error("Missing sandbox incident");
  if (action === "park") {
    for (let index = 0; index < 4; index++) {
      incident = state.claimDeploymentRepair({ incidentId: incident.id, pid: 990000 + index, bootId: "sandbox-dead", startTicks: String(index) }, () => false);
      if (incident.status === "parked") break;
    }
    if (incident.status !== "parked") throw new Error("Restart bound did not park.");
  }
}
const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as any;
await reconcileDeploymentWork({ client: new WebClient(config.bot_token), ownerInstanceId: "repair-sandbox-fixture",
  isOwnerAlive: () => true, shouldStop: () => false, services: {
    launchRun: async () => { throw new Error("Fixture must never launch deployment"); },
    launchRepair: async () => { throw new Error("Fixture must never launch root repair"); },
  } });
console.log(JSON.stringify({ incident: state.getDeploymentRepairIncident(incident.id),
  attempts: db.query("SELECT * FROM deployment_repair_agent_runs WHERE incident_id=? ORDER BY rowid").all(incident.id),
  notices: db.query("SELECT * FROM deployment_notices WHERE run_id=?").all(incident.run_id),
  reaction: state.getDeploymentTurnReaction(turnId),
  request_count: (db.query("SELECT COUNT(*) AS count FROM deployment_requests WHERE run_id=?").get(incident.run_id) as any).count }));
