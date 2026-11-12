import {Database} from 'bun:sqlite';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {PreparedSearchIndex} from './prepared-search';
import {searchRouterThreads} from './router-search';

const directory=process.env.CONCIERGE_STATE_DIR;
if(!directory)throw new Error('Presentation search requires CONCIERGE_STATE_DIR.');
const body=JSON.parse(await Bun.stdin.text());
const statePath=join(realpathSync(directory),'state.db');
if(body.kind==='routing') {
  const source=new Database(statePath,{readonly:true});
  try {
    source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA temp_store=MEMORY');
    process.stdout.write(JSON.stringify(searchRouterThreads(source,body.request)));
  } finally {source.close();}
} else {
  if(typeof body.query!=='string'||body.query.length>2000||!Number.isInteger(body.limit)||body.limit<1||body.limit>100)
    throw new Error('INVALID_SEARCH_QUERY');
  const path=join(realpathSync(directory),'presentation.db');
  const prepared=new Database(path,{readonly:true});
  prepared.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
  const meta=prepared.query('SELECT generation,event_watermark,source_head,ready FROM presentation_message_meta WHERE singleton=1')
    .get() as {generation:number;event_watermark:number;source_head:number;ready:number}|null;
  // The search store has its own readiness: it is rebuilt beside a ready Inbox projection.
  const searchReady=!!prepared.query("SELECT 1 FROM sqlite_master WHERE name='search_meta'").get()
    &&!!(prepared.query('SELECT ready FROM search_meta WHERE singleton=1').get() as {ready:number}|null)?.ready;
  const result=meta?.ready&&searchReady?new PreparedSearchIndex(prepared,false).search(body.query,body.limit,body.includeTools===true)
    :{hits:[],examined:0,hasMore:false,omissions:['Search is being prepared.']};
  const source=new Database(statePath,{readonly:true});
  const sourceHead=(source.query('SELECT COALESCE(MAX(sequence),0) AS n FROM presentation_change_log').get() as {n:number}).n;
  source.close();prepared.close();
  process.stdout.write(JSON.stringify({...result,coverage:{complete:!!meta?.ready&&searchReady&&meta.source_head>=sourceHead,
    appliedSequence:meta?.source_head??0,sourceHead}}));
}
