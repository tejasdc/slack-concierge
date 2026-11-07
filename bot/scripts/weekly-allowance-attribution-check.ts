import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {attributeWeeklyAllowance,nameAllowanceRows} from '../src/weekly-allowance-attribution';

const step=900_000,now=Math.floor(Date.now()/step)*step;
const raw=(n:number)=>({input:n,cacheWrite:0,cacheWrite1h:0,cacheRead:0,output:0});
const bucket=(account:string,sessionId:string|null,topicId:string|null,weighted:number,atMs=now-2*step,
  routineRootId:number|null=null)=>({provider:'codex',account,window:'Weekly',atMs,sessionId,topicId,routineRootId,
    weighted,raw:raw(weighted*100),calls:1});
const report={since:new Date(now-5*step).toISOString(),timeZone:'America/New_York',accounts:[
  {provider:'codex',account:'one',bySession:[{address:'concierge:1'},{address:'concierge:2'}]},
  {provider:'codex',account:'two',bySession:[{address:'concierge:3'}]}],
  attributionBuckets:[bucket('one','concierge:1','topic-a',2,now-2*step,7),
    bucket('one','concierge:2','topic-a',1),bucket('one',null,null,1),
    bucket('two','concierge:3','topic-a',1)]};
const readings=[
  {provider:'codex',account:'one',window_name:'Weekly',observed_at_ms:now-4*step,used_percent:10,resets_at_ms:now+7*86400_000},
  {provider:'codex',account:'one',window_name:'Weekly',observed_at_ms:now,used_percent:20,resets_at_ms:now+7*86400_000},
  {provider:'codex',account:'two',window_name:'Weekly',observed_at_ms:now-4*step,used_percent:30,resets_at_ms:now+7*86400_000},
  {provider:'codex',account:'two',window_name:'Weekly',observed_at_ms:now,used_percent:35,resets_at_ms:now+7*86400_000}];
const result=attributeWeeklyAllowance(report,readings,now) as any;
const db=ledgerWriteResults(new Database(':memory:'));
db.exec(`CREATE TABLE inbox_topics(topic_id TEXT PRIMARY KEY,title TEXT);
  CREATE TABLE sessions(id INTEGER PRIMARY KEY,native_metadata_json TEXT);
  CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER);`);
db.query('INSERT INTO inbox_topics VALUES(?,?)').run('topic-a','Shared work');
db.query('INSERT INTO sessions VALUES(?,?)').run(1,JSON.stringify({title:'Nightly learning'}));
db.query('INSERT INTO turns VALUES(?,?)').run(7,1);
const named=nameAllowanceRows(result,db);db.close();
if(named.byThread[0]?.title!=='Shared work'||named.byRoutine[0]?.title!=='Nightly learning'
  ||named.byRoutine[0]?.sessionId!=='concierge:1')throw new Error('Allowance row names lost their ledger provenance.');
const one=result.accounts[0],thread=result.threadAllowanceById['topic-a'];
if(one.weeklyAllowance.usedPercent!==20||one.weeklyAllowance.basis!=='measured'
  ||result.sessionAllowanceById['concierge:1'].usedPercent!==5
  ||result.sessionAllowanceById['concierge:2'].usedPercent!==2.5
  ||result.unassignedThread.usedPercent!==2.5
  ||thread.usedPercent!==null||thread.components.length!==2
  ||thread.components.find((value:any)=>value.account==='one')?.usedPercent!==7.5
  ||thread.components.find((value:any)=>value.account==='two')?.usedPercent!==5
  ||result.byRoutine[0]?.rootId!==7||result.byRoutine[0]?.weeklyAllowance.usedPercent!==5
  ||result.byRoutine[0]?.byDay.length!==1)
  throw new Error('Weekly meter allocation double counted a thread, added accounts, or lost routine days.');
const missing=attributeWeeklyAllowance(report,[],now) as any;
if(missing.accounts[0].weeklyAllowance.basis!=='unavailable'
  ||missing.sessionAllowanceById['concierge:1'].basis!=='unavailable')
  throw new Error('Missing provider readings became an allowance percentage.');
const spent=attributeWeeklyAllowance({...report,attributionBuckets:[
  bucket('one','concierge:1','topic-a',1,now-3*step),bucket('one','concierge:2','topic-a',1,now-step)]},[
  readings[0]!,{...readings[1]!,observed_at_ms:now-2*step,used_percent:100},
  {...readings[1]!,used_percent:100}],now) as any;
if(spent.sessionAllowanceById['concierge:2'].basis!=='unavailable')
  throw new Error('Usage after weekly saturation was charged to included allowance.');
console.log('weekly allowance separates account meters, sums cross-session threads once, keeps routine days, and preserves unknown coverage');
