import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
if(process.platform!=="linux"){console.log(JSON.stringify({fixture:"deployment-recovery-serving",status:"not-applicable",platform:process.platform}));process.exit(0);}
if(!process.env.CONCIERGE_PRIVATE_CODE_STATE)throw Error("Use the existing private-code entrance for this fixture.");

const scratch = mkdtempSync(join(tmpdir(), "wal9747-recovery-serving-"));
const runId = "f479e2e1-4a3a-41c7-a5d3-4b5cdd915011";
const liveRunId = "f479e2e1-4a3a-41c7-a5d3-4b5cdd915012";
const lkgRunId = "f479e2e1-4a3a-41c7-a5d3-4b5cdd915013";
const lkgDigest = "a".repeat(64);
const failedCommit = "b".repeat(40);
const restoredCommit = "c".repeat(40);
process.env.CONCIERGE_TEST_MODE="1";
process.env.CONCIERGE_TEST_AUTHORIZATION="responsive-system-b1eed622";
const socket = join(scratch, "request-owner.sock");
let server: Bun.Server | undefined;
let child: ReturnType<typeof spawn> | undefined;
let closeDatabase: () => void = () => {};
let closeAdmitted: (() => Promise<void>) | null = null;
let releaseHeldMaintenance:(()=>void)|null=null;
let heldMaintenance:Promise<void>|null=null;
let childStderr = "";
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

