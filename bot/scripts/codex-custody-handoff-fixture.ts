import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,truncateSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from "../src/test-authorizations";
const scratch=mkdtempSync(join(tmpdir(),"codex-custody-handoff-"));
process.env.CONCIERGE_STATE_DIR=scratch;process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,"capture");
process.env.CONCIERGE_TEST_MODE="1";process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const workspace=join(scratch,"workspace");mkdirSync(workspace);spawnSync("git",["init",workspace],{stdio:"ignore"});spawnSync("git",["-C",workspace,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","fixture"],{stdio:"ignore"});
const codexHome=join(scratch,"codex");const rolloutDir=join(codexHome,"sessions","2026","11","14");mkdirSync(rolloutDir,{recursive:true});process.env.CODEX_HOME=codexHome;
const keyFile=join(scratch,"lab.key");await Bun.write(keyFile,"fixture-key");
let labUnavailable=false,labReadDuringCommit=false;const lab=Bun.serve({port:0,fetch:()=>{if(labReadDuringCommit)authorityChangedDuringInventory=true;return labUnavailable?new Response("unavailable",{status:503}):Response.json({threads:[]});}});
let authorityChangedDuringInventory=false;
process.env.THINKERING_AGENT_TEST_KEY_FILE=keyFile;process.env.THINKERING_ORIGIN_URL=`http://127.0.0.1:${lab.port}`;
const {db}=await import("../src/state");
const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,updateSessionMetadata}=await import("../src/session-inputs");
const {stageRecoveryHandoff,commitRecoveryHandoff,proposeHandoff,withdrawHandoff}=await import("../src/session-handoff");
const predecessor=createNativeSession("codex",{title:"Astra owner",summary:undefined,purpose:"develop",origin:"native",cwd:workspace,model:"gpt-6-astra",reasoningEffort:"medium"});
db.query("UPDATE sessions SET agent_session_uuid=? WHERE id=?").run("fixture-native-thread",predecessor.id);const rollout=join(rolloutDir,"rollout-fixture-fixture-native-thread.jsonl");writeFileSync(rollout,workspace);truncateSync(rollout,64*1024*1024+1);
const preservedSource=join(scratch,"native-thread-source.jsonl");writeFileSync(preservedSource,"native conversation source");
const actor=retainSessionInput({id:"fixture-actor",sessionId:predecessor.id,scope:"fixture",actionId:"actor",kind:"input",origin:"agent",payload:{text:"recover"}}).input;enqueueSessionInput(actor.id);
const actorTurn=Number(db.query("SELECT turn_id FROM session_inputs WHERE id=?").get(actor.id).turn_id);
db.query("UPDATE turns SET status='done' WHERE id=?").run(actorTurn);
const reminder=retainSessionInput({id:"report-back:fixture-request",sessionId:predecessor.id,scope:"fixture",actionId:"reminder",kind:"request",origin:"service",payload:{text:"exact reminder"},requestId:"fixture-request"}).input;enqueueSessionInput(reminder.id);
const originalTurn=Number(db.query("SELECT turn_id FROM session_inputs WHERE id=?").get(reminder.id).turn_id);
db.query("UPDATE turns SET status='done',dispatch_attempt=1,native_run_id=?,provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP,provider_turn_id='native-empty',provider_input_acknowledged_at=NULL WHERE id=?").run(nativeRunId(originalTurn),originalTurn);
db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome) VALUES('fixture-request','fixture','message',?,?,?,?,?,'fixture','root','{"requestedEffect":"work"}','hash',0,0,?,?,'admitted',NULL)`).run(actorTurn,predecessor.id,'root','request-action',predecessor.id,actor.id,reminder.id);
const owed=retainSessionInput({id:"owed-input",sessionId:predecessor.id,scope:"request",actionId:"owed",kind:"request",origin:"agent",payload:{text:"owed"}}).input;
db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome) VALUES('owed-request','fixture','owed-message',?,?,?,?,?,'fixture','root','{"requestedEffect":"work"}','hash',0,0,?,?,'admitted',NULL)`).run(actorTurn,predecessor.id,'root','owed-action',predecessor.id,actor.id,owed.id);
const staged=await stageRecoveryHandoff({actorSession:predecessor.id,inputId:actor.id,runId:nativeRunId(actorTurn),predecessorId:predecessor.id,actionId:"recovery",reason:"fixture",selectedInputId:reminder.id,preservedSourcePath:preservedSource});
assert.equal(staged.inventory.omissions.length,0,"oversized transcript is a disposition rather than unresolved custody");
assert.equal(staged.inventory.dispositions?.some(value=>value.source==="transcript"&&value.preservedSourcePath===preservedSource),true,"source path and namespace remain explicit with non-exhaustive discovery");
const successorId=Number(staged.successor.split(":")[1]);
assert.equal((await import("../src/session-inputs")).sessionMetadata((await import("../src/state")).getSessionById(successorId)!).suspended,true);
assert.equal(db.query("SELECT COUNT(*) n FROM session_inputs WHERE session_id=?").get(successorId).n,0,"passive staging created no brief/input");
const placement=retainSessionInput({id:"placement",sessionId:successorId,scope:`custody:${reminder.id}`,actionId:"placement",kind:"input",origin:"service",payload:{text:"exact reminder"}}).input;
const turnId=Number(db.query(`INSERT INTO turns(session_id,user_text,status,turn_kind,accepted_input_id,provider_model,reasoning_effort) VALUES(?,'exact reminder','queued','native',?,'gpt-6-astra','medium') RETURNING id`).get(successorId,placement.id).id);
db.query("UPDATE session_inputs SET turn_id=? WHERE id=?").run(turnId,placement.id);
db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json) VALUES(?,?,?,?,?,?,? ,?,?,'staged','{}',?)`).run(reminder.id,predecessor.id,successorId,staged.handoffId,placement.id,turnId,"fixture-request",actor.id,nativeRunId(actorTurn),JSON.stringify({path:preservedSource}));
assert.throws(()=>withdrawHandoff({actorSession:predecessor.id,handoffId:staged.handoffId}),/retained native cutoff/,
  "ordinary proposal withdrawal cannot strand an already-reserved native recovery cutoff");
assert.equal(db.query("SELECT state FROM session_handoffs WHERE id=?").get(staged.handoffId).state,"proposed");
const committed=await commitRecoveryHandoff({actorSession:predecessor.id,inputId:actor.id,runId:nativeRunId(actorTurn),handoffId:staged.handoffId,digest:staged.digest,placementInputId:placement.id,placementTurnId:turnId,validateAuthority:()=>{}});
assert.equal(committed.accepted,true);assert.equal(db.query("SELECT state FROM codex_custody_successors WHERE canonical_input_id=?").get(reminder.id).state,"custody");
assert.equal(db.query("SELECT status FROM sessions WHERE id=?").get(predecessor.id).status,"idle");
assert.equal((db.query("SELECT target_session_id,target_input_id,target_turn_id FROM session_communication_requests WHERE request_id='owed-request'").get() as any).target_input_id,placement.id);
assert.equal((db.query("SELECT agent_session_uuid FROM sessions WHERE id=?").get(successorId) as any).agent_session_uuid,null,"commit precedes native construction");
const second=createNativeSession("codex",{title:"conflicting predecessor",summary:undefined,purpose:"develop",origin:"native",cwd:workspace,model:"gpt-6-astra",reasoningEffort:"medium"});
const secondActor=retainSessionInput({id:"second-actor",sessionId:second.id,scope:"fixture-second",actionId:"actor",kind:"input",origin:"agent",payload:{text:"recover"}}).input;enqueueSessionInput(secondActor.id);
db.query("UPDATE sessions SET agent_session_uuid=? WHERE id=?").run("second-native-thread",second.id);writeFileSync(join(rolloutDir,"rollout-fixture-second-native-thread.jsonl"),workspace);
const secondTurn=Number(db.query("SELECT turn_id FROM session_inputs WHERE id=?").get(secondActor.id).turn_id);
db.query("UPDATE turns SET status='done' WHERE id=?").run(secondTurn);
const secondReminder=retainSessionInput({id:"second-reminder",sessionId:second.id,scope:"fixture-second",actionId:"reminder",kind:"request",origin:"service",payload:{text:"exact"},requestId:"second-request"}).input;
const secondSource=join(scratch,"second-native-source.jsonl");writeFileSync(secondSource,"second native source");
labUnavailable=true;await assert.rejects(()=>stageRecoveryHandoff({actorSession:second.id,inputId:secondActor.id,runId:nativeRunId(secondTurn),predecessorId:second.id,actionId:"lab-refusal",reason:"fixture",selectedInputId:secondReminder.id,preservedSourcePath:secondSource}),/Lab inventory unavailable/);labUnavailable=false;
await assert.rejects(()=>stageRecoveryHandoff({actorSession:second.id,inputId:secondActor.id,runId:nativeRunId(secondTurn),predecessorId:second.id,actionId:"source-refusal",reason:"fixture",selectedInputId:secondReminder.id,preservedSourcePath:join(scratch,"missing-source.jsonl")}),/ENOENT/);
updateSessionMetadata(second.id,{additionalDirs:[join(scratch,"missing-resource")]});
await assert.rejects(()=>stageRecoveryHandoff({actorSession:second.id,inputId:secondActor.id,runId:nativeRunId(secondTurn),predecessorId:second.id,actionId:"resource-refusal",reason:"fixture",selectedInputId:secondReminder.id,preservedSourcePath:secondSource}),/ENOENT/);
updateSessionMetadata(second.id,{additionalDirs:[]});
const stage2=await stageRecoveryHandoff({actorSession:second.id,inputId:secondActor.id,runId:nativeRunId(secondTurn),predecessorId:second.id,actionId:"recovery2",reason:"fixture",selectedInputId:secondReminder.id,preservedSourcePath:secondSource});
const id2=Number(stage2.successor.split(":")[1]);const p2=retainSessionInput({id:"placement2",sessionId:id2,scope:`custody:second-reminder`,actionId:"placement",kind:"input",origin:"service",payload:{text:"exact"}}).input;
const t2=Number(db.query(`INSERT INTO turns(session_id,user_text,status,turn_kind,accepted_input_id) VALUES(?,'exact','queued','native',?) RETURNING id`).get(id2,p2.id).id);db.query("UPDATE session_inputs SET turn_id=? WHERE id=?").run(t2,p2.id);
db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json) VALUES(?,?,?,?,?,?,? ,?,?,'staged','{}',?)`).run(secondReminder.id,second.id,id2,stage2.handoffId,p2.id,t2,"second-request",secondActor.id,nativeRunId(secondTurn),JSON.stringify({path:secondSource}));
db.query("UPDATE turns SET status='running',owner_instance_id='fixture' WHERE id=?").run(secondTurn);
await assert.rejects(()=>commitRecoveryHandoff({actorSession:second.id,inputId:secondActor.id,runId:nativeRunId(secondTurn),handoffId:stage2.handoffId,digest:stage2.digest,placementInputId:p2.id,placementTurnId:t2,validateAuthority:()=>{}}),/Predecessor exclusion/);
db.query("UPDATE turns SET status='done',owner_instance_id=NULL WHERE id=?").run(secondTurn);
labReadDuringCommit=true;
await assert.rejects(()=>commitRecoveryHandoff({actorSession:second.id,inputId:secondActor.id,runId:nativeRunId(secondTurn),handoffId:stage2.handoffId,
  digest:stage2.digest,placementInputId:p2.id,placementTurnId:t2,validateAuthority:()=>{
    assert.equal(authorityChangedDuringInventory,true,"the real asynchronous Lab inventory completed before the immediate transfer validator");
    throw new Error("fixture source authority changed during inventory");
  }}),/authority changed during inventory/);
