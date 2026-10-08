import {Database} from 'bun:sqlite';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {PreparedSearchIndex} from './prepared-search';

const directory=process.env.CONCIERGE_STATE_DIR;
if(!directory)throw new Error('Presentation search requires CONCIERGE_STATE_DIR.');
const body=JSON.parse(await Bun.stdin.text());
if(typeof body.query!=='string'||body.query.length>2000||!Number.isInteger(body.limit)||body.limit<1||body.limit>100)
  throw new Error('INVALID_SEARCH_QUERY');
const path=join(realpathSync(directory),'presentation.db');
const prepared=new Database(path,{readonly:true});
prepared.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
const meta=prepared.query('SELECT generation,event_watermark,ready FROM presentation_message_meta WHERE singleton=1')
  .get() as {generation:number;event_watermark:number;ready:number}|null;
const result=meta?.ready?new PreparedSearchIndex(prepared,false).search(body.query,body.limit,body.includeTools===true)
  :{hits:[],examined:0,hasMore:false,omissions:['Search is being prepared.']};
const source=new Database(join(realpathSync(directory),'state.db'),{readonly:true});
const sourceHead=(source.query('SELECT COALESCE(MAX(sequence),0) AS n FROM session_owner_events').get() as {n:number}).n;
source.close();prepared.close();
process.stdout.write(JSON.stringify({...result,coverage:{complete:!!meta?.ready&&meta.event_watermark>=sourceHead,
  appliedSequence:meta?.event_watermark??0,sourceHead}}));