try {
  {
    process.env.CONCIERGE_STATE_DIR = scratch;
    const [{ db }, state, { dispatchRepairLedgerCommand }, identity] = await Promise.all([
      import("../src/state"), import("../src/deployment-state"), import("../src/deployment-repair-commands"),
      import("../src/runtime-identity"),
    ]);
    closeDatabase = () => db.close();
    const live = identity.currentProcessIdentity();
    const dead = { pid: 2_000_000_000, bootId: live.bootId, startTicks: "not-this-process" };
    const insertRun = db.query(`INSERT INTO deployment_runs
      (id,target,unit_name,status,runner_pid,runner_boot_id,runner_start_ticks,candidate_commit,
       candidate_artifact_digest,activation_state)
      VALUES(?,?,?,'releasing',?,?,?,?,?,'active')`);
    insertRun.run(runId, "recovery-dead", "recovery-dead.service", dead.pid, dead.bootId,
      dead.startTicks, failedCommit, lkgDigest);
    insertRun.run(liveRunId, "recovery-live", "recovery-live.service", live.pid, live.bootId,
      live.startTicks, failedCommit, "d".repeat(64));
    db.query(`INSERT INTO deployment_runs(id,target,unit_name,status) VALUES(?,? ,?,'succeeded')`)
      .run(lkgRunId, "lkg", "lkg.service");
    db.query(`INSERT INTO deployment_releases
      (artifact_digest,run_id,git_commit,source_tree_digest,runtime_digest,compatibility_digest,artifact_path,state)
      VALUES(?,?,?,?,?,?,?,'lkg')`)
      .run(lkgDigest, lkgRunId, restoredCommit, "e".repeat(64), "f".repeat(64), "1".repeat(64), join(scratch, "sealed-lkg"));
    for (const id of [runId, liveRunId]) {
      db.query(`INSERT INTO deployment_run_events(run_id,event,detail_json)
        VALUES(?,'release_activation_intended','{}')`).run(id);
    }

    const send = (operation: string, args: unknown[], extra: Record<string, unknown> = {}) => dispatchRepairLedgerCommand({ operation, args, ...extra });
    const snapshot = send("observeInterruptedDeploymentRecovery", []) as any;
    assert.deepEqual(snapshot.runs.map((run: any) => run.id), [runId],
      "a live foreign runner with matching boot/start identity must remain untouched");
    assert.equal(snapshot.lastKnownGood.artifact_path, join(scratch, "sealed-lkg"));

    const firstObservation = deferred();
    const { localOwnerRequestApiHandler } = await import("../src/routed-request-api");
    const handle = localOwnerRequestApiHandler(async () => new Response("not found", { status: 404 }), undefined, {} as any);
    const admission = await import("../src/ledger-admission");
    closeAdmitted = async () => { await admission.runLedgerSegment(() => db.close()); };
    admission.enableLedgerAdmission();
    let releaseMaintenance!: () => void;
    const maintenance = admission.maintainLedger(() => new Promise<void>(resolve => { releaseMaintenance = resolve; }));
    heldMaintenance=maintenance;
    await Bun.sleep(0);
    releaseHeldMaintenance=releaseMaintenance;
    let firstBegin = true;
    const operations: string[] = [];
    const acceptedCommandIds: string[] = [];
    server = Bun.serve({ unix: socket, fetch: async request => {
      if (request.method === "POST" && new URL(request.url).pathname === "/internal/deployment-repair") {
        const input = await request.clone().json() as { operation: string };
        operations.push(input.operation);
        if(input.operation==="beginDeploymentRepair")acceptedCommandIds.push(String((input as any).commandId));
        if (input.operation === "observeInterruptedDeploymentRecovery") {
          firstObservation.resolve();
        }
        const response = await handle(request);
        if (input.operation === "beginDeploymentRepair" && firstBegin) {
          firstBegin = false;
          // The owner commits, then the caller sees an unusable body. The client must retry
          // the same command identity and receive the original accepted failure event.
          return new Response("{", { headers: { "content-type": "application/json" } });
        }
        return response;
      }
      return handle(request);
    }});
    const ready = await fetch("http://localhost/supervisor/ping", { unix: socket } as RequestInit);
    assert.equal(ready.status, 200, "the exact private socket is listening before the CLI child starts");
    child = spawn(process.execPath, ["--preload", join(import.meta.dir,"deployment-recovery-owner-preload.ts"),
      join(import.meta.dir,"recover-deployment.ts")], {
      cwd: process.cwd(), env: { ...process.env, CONCIERGE_STATE_DIR: scratch },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runningChild=child;
    const stdout = new Promise<string>((resolve, reject) => {
      let text = ""; child.stdout!.setEncoding("utf8"); child.stdout!.on("data", part => { text += part; });
      child.once("error", reject); child.once("close", () => resolve(text));
    });
    const stderr = new Promise<string>(resolve => {
      childStderr = ""; runningChild.stderr!.setEncoding("utf8"); runningChild.stderr!.on("data", part => { childStderr += part; });
      runningChild.stderr!.on("end", () => resolve(childStderr));
    });
    await Promise.race([firstObservation.promise, Bun.sleep(5_000).then(() => {
      throw new Error(`Actual owner socket was not reached; child stderr: ${childStderr}`);
    })]);
    await Bun.sleep(0);
    assert.equal(admission.ledgerAdmissionSnapshot().phase, "maintenance");
    assert.ok(admission.ledgerAdmissionSnapshot().pending > 0, "the actual owner observation waits in the closed maintenance queue");
    const pingWhileHeld = await fetch("http://localhost/supervisor/ping", { unix: socket } as RequestInit);
    assert.equal(pingWhileHeld.status, 200, "the supervisor control reply remains live while business observation is queued");
    assert.equal((await pingWhileHeld.json() as { pid: number }).pid, process.pid);
    const openFiles = readdirSync(`/proc/${runningChild.pid}/fd`).map(fd => {
      try { return readlinkSync(`/proc/${runningChild.pid}/fd/${fd}`); } catch { return ""; }
    });
    assert.equal(openFiles.some(path => path.includes(join(scratch, "state.db"))), false,
      "the actual owner-selected CLI must use the private socket without opening its ledger");
    releaseMaintenance();
    await maintenance;
    releaseHeldMaintenance=null;heldMaintenance=null;
    const [code, childOutput, childError] = await Promise.all([
      new Promise<number>((resolve, reject) => { runningChild.once("error", reject); runningChild.once("close", code => resolve(code ?? 1)); }),
      stdout, stderr,
    ]);
    child=undefined;
    assert.equal(code, 0, childError || childOutput);
    assert.match(childOutput, /"run_id":"f479e2e1-4a3a-41c7-a5d3-4b5cdd915011"/);
    assert.equal(readFileSync(join(scratch, "restore.count"), "utf8"), "1",
      "the failed response body retries the durable command without repeating restore");
    assert.deepEqual(operations, ["observeInterruptedDeploymentRecovery", "beginDeploymentRepair", "beginDeploymentRepair"]);
    assert.equal(acceptedCommandIds.length,2);
    assert.match(acceptedCommandIds[0]!,/^[0-9a-f-]{36}$/i);
    assert.equal(acceptedCommandIds[1],acceptedCommandIds[0],"body retry reuses one accepted command ID");
    const segment = admission.runLedgerSegment;
    const acceptance = JSON.parse(childOutput.split("\n").find(line => line.includes('"incident_id"'))!);
    const incident = (await segment(() => state.getDeploymentRepairIncident(acceptance.incident_id)))!;
    assert.equal(incident.same_failure_count, 1);
    assert.equal(await segment(() => state.getDeploymentRepairIncidentForRun(liveRunId)), null);

    const eventCount = async (id:string) => segment(() => (db.query(`SELECT COUNT(*) AS count FROM deployment_run_events
      WHERE run_id=? AND event='repair_failure_accepted'`).get(id) as { count: number }).count);
    assert.equal(await eventCount(runId), 1);
    const initialIds=await segment(() => db.query(`SELECT json_extract(detail_json,'$.command_id') AS id FROM deployment_run_events
      WHERE run_id=? AND event='repair_failure_accepted' ORDER BY sequence`).all(runId) as {id:string}[]);
    assert.equal(initialIds.length,1);
    const beginInput = {
      runId, failedCommit, restoredCommit,
      failureFingerprint: (await import("node:crypto")).createHash("sha256")
        .update("deployment-runner-interrupted:releasing:active").digest("hex"),
      error: `Deployment runner disappeared in releasing after candidate activation active; immutable LKG ${restoredCommit} was restored before Concierge startup.`,
    };
    const laterCommandId="76c1b313-f866-4f1a-8935-95abde91dc90";
    const next = await segment(() => send("beginDeploymentRepair", [beginInput], {commandId:laterCommandId}) as any);
    assert.equal(next.id, incident.id);
    assert.equal((await segment(() => state.getDeploymentRepairIncident(next.id)))?.same_failure_count, 2);
    assert.equal(await eventCount(runId), 2, "a new accepted command ID records a distinct attempt");
    assert.notEqual(initialIds[0]!.id,laterCommandId);

    const legacyRunId = "f479e2e1-4a3a-41c7-a5d3-4b5cdd915014";
    await segment(() => insertRun.run(legacyRunId, "recovery-old", "recovery-old.service", dead.pid, dead.bootId,
      dead.startTicks, failedCommit, "9".repeat(64)));
    await segment(() => {
      db.query("UPDATE deployment_runs SET repair_state='restored' WHERE id=?").run(legacyRunId);
      db.query(`INSERT INTO deployment_run_events(run_id,event,detail_json)
        VALUES(?,'release_activation_intended','{}')`).run(legacyRunId);
      db.query(`INSERT INTO deployment_repair_incidents
        (id,run_id,status,failed_commit,restored_commit,failure_fingerprint,same_failure_count,base_commit,error)
        VALUES(?,?,'restored',?,?,?,1,?,?)`).run("8b36d885-ea8f-4b9b-918a-c160238ea8f4",legacyRunId,failedCommit,restoredCommit,"old",failedCommit,"legacy restored incident");
      db.query(`INSERT INTO deployment_run_events(run_id,event,detail_json)
        VALUES(?,'repair_restored',?)`).run(legacyRunId,JSON.stringify({incident_id:"8b36d885-ea8f-4b9b-918a-c160238ea8f4"}));
    });
    const oldBefore=await segment(() => state.getDeploymentRepairIncidentForRun(legacyRunId));
    const {repairLedgerOwnerCommand}=await import("../src/deployment-repair-client");
    const oldObservation=await repairLedgerOwnerCommand("observeInterruptedDeploymentRecovery",[]) as any;
    assert.equal(oldObservation.runs.some((run:any)=>run.id===legacyRunId),false,
      "the existing recovery predicate excludes a legacy restored incident without a command marker");
    assert.equal((await segment(() => state.getDeploymentRepairIncidentForRun(legacyRunId)))?.same_failure_count,oldBefore?.same_failure_count);

    const directRunId="f479e2e1-4a3a-41c7-a5d3-4b5cdd915016";
    await segment(() => insertRun.run(directRunId,"direct-core","direct-core.service",dead.pid,dead.bootId,dead.startTicks,failedCommit,"7".repeat(64)));
    const directInput={...beginInput,runId:directRunId};
    const directFirst=await segment(() => state.beginDeploymentRepair(directInput));
    const directSecond=await segment(() => state.beginDeploymentRepair(directInput));
    assert.equal(directFirst.id,directSecond.id);
    assert.equal((await segment(() => state.getDeploymentRepairIncident(directFirst.id)))?.same_failure_count,2,
      "direct core calls with identical arguments remain distinct attempts");

    await segment(() => db.query(`UPDATE deployment_runs SET status='succeeded' WHERE id IN (?,?,?,?)`)
      .run(runId, liveRunId, legacyRunId, directRunId));
    const legacyEnvironment = { ...process.env, CONCIERGE_STATE_DIR: scratch,
      CONCIERGE_REPO: scratch, CONCIERGE_RELEASE_OFFLINE: "1" };
    delete legacyEnvironment.CONCIERGE_TEST_MODE;
    delete legacyEnvironment.CONCIERGE_TEST_AUTHORIZATION;
    delete legacyEnvironment.NODE_ENV;
    const prestart = spawnSync(process.execPath, [join(import.meta.dir, "recover-deployment.ts")], {
      cwd: process.cwd(), env: legacyEnvironment, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(prestart.status, 0, prestart.stderr || prestart.stdout);
    assert.match(prestart.stdout, /"status":"clean"/);
    assert.equal(existsSync(join(scratch, "state.db")), true,
      "the foreground legacy entry reads only the selected disposable ledger and exits after native close");

    server.stop(true); server=undefined;

    console.log(JSON.stringify({ servingCli: true, actualOwnerApiRoute: true, databaseOpenedByCli: false,
      foreignLiveWriterExcluded: true, partialJsonReplyRetriedExactCommand: true, restoreAppliedOnce: true,
      nextCommandRecordedSeparately: true, directCoreCallsRemainDistinct: true,
      legacyRestoredIncidentExcludedWithoutMarker: true, constructorForbidden: true,
      prestartLegacyCliExited: true, ownerOperations: operations, incidentId: incident.id }));
  }
} finally {
  server?.stop(true);
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await new Promise(resolve=>child!.once("close",resolve));}
  releaseHeldMaintenance?.();
  if(heldMaintenance)await heldMaintenance.catch(()=>{});
    if(closeAdmitted) await closeAdmitted(); else closeDatabase();
    closeDatabase=()=>{};
  rmSync(scratch, { recursive: true, force: true });
}
