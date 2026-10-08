import { test, expect } from "bun:test";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { db } from "../src/state";
import { readClaudeHistory, readClaudeHistoryDetail } from "../src/provider-history";

test("indexed Claude pages preserve cursor order and merge owner messages after import", async () => {
  const uuid = "a1111111-1111-4111-8111-111111111111";
  const cwd = "/tmp/indexed-history-fixture";
  const config = join(process.env.CONCIERGE_STATE_DIR!,"claude-config");
  process.env.CLAUDE_CONFIG_DIR = config;
  const path = join(config,"projects","-tmp-indexed-history-fixture",`${uuid}.jsonl`);
  await mkdir(join(config,"projects","-tmp-indexed-history-fixture"),{recursive:true});
  const ids = ["a2222222-2222-4222-8222-222222222222","a3333333-3333-4333-8333-333333333333",
    "a4444444-4444-4444-8444-444444444444","a5555555-5555-4555-8555-555555555555"];
  const row = (id:string,parent:string|null,type:"user"|"assistant",content:string) => JSON.stringify({
    type,uuid:id,parentUuid:parent,sessionId:uuid,timestamp:"2026-10-08T00:00:00Z",
    message:{role:type,content,...(type==="assistant"?{model:"claude-opus-4-1"}:{})}
  })+"\n";
  await writeFile(path,row(ids[0]!,null,"user","first")+row(ids[1]!,ids[0]!,"assistant","second"));
  const sessionId = Number(db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,agent_session_uuid) VALUES(?,?,?,?)")
    .run("test-indexed-history",uuid,"claude-code",uuid).lastInsertRowid);
  const indexWorker=Bun.spawn([process.execPath,"run",join(import.meta.dir,"../src/presentation-message-worker.ts")],
    {stdout:"ignore",stderr:"ignore",env:{...process.env,CONCIERGE_STATE_DIR:process.env.CONCIERGE_STATE_DIR!}});
  try {
  let page = await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  expect(page.coverage?.code).toBe("history_indexing");
  for(let attempt=0;attempt<100 && page.coverage?.code==="history_indexing";attempt++) {
    await Bun.sleep(50);
    page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  }
  expect(page.coverage).toBeUndefined();
  expect(page.messages.map(message=>message.id)).toEqual(ids.slice(0,2));
  const retained = (id:string,content:string) => db.query(`INSERT INTO session_owner_events(event_id,session_id,kind,payload_json)
    VALUES(?,?,'message',?)`).run(`test:${id}:${content}`,sessionId,JSON.stringify({message:{id,role:"user",content,tool:null,phase:null}}));
  retained(ids[2]!,"third");
  await appendFile(path,row(ids[2]!,ids[1]!,"user","third"));
  page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  for(let attempt=0;attempt<100 && page.coverage?.code==="history_indexing";attempt++) {
    await Bun.sleep(50);
    page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  }
  expect(page.coverage).toBeUndefined();
  expect(page.messages.map(message=>message.id)).toEqual(ids.slice(1,3));
  expect(page.nextCursor).toBeTruthy();
  const earlier=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:page.nextCursor!,limit:2,ownerSessionId:sessionId});
  expect(earlier.messages.map(message=>message.id)).toEqual(ids.slice(0,1));
  retained(ids[2]!,"third updated");
  page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  for(let attempt=0;attempt<100 && page.coverage?.code==="history_indexing";attempt++) {
    await Bun.sleep(50);
    page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  }
  expect(page.messages.filter(message=>message.id===ids[2])).toHaveLength(1);
  expect(page.messages.at(-1)?.content).toBe("third updated");
  const cachePath=join(process.env.CONCIERGE_STATE_DIR!,"provider-history-cache",`${uuid}.sqlite`);
  const beforeDb=new Database(cachePath,{readonly:true});
  const generation=(beforeDb.query("SELECT generation FROM meta").get() as {generation:string}).generation;
  beforeDb.close();
  for(let index=0;index<250;index++)retained(ids[2]!,`version ${index}`);
  page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  for(let attempt=0;attempt<100 && page.coverage?.code==="history_indexing";attempt++) {
    await Bun.sleep(50);
    page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  }
  expect(page.messages.at(-1)?.content).toBe("version 249");
  const afterDb=new Database(cachePath,{readonly:true});
  expect((afterDb.query("SELECT generation FROM meta").get() as {generation:string}).generation).toBe(generation);
  afterDb.close();
  db.transaction(()=>{for(let index=0;index<300;index++)retained(`live-${String(index).padStart(4,"0")}`,`live ${index}`);})();
  let wide=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:50,ownerSessionId:sessionId});
  for(let attempt=0;attempt<100 && wide.coverage?.code==="history_indexing";attempt++){
    await Bun.sleep(50);
    wide=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:50,ownerSessionId:sessionId});
  }
  const seen=new Set<string>();
  while(true){
    for(const message of wide.messages)if(message.id.startsWith("live-"))seen.add(message.id);
    if(!wide.nextCursor)break;
    wide=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:wide.nextCursor,limit:50,ownerSessionId:sessionId});
  }
  expect(seen.size).toBe(300);
  await appendFile(path,row(ids[3]!,ids[2]!,"assistant","external fourth"));
  page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  expect(page.coverage?.code).toBe("history_indexing");
  expect(page.messages.at(-1)?.content).toBe("live 299");
  db.query(`INSERT INTO session_owner_events(event_id,session_id,kind,payload_json) VALUES(?,?,'message',?)`).run(
    "test:tool-live",sessionId,JSON.stringify({message:{id:"tool-call-1",role:"tool",content:'{"type":"tool_use","input":{}}',tool:"example",phase:"requested"}}));
  page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  for(let attempt=0;attempt<100 && !page.messages.some(message=>message.id==="tool-call-1");attempt++) {
    await Bun.sleep(50);
    page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2,ownerSessionId:sessionId});
  }
  const tool=page.messages.find(message=>message.id==="tool-call-1");
  expect(tool?.detailKey).toBeTruthy();
  expect((await readClaudeHistoryDetail({sessionUuid:uuid,cwd,detailKey:tool!.detailKey!,ownerSessionId:sessionId})).content)
    .toBe('{"type":"tool_use","input":{}}');
  } finally {indexWorker.kill();await indexWorker.exited;}
},20_000);

test("a failed canonical import reports retryable incomplete coverage",async()=>{
  const uuid="b1111111-1111-4111-8111-111111111111";
  const cwd="/tmp/history-import-failure";
  const config=join(process.env.CONCIERGE_STATE_DIR!,"claude-config");
  process.env.CLAUDE_CONFIG_DIR=config;
  await mkdir(join(config,"projects","-tmp-history-import-failure",`${uuid}.jsonl`),{recursive:true});
  let page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2});
  expect(page.coverage?.code).toBe("history_indexing");
  for(let attempt=0;attempt<100 && page.coverage?.code==="history_indexing";attempt++){
    await Bun.sleep(25);
    page=await readClaudeHistory({sessionUuid:uuid,cwd,cursor:null,limit:2});
  }
  expect(page.coverage?.code).toBe("history_import_failed");
  expect(page.coverage?.retryAfterMs).toBeGreaterThan(0);
  expect(page.messages).toEqual([]);
},10_000);
