import {
  beginProjectCutover,
  completeProjectCutover,
  readProjectCutoverState,
  requireCanvasRefresh,
} from "../src/project-cutover-state";

const stateDir = process.env.CONCIERGE_STATE_DIR || "/root/.local/state/concierge";
const stateDbPath = process.env.CONCIERGE_STATE_DB || `${stateDir}/state.db`;
const captureStateDir = process.env.CONCIERGE_CAPTURE_STATE_DIR || "/var/lib/concierge-capture";
const captureStateDbPath = `${captureStateDir}/state.db`;
const workspaceRoot = process.env.CONCIERGE_WORKSPACE_ROOT || "/root/workspace";
const command = process.argv[2];

if (command === "begin") {
  console.log(JSON.stringify(beginProjectCutover({ stateDir, workspaceRoot, stateDbPath, captureStateDbPath })));
} else if (command === "canvas-required") {
  requireCanvasRefresh(stateDir);
  console.log(JSON.stringify(readProjectCutoverState(stateDir)));
} else if (command === "complete") {
  completeProjectCutover(stateDir);
  console.log(JSON.stringify({ status: "complete" }));
} else if (command === "show") {
  console.log(JSON.stringify(readProjectCutoverState(stateDir)));
} else {
  throw new Error("usage: project-scaffold-cutover-state.ts <begin|canvas-required|complete|show>");
}
