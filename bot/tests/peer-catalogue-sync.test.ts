import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PeerCatalogueSync,initializePeerCatalogueSchema} from '../src/peer-catalogue-sync';
import {PreparedSessionCards,readPreparedSessionWindow,readPreparedSessionChanges,type SessionCard} from '../src/prepared-session-cards';

function fixture(count=85){
 const db=new Database(':memory:'),prepared=new Database(':memory:'),source=new Database(':memory:');
 db.exec(`CREATE TABLE session_peer_catalogue(peer TEXT,remote_session_id TEXT,address TEXT,runtime_thread_id TEXT,
  view_json TEXT,updated_at_ms INTEGER,PRIMARY KEY(peer,remote_session_id))`);
 initializePeerCatalogueSchema(db);
 new PreparedSessionCards(source,prepared,()=>{throw new Error('No canonical reads during refresh');});
 prepared.exec('UPDATE presentation_session_meta SET generation=1,source_head=10,ready=1');
 const card=(id:number,space='everyday',title=`Session ${id}`)=>({id:`concierge:${id}`,address:`session:YWJj${id}`,
  runtimeThreadId:`thread-${id}`,space,title,project:'/root/workspace/thinkering',projectName:'thinkering',
  projectTruncated:false,projectNameTruncated:false,revision:10} as SessionCard);
 const put=(value:SessionCard,generation=1)=>prepared.query(`INSERT OR REPLACE INTO presentation_session_cards
  VALUES(?,?,?,?,?,?,?)`).run(generation,Number(value.id.slice(10)),Number(value.id.slice(10)),value.space,0,JSON.stringify(value),value.revision??0);
 for(let id=1;id<=count;id++)put(card(id));
 put(card(1000,'lab'));
 const paths:string[]=[];
 const request=async(path:string)=>{
  paths.push(path);const url=new URL(path,'https://fixture.invalid'),space=url.searchParams.get('space') as 'everyday'|'lab';
  const head=(prepared.query('SELECT source_head FROM presentation_session_meta').get() as any).source_head;
  if(url.pathname.endsWith('/window'))return readPreparedSessionWindow(prepared,{space,cursor:url.searchParams.get('cursor'),limit:40,canonicalHead:head});
  expect(url.pathname.endsWith('/changes')).toBe(true);
  return readPreparedSessionChanges(prepared,url.searchParams.get('cursor')!,space,head,40);
 };
 const size=()=>Number((db.query('SELECT COUNT(*) AS n FROM session_peer_catalogue').get() as any).n);
 const view=(id:number)=>{const row=db.query('SELECT view_json FROM session_peer_catalogue WHERE remote_session_id=?').get(`concierge:${id}`) as any;return row?JSON.parse(row.view_json):null;};
 let sequence=10;
 const change=(before:SessionCard,after:SessionCard|null)=>{
  const revision=++sequence;if(after){after={...after,revision};put(after);}else prepared.query('DELETE FROM presentation_session_cards WHERE session_id=?').run(Number(before.id.slice(10)));
  prepared.query(`INSERT INTO presentation_session_changes(generation,session_id,before_json,after_json,before_space,after_space,before_revision,source_sequence)
   VALUES(1,?,?,?,?,?,?,?)`).run(Number(before.id.slice(10)),JSON.stringify(before),after?JSON.stringify(after):null,before.space,after?.space??null,before.revision??0,revision);
  prepared.query('UPDATE presentation_session_meta SET source_head=?').run(revision);return after;
 };
 const settle=async(sync:PeerCatalogueSync)=>{for(let i=0;i<30;i++){if(!(await sync.refresh('mac',request)).more)return;}throw new Error('No bounded completion');};
 return {db,prepared,card,put,paths,request,size,view,change,settle};
}

test('bounded pages resume their durable checkpoint and subsequent reads are delta only',async()=>{
 const f=fixture(),sync=new PeerCatalogueSync(f.db,()=>100);
 await sync.refresh('mac',f.request);expect(f.size()).toBe(41);expect(sync.status('mac').complete).toBe(false);
 const restarted=new PeerCatalogueSync(f.db,()=>101);await f.settle(restarted);
 expect(f.size()).toBe(86);expect(restarted.status('mac').complete).toBe(true);
 expect(f.view(1).id).toBe('mac:1');expect(f.view(1).address).toBe('mac/session:YWJj1');
 f.paths.length=0;await restarted.refresh('mac',f.request);
 expect(f.paths.length).toBe(2);expect(f.paths.every(path=>path.includes('/changes?'))).toBe(true);
});

test('offline failure retains prior page and never advertises complete coverage',async()=>{
 const f=fixture(),sync=new PeerCatalogueSync(f.db);await sync.refresh('mac',f.request);
 await expect(sync.refresh('mac',async()=>{throw new Error('offline');})).rejects.toThrow('offline');
 expect(f.size()).toBe(41);expect(sync.status('mac').complete).toBe(false);
 await f.settle(new PeerCatalogueSync(f.db));expect(f.size()).toBe(86);
});

