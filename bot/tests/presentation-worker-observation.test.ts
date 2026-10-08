import {test,expect} from 'bun:test';
import {writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {db} from '../src/state';
import {PresentationWorkerObservation} from '../src/presentation-worker-observation';

test('worker reports successful batch progress separately from failures and observation absence',()=>{
 let now=1000000,unavailable=false;
 const state={ready:0,source_head:20,generation:1,target:100};
 const lines:string[]=[];
 const observe=new PresentationWorkerObservation(()=>{if(unavailable)throw Error('private sentinel');return state;},line=>lines.push(line),()=>now);
 observe.emit();now+=10000;observe.advance();
 for(let i=0;i<3;i++){now+=10000;observe.failed();}
 expect(JSON.parse(lines.at(-1)!).consecutive_failures).toBe(3);
 expect(JSON.parse(lines.at(-1)!).last_progress_at_ms).toBe(1010000);
 now+=10000;state.ready=1;state.source_head=100;observe.succeeded();
 expect(JSON.parse(lines.at(-1)!).consecutive_failures).toBe(0);
 now+=10000;unavailable=true;observe.emit();
 expect(JSON.parse(lines.at(-1)!).available).toBe(false);
 expect(lines.join('\n')).not.toContain('private sentinel');
 if(process.env.PRESENTATION_MONITOR_FIXTURE)writeFileSync(process.env.PRESENTATION_MONITOR_FIXTURE,lines.join('\n')+'\n');
});

test('committed small checkpoints advance progress while idle passes do not',()=>{
 let now=1000000;
 const state={ready:1,source_head:20,generation:1,target:21};
 const rows:any[]=[];
 const observe=new PresentationWorkerObservation(()=>state,line=>rows.push(JSON.parse(line)),()=>now);
 observe.emit();expect(rows.at(-1).progress).toBe(0);
 // No batch yield: continuous small writes leave a pending delta on every sample.
 for(let i=0;i<15;i++){
   now+=10000;state.source_head++;state.target++;observe.succeeded();
   expect(rows.at(-1).last_progress_at_ms).toBe(now);
 }
 expect(rows.at(-1).progress).toBe(15);
 const lastProgress=now;
 now+=130000;observe.succeeded();
 expect(rows.at(-1).last_progress_at_ms).toBe(lastProgress);
 expect(rows.at(-1).progress).toBe(15);
 now+=10000;state.generation++;state.source_head=0;state.target=0;observe.succeeded();
 expect(rows.at(-1).progress).toBe(16);
 expect(rows.at(-1).last_progress_at_ms).toBe(now);
});

test('real worker emits numeric observation from its actual isolated metadata',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'presentation-observation-'));
 db.query('VACUUM INTO ?').run(join(directory,'state.db'));
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/presentation-message-worker.ts')],
   {env:{...process.env,CONCIERGE_STATE_DIR:directory},stdout:'pipe',stderr:'pipe'});
 let received='';const decoder=new TextDecoder();
 const output=(async()=>{for await(const bytes of child.stdout)received+=decoder.decode(bytes,{stream:true});})();
 const errors=new Response(child.stderr).text();
 try{
   const deadline=Date.now()+10000;
   while(!received.includes('"event":"presentation_worker_health"')&&Date.now()<deadline&&child.exitCode===null)await Bun.sleep(25);
 }finally{child.kill();await child.exited;}
 await output;
 const lines=received.trim().split('\n').filter(Boolean);
 const row=lines.map(line=>JSON.parse(line)).find(row=>row.event==='presentation_worker_health');
 expect(row).toBeDefined();expect(row.available).toBe(true);
 expect(row.worker_pid).toBe(child.pid);expect(row.consecutive_failures).toBe(0);
 expect(row.target_sequence).toBeGreaterThanOrEqual(row.applied_sequence);
 expect(await errors).not.toContain('presentation_message_worker_failed');
 if(process.env.PRESENTATION_REAL_WORKER_FIXTURE)writeFileSync(process.env.PRESENTATION_REAL_WORKER_FIXTURE,JSON.stringify(row)+'\n');
},15000);
