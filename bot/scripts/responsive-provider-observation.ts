import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';

/** The external process is synthetic. Input serialization, echo ownership checks and
 * acknowledgement callback are the shipping provider adapter. Never invoke a real CLI. */
export async function observeSyntheticProvider(prompt:string){
 if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='responsive-system-b1eed622'||process.env.CONCIERGE_TEST_MODE!=='1')throw new Error('Isolated acceptance only');
 const {runClaudeCodeTurn,SubprocessClaudeCodeTransport}=await import('../src/claude-code');
 const directory=await mkdtemp(join(process.env.CONCIERGE_STATE_DIR!,'provider-observation-'));
 const executable=join(directory,'provider'),record=join(directory,'picked-up.json');
 await writeFile(executable,`#!${process.execPath}
import {writeFileSync} from 'node:fs';
let pending='';
process.stdin.on('data',async chunk=>{pending+=chunk;const end=pending.indexOf('\\n');if(end<0)return;
 const input=JSON.parse(pending.slice(0,end));
 process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'synthetic-observation'})+'\\n');
 process.stdout.write(JSON.stringify({...input,message:{role:'user',content:[{type:'text',text:'Unrelated echo must never acknowledge the retained input'}]},session_id:'synthetic-observation'})+'\\n');
 await Bun.sleep(25);
 writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,input,at:Date.now()}));
 process.stdout.write(JSON.stringify({...input,session_id:'synthetic-observation'})+'\\n');
 process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'synthetic-observation',is_error:false,result:'Synthetic completion'})+'\\n');
 process.exit(0);
});
`,{mode:0o700});
 let observedAt:number|null=null,acknowledgements=0;
 const startedAt=Date.now();
 try{
  await runClaudeCodeTurn({prompt,cwd:directory,additionalDirs:[],sessionUUID:null,
   environment:{CLAUDE_CONFIG_DIR:join(directory,'no-real-credentials')},
   transport:new SubprocessClaudeCodeTransport(executable,{inactivityMs:5000,shutdownGraceMs:100}),
   onInputAcknowledged:()=>{acknowledgements++;observedAt=Date.now();}});
  const picked=JSON.parse(await readFile(record,'utf8'));
  assert.deepEqual(picked.input.message.content,[{type:'text',text:prompt}]);assert.equal(acknowledgements,1);assert.ok(observedAt!==null&&observedAt>=picked.at);
  return {provider:'synthetic separate process',providerPid:picked.pid,transport:'SubprocessClaudeCodeTransport',
   observation:'runClaudeCodeTurn onInputAcknowledged from exact provider echo',acknowledgements,
   exactText:true,unrelatedEchoRejected:true,pickupMs:picked.at-startedAt,observedMs:observedAt-startedAt};
 }finally{await rm(directory,{recursive:true,force:true});}
}
