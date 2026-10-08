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

test('real worker emits numeric observation from its actual isolated metadata',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'presentation-observation-'));
 db.query('VACUUM INTO ?').run(join(directory,'state.db'));
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/presentation-message-worker.ts')],
   {env:{...process.env,CONCIERGE_STATE_DIR:directory},stdout:'pipe',stderr:'pipe'});
 const output=new Response(child.stdout).text();const errors=new Response(child.stderr).text();
 try{await Bun.sleep(1000);}finally{child.kill();await child.exited;}
 const lines=(await output).trim().split('\n').filter(Boolean);
 const row=lines.map(line=>JSON.parse(line)).find(row=>row.event==='presentation_worker_health');
 expect(row).toBeDefined();expect(row.available).toBe(true);
 expect(row.worker_pid).toBe(child.pid);expect(row.consecutive_failures).toBe(0);
 expect(row.target_sequence).toBeGreaterThanOrEqual(row.applied_sequence);
 expect(await errors).not.toContain('presentation_message_worker_failed');
 if(process.env.PRESENTATION_REAL_WORKER_FIXTURE)writeFileSync(process.env.PRESENTATION_REAL_WORKER_FIXTURE,JSON.stringify(row)+'\n');
});
