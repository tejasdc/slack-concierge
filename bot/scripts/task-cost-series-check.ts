import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {attributeWeeklyAllowance} from '../src/weekly-allowance-attribution';
import {recordTaskCosts,taskCostSeries} from '../src/task-cost-series';

// Median cost per task: tasks are summed from their model calls, recorded once wholly inside the
// week, and the series takes the median over the tasks started in each seven-day window.
const step=900_000,now=Math.floor(Date.now()/step)*step,day=86_400_000;
const raw=(n:number)=>({input:n,cacheWrite:0,cacheWrite1h:0,cacheRead:n*10,output:n});
const bucket=(task:string,weighted:number,atMs:number)=>({provider:'codex',account:'one',
  window:'Weekly',atMs,sessionId:'concierge:1',topicId:null,routineRootId:null,weighted,raw:raw(weighted*100),calls:2,task});
const since=now-7*day;
const report={since:new Date(since).toISOString(),timeZone:'America/New_York',accounts:[{provider:'codex',account:'one',bySession:[]}],
  attributionBuckets:[bucket('request:a',1,now-2*day),bucket('request:a',2,now-2*day+step),
    bucket('request:b',5,now-3*day),bucket('capture:c',1,now-day),bucket('request:old',9,since)],
  taskMix:{'request:a':{models:{'gpt-6.1-sol':1,'gpt-6-luna':2},triggers:{'agent request':1,'report-back':2}},
    'request:b':{models:{'gpt-6.1-sol':5},triggers:{'agent request':5}},'capture:c':{models:{'gpt-6.1-sol':1},triggers:{'his message':1}}}};
const result=attributeWeeklyAllowance(report,[],now) as any;
const a=result.taskCosts.find((row:any)=>row.task==='request:a');
if(result.taskCosts.length!==4||a.dollars!==3||a.calls!==4||a.models['gpt-6-luna']!==2||a.triggers['report-back']!==2)
  throw new Error(`task costs did not sum their calls: ${JSON.stringify(result.taskCosts)}`);

const ledger=ledgerWriteResults(new Database(':memory:'));
ledger.exec(`CREATE TABLE session_communication_requests(request_id TEXT PRIMARY KEY,payload_json TEXT);
  CREATE TABLE session_inputs(id TEXT PRIMARY KEY,origin TEXT,payload_json TEXT);
  CREATE TABLE sessions(id INTEGER PRIMARY KEY,native_metadata_json TEXT);`);
ledger.query('INSERT INTO session_communication_requests VALUES(?,?)').run('a',JSON.stringify({summary:'Fix the typing delay'}));
ledger.query('INSERT INTO session_inputs VALUES(?,?,?)').run('capture:c','human',JSON.stringify({text:'Add this dashboard to our usage window'}));
ledger.query('INSERT INTO sessions VALUES(1,?)').run(JSON.stringify({project:'/root/workspace/thinkering',title:'Typing'}));
const cache=ledgerWriteResults(new Database(':memory:'));
recordTaskCosts(cache,ledger,result.taskCosts,since,now);
const stored=cache.query('SELECT task_id,kind,title,project,dollars FROM task_costs ORDER BY task_id').all() as any[];
if(stored.length!==3||stored.some(row=>row.task_id==='request:old')
  ||stored.find(row=>row.task_id==='request:a')?.title!=='Fix the typing delay'||stored.find(row=>row.task_id==='capture:c')?.kind!=='message'
  ||stored.some(row=>row.project!=='thinkering'))
  throw new Error(`recorded tasks wrong: ${JSON.stringify(stored)}`);

const series=taskCostSeries(cache,'America/New_York',now);
const last=series.points.at(-1)!;
if(last.tasks!==3||last.median!==3||last.byProject.thinkering!==3||series.costliest[0]?.dollars!==5
  ||series.points.length<29||series.projects[0]!=='thinkering'||!last.models.length||!last.triggers.length)
  throw new Error(`series wrong: ${JSON.stringify({last,costliest:series.costliest})}`);
console.log(`cost per task: 3 tasks recorded (the one begun before the week left alone), latest 7-day median $${last.median}, costliest $${series.costliest[0]!.dollars}`);
