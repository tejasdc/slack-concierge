import {Database} from 'bun:sqlite';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION} from '../src/test-authorizations';

// A fixture-only process wrapper observes the real worker immediately after a commit.
// No production fault control or modified worker is used. Its parent owns and kills it.
if(process.env.CONCIERGE_TEST_AUTHORIZATION!==INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION
  ||process.env.CONCIERGE_TEST_MODE!=='1'||!(process.env.CONCIERGE_FIXTURE_INTERRUPT_ROOT||process.env.CONCIERGE_FIXTURE_INTERRUPT_UPGRADE))
  throw new Error('Projection interruption preload requires the isolated fixture.');
const stateDir=process.env.CONCIERGE_STATE_DIR!;
const interruptedRoot=process.env.CONCIERGE_FIXTURE_INTERRUPT_ROOT;
const upgradePhase=process.env.CONCIERGE_FIXTURE_INTERRUPT_UPGRADE;
const original=Database.prototype.transaction;
Database.prototype.transaction=function(body:any){
  const db=this,transaction=original.call(db,body);
  const wrap=(execute:any)=>(...args:any[])=>{
    const result=execute(...args);
    if(db.filename===join(stateDir,'presentation.db')
      &&db.query("SELECT 1 FROM sqlite_master WHERE name='presentation_messages'").get()){
      if(upgradePhase){
        const hasWork=db.query("SELECT 1 FROM sqlite_master WHERE name='presentation_inbox_lineage_work'").get();
        const work=hasWork?db.query(`SELECT * FROM presentation_inbox_lineage_work
          WHERE generation=(SELECT generation FROM presentation_message_meta)`).get() as any:null;
        // The fallback observes the old candidate at the same real post-commit boundary,
        // allowing the negative control to reject its missing durable continuation.
        const oldFirstPage=!hasWork&&upgradePhase==='messages'
          &&(db.query('SELECT COUNT(*) AS n FROM fixture_upgrade_visits').get() as {n:number}).n>=100;
        if(oldFirstPage||work?.phase===upgradePhase&&(upgradePhase==='drain'
          ||upgradePhase==='messages'&&work.pages>0||upgradePhase==='roots'&&work.root_pages>0)){
          writeFileSync(join(stateDir,`upgrade-${upgradePhase}-committed.json`),JSON.stringify(work??{durable:false}));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
        }
      }else{
      const state=db.query(`SELECT
        (SELECT root_input_id FROM presentation_messages WHERE message_id=?
          AND generation=(SELECT generation FROM presentation_message_meta)) AS parent_root,
        (SELECT COUNT(*) FROM presentation_messages WHERE root_input_id=?
          AND generation=(SELECT generation FROM presentation_message_meta)) AS remaining`)
        .get(interruptedRoot,interruptedRoot) as {parent_root:string;remaining:number};
      if(state.parent_root&&state.parent_root!==interruptedRoot&&state.remaining>0){
        writeFileSync(join(stateDir,'remap-committed.json'),JSON.stringify(state));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }
      }
    }
    return result;
  };
  const wrapped=wrap(transaction) as any;
  for(const mode of ['deferred','immediate','exclusive'] as const)wrapped[mode]=wrap(transaction[mode]);
  return wrapped;
} as typeof original;