labReadDuringCommit=false;
assert.equal((db.query("SELECT state FROM session_handoffs WHERE id=?").get(stage2.handoffId) as any).state,"proposed",
  "failed immediate authority revalidation leaves the handoff unaccepted");
assert.equal((db.query("SELECT state FROM codex_custody_successors WHERE canonical_input_id=?").get(secondReminder.id) as any).state,"staged",
  "failed immediate authority revalidation leaves canonical custody staged");
assert.equal((db.query("SELECT status,owner_instance_id FROM turns WHERE id=?").get(t2) as any).status,"queued",
  "failed authority validation leaves the successor placement unstarted");
assert.equal((db.query("SELECT agent_session_uuid FROM sessions WHERE id=?").get(id2) as any).agent_session_uuid,null,
  "no native construction identity is created after the transfer authority refusal");

const stale=await commitRecoveryHandoff({actorSession:second.id,inputId:secondActor.id,runId:nativeRunId(secondTurn),handoffId:stage2.handoffId,digest:"stale",placementInputId:p2.id,placementTurnId:t2,validateAuthority:()=>{}});assert.equal(stale.accepted,false);
const collision=createNativeSession("codex",{title:"ordinary handoff collision",purpose:"develop",origin:"native",cwd:workspace,model:"gpt-6-astra",reasoningEffort:"medium"});
db.query("UPDATE sessions SET agent_session_uuid=? WHERE id=?").run("collision-native-thread",collision.id);
writeFileSync(join(rolloutDir,"rollout-fixture-collision-native-thread.jsonl"),workspace);
const collisionSource=join(scratch,"collision-native-source.jsonl");writeFileSync(collisionSource,"collision source");
const collisionActor=retainSessionInput({id:"collision-actor",sessionId:collision.id,scope:"collision",actionId:"source",kind:"input",origin:"human",payload:{text:"prepare ordinary handoff"}}).input;
enqueueSessionInput(collisionActor.id);const collisionTurn=Number(db.query("SELECT turn_id FROM session_inputs WHERE id=?").get(collisionActor.id).turn_id);
db.query("UPDATE turns SET status='done' WHERE id=?").run(collisionTurn);
const collisionReminder=retainSessionInput({id:"collision-reminder",sessionId:collision.id,scope:"collision",actionId:"reminder",kind:"request",origin:"service",requestId:"collision-request",payload:{text:"exact recovery reminder"}}).input;
const ordinary=await proposeHandoff({actorSession:collision.id,inputId:collisionActor.id,runId:nativeRunId(collisionTurn),predecessorId:collision.id,
  provider:"codex",reason:"ordinary user handoff",actionId:"shared-action"});
const ordinarySuccessor=Number(ordinary.successor.split(":")[1]);
await assert.rejects(()=>stageRecoveryHandoff({actorSession:collision.id,inputId:collisionActor.id,runId:nativeRunId(collisionTurn),predecessorId:collision.id,
  actionId:"shared-action",reason:"recovery",selectedInputId:collisionReminder.id,preservedSourcePath:collisionSource}),/handoff kind/);
assert.equal((db.query("SELECT handoff_kind,canonical_input_id FROM session_handoffs WHERE id=?").get(ordinary.handoffId) as any).handoff_kind,"ordinary");
assert.equal((db.query("SELECT COUNT(*) AS n FROM session_inputs WHERE session_id=?").get(ordinarySuccessor) as any).n,1,
  "ordinary bootstrap remains ordinary and cannot be mistaken for passive recovery staging");
assert.equal((db.query("SELECT COUNT(*) AS n FROM codex_custody_successors WHERE predecessor_session_id=?").get(collision.id) as any).n,0);
console.log("custody handoff fixture passed: passive staging, duty transfer, predecessor exclusion, stale inventory refusal, ordinary/recovery identity collision refusal");lab.stop();db.close();rmSync(scratch,{recursive:true,force:true});