test('deltas update, move and delete exact identities with retained tombstones',async()=>{
 const f=fixture(2),sync=new PeerCatalogueSync(f.db);await f.settle(sync);
 const moved=f.change(f.card(1),f.card(1,'lab','Moved'))!;
 f.change(f.card(2),null);await f.settle(sync);
 expect(f.view(1).title).toBe('Moved');expect(f.view(1).space).toBe('lab');expect(f.view(2)).toBeNull();
 expect(f.db.query('SELECT revision FROM session_peer_catalogue_tombstones WHERE remote_session_id=?').get('concierge:2')).not.toBeNull();
 f.change(moved,null);await f.settle(sync);expect(f.view(1)).toBeNull();
});

test('reset preserves offline cache until replacement snapshot and delta finish, then prunes in pages',async()=>{
 const f=fixture(),sync=new PeerCatalogueSync(f.db);await f.settle(sync);
 f.prepared.exec('UPDATE presentation_session_meta SET generation=2,source_head=20');f.put({...f.card(1),revision:0},2);
 await sync.refresh('mac',f.request);expect(f.size()).toBe(86);expect(sync.status('mac').complete).toBe(false);
 await sync.refresh('mac',f.request);expect(f.size()).toBe(86);
 await f.settle(sync);expect(f.size()).toBe(1);expect(sync.status('mac').complete).toBe(true);
});

test('aborted response and stale concurrent response cannot commit cache or cursor',async()=>{
 const f=fixture(1),sync=new PeerCatalogueSync(f.db),controller=new AbortController();
 let release!:(value:any)=>void;
 const waiting=sync.refresh('mac',()=>new Promise(resolve=>{release=resolve;}),controller.signal);
 controller.abort();release(await f.request('/sessions/v1/presentation/sessions/window?space=everyday'));
 await waiting;expect(f.size()).toBe(0);
 let oldRelease!:(value:any)=>void;const oldPage=await f.request('/sessions/v1/presentation/sessions/window?space=everyday');
 const stale=sync.refresh('mac',path=>path.includes('space=everyday')?new Promise(resolve=>{oldRelease=resolve;}):f.request(path));
 f.put({...f.card(1,'everyday','Current'),revision:20});f.prepared.exec('UPDATE presentation_session_meta SET source_head=20');
 await new PeerCatalogueSync(f.db).refresh('mac',f.request);oldRelease(oldPage);await stale;
 expect(f.view(1).title).toBe('Current');
});

test('invalid oversized page rolls back its whole cache page and preserves checkpoint',async()=>{
 const f=fixture(1),sync=new PeerCatalogueSync(f.db);
 await expect(sync.refresh('mac',async()=>({cards:[f.card(1),{...f.card(2),title:'x'.repeat(9000)}],nextCursor:null,
  asOf:'cursor',coverage:{complete:true,appliedSequence:10}}))).rejects.toThrow('TOO_LARGE');
 expect(f.size()).toBe(0);expect(sync.status('mac').complete).toBe(false);
 await f.settle(sync);expect(f.size()).toBe(2);
});

test('late old-space snapshot cannot resurrect a deletion already observed in the other space',async()=>{
 const f=fixture(1),sync=new PeerCatalogueSync(f.db);await f.settle(sync);
 // Force only the everyday side to rebuild while lab already observed a newer deletion.
 f.db.query("UPDATE session_peer_catalogue_sync SET phase='window',cursor=NULL,baseline=NULL,ready=0 WHERE space='everyday'").run();
 f.db.query('DELETE FROM session_peer_catalogue WHERE remote_session_id=?').run('concierge:1');
 f.db.query('INSERT INTO session_peer_catalogue_tombstones VALUES(?,?,?,?)').run('mac','concierge:1',1,20);
 await sync.refresh('mac',f.request);expect(f.view(1)).toBeNull();
});

test('long project paths preserve exact registered basename independently of display preview',()=>{
 const source=new Database(':memory:'),prepared=new Database(':memory:');
 source.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,provider_id TEXT,status TEXT,native_metadata_json TEXT,
  agent_session_uuid TEXT,slack_channel_id TEXT,slack_thread_ts TEXT,created_at TEXT,last_turn_at TEXT);
  CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,started_at TEXT,provider_turn_id TEXT,
  saved_kind TEXT,dispatch_failure_class TEXT,dispatch_next_attempt_ms INTEGER);
  INSERT INTO sessions(id,provider_id,status,native_metadata_json,created_at) VALUES(1,'claude-code','idle','{}','2026-10-08T00:00:00Z')`);
 let project='/'+('nested/'.repeat(110))+'registered-project';
 const writer=new PreparedSessionCards(source,prepared,()=>({title:'Session',summary:'Summary',project}));
 writer.beginRebuild(1);writer.rebuildPage(1,0);writer.activate(1,0);
 const card=readPreparedSessionWindow(prepared,{space:'everyday',canonicalHead:0}).cards[0]!;
 expect(card.projectTruncated).toBe(true);expect(card.projectName).toBe('registered-project');expect(card.projectNameTruncated).toBe(false);
 project='/'+('界'.repeat(100));writer.beginRebuild(2);writer.rebuildPage(2,0);writer.activate(2,0);
 expect(readPreparedSessionWindow(prepared,{space:'everyday',canonicalHead:0}).cards[0]!.projectNameTruncated).toBe(true);
});
