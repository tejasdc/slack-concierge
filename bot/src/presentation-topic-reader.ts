import {Database} from 'bun:sqlite';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {db} from './state';
import {presentationHead} from './presentation-changes';
import {observedDatabase} from './storage-observation';
import {readPreparedTopics,readPreparedTopicOverview,readPreparedTopicItems,readPreparedQuestions,
 readPreparedTopicChanges,readPreparedTopicResolution,readPreparedTopicChunk,readPreparedTopicEvents} from './prepared-topics';

let connection:Database|null=null;
function prepared(){
 const directory=process.env.CONCIERGE_STATE_DIR;
 if(!directory)return null;
 const path=join(realpathSync(directory),'presentation.db');
 if(!existsSync(path))return null;
 if(!connection){const raw=new Database(path,{readonly:true});raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');connection=observedDatabase(raw);}
 return connection.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='presentation_topics' LIMIT 1").get()?connection:null;
}
const indexing=()=>({complete:false,code:'presentation_indexing',appliedSequence:0,retryAfterMs:1000});
export function preparedTopicEventDisplays(sequences:readonly number[]){
 const reader=prepared();return reader?readPreparedTopicEvents(reader,sequences):sequences.map(()=>null);
}
export function preparedTopics(options:Omit<Parameters<typeof readPreparedTopics>[1],'canonicalHead'>){
 const reader=prepared();return reader?readPreparedTopics(reader,{...options,canonicalHead:presentationHead(db)}):
  {topics:[],nextCursor:null,asOf:'',sorting:{count:0,captures:[]},coverage:indexing()};
}
export function preparedTopicOverview(id:string,filter:string){
 const reader=prepared();return reader?readPreparedTopicOverview(reader,id,presentationHead(db),filter):{topic:null,coverage:indexing()};
}
export function preparedTopicItems(options:Omit<Parameters<typeof readPreparedTopicItems>[1],'canonicalHead'>){
 const reader=prepared();return reader?readPreparedTopicItems(reader,{...options,canonicalHead:presentationHead(db)}):
  {items:[],nextCursor:null,coverage:indexing()};
}
export function preparedQuestions(options:Omit<Parameters<typeof readPreparedQuestions>[1],'canonicalHead'>){
 const reader=prepared();return reader?readPreparedQuestions(reader,{...options,canonicalHead:presentationHead(db)}):
  {topics:[],questions:[],nextCursor:null,coverage:indexing()};
}
export function preparedTopicChanges(after:string,limit:number){
 const reader=prepared();return reader?readPreparedTopicChanges(reader,after,presentationHead(db),limit):
  {changes:[],asOf:'',nextCursor:null,coverage:indexing()};
}
export function preparedTopicResolution(message:string){
 const reader=prepared();return reader?readPreparedTopicResolution(reader,message,presentationHead(db)):
  {topic:null,root:null,coverage:indexing()};
}
export function preparedTopicDetail(hash:string,part:number,topicId?:string){
 const reader=prepared();if(!reader)return null;
 if(topicId&&!reader.query(`SELECT 1 FROM presentation_topic_chunk_refs
   WHERE generation=(SELECT generation FROM presentation_topics_meta WHERE singleton=1) AND owner=? AND hash=? LIMIT 1`)
   .get(`topic:${topicId}`,hash))return null;
 const chunk=readPreparedTopicChunk(reader,hash,part);if(!chunk)return null;
 return {content:chunk.text,nextPart:part+1<chunk.count?part+1:null,digest:hash,complete:part+1===chunk.count};
}
