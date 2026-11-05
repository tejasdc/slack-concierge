import {existsSync,readFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {db,executionChanged} from './state';

/**
 * What a session is for, in the one line Tejas reads when he rests on it in his session list
 * (the catalogue's `summary`). Every session has one from the moment it exists:
 * `createNativeSession` refuses a session without it, so each creation path states its purpose
 * or derives one from the words that started it.
 *
 * Until 2026-10-11 most sessions had none — 2,285 of 2,438 on the server — and the app said
 * "No fuller purpose was recorded" over the standing Thread reader (Tejas: "wait what is the
 * thread reader doing why is its purpose missing?"). A name alone is not a purpose: the October
 * 10 fallback copied the title into the summary, which still said nothing about the work.
 */
export const PURPOSE_LIMIT=200;
/** Standing sessions whose purpose is their role, not the first message they happened to receive. */
export const INBOX_PURPOSE='Reads everything you send, files it into threads and hands each request to the agent that should do it.';
export const REPAIR_AGENT_PURPOSE='Looks into Concierge health notices, repairs what it can and tells you only what needs you.';
function rolePurpose(meta:{inbox?:boolean;repairAgent?:boolean}){
  return meta.inbox?INBOX_PURPOSE:meta.repairAgent?REPAIR_AGENT_PURPOSE:undefined;
}

/** One line of at most 200 characters, cut at a word with an ellipsis, or undefined when empty. */
export function purposeLine(value:unknown):string|undefined {
  if(typeof value!=='string')return undefined;
  const line=value.replace(/\s+/g,' ').trim();
  if(!line)return undefined;
  if(line.length<=PURPOSE_LIMIT)return line;
  const cut=line.slice(0,PURPOSE_LIMIT-1),space=cut.lastIndexOf(' ');
  return `${(space>120?cut.slice(0,space):cut).replace(/[\s,;:.–-]+$/,'')}…`;
}

/**
 * The purpose stated by the words that started a session: a request's own `Summary:` line, else
 * the first sentence after the request framing. Agent requests carry their framing paragraph and
 * provider headers; neither says what the work is.
 */
export function purposeFromFirstWords(text:unknown):string|undefined {
  if(typeof text!=='string')return undefined;
  const summary=/^Summary: (.+)$/m.exec(text)?.[1];
  if(summary)return purposeLine(summary);
  const body=text
    .replace(/^\{"type":"concierge-session-input"[\s\S]*?\}\}\s*/,'')
    .replace(/^Session request [^\n]*\n\n/,'')
    .replace(/^<[^>]+>[\s\S]*?<\/[^>]+>\s*/,'')
    .trim();
  const sentence=/^[\s\S]*?[.!?](?=\s|$)/.exec(body)?.[0]??body.split('\n')[0];
  return purposeLine(sentence);
}

/**
 * Only a missing purpose or a title copied into the purpose may be replaced. The one-time
 * `session-purposes.json` supplies authored lines first; this fallback fills remaining gaps
 * from each session's first words or name. The unchanged file is renamed `.applied` after both
 * passes finish. A creator, a session or Tejas can set a purpose at any time.
 */
export function fillMissingSessionPurposes(range:{afterId:number;throughId:number}):{written:number} {
  const rows=db.query(`SELECT s.id,s.native_metadata_json AS meta,
      (SELECT user_text FROM turns t WHERE t.session_id=s.id ORDER BY t.id LIMIT 1) AS first,
      (SELECT name FROM channels c WHERE c.slack_channel_id=s.slack_channel_id) AS channel
    FROM sessions s WHERE s.id > ? AND s.id <= ? AND (COALESCE(TRIM(json_extract(s.native_metadata_json,'$.summary')),'')=''
      OR TRIM(json_extract(s.native_metadata_json,'$.summary'))=TRIM(json_extract(s.native_metadata_json,'$.title')))`)
    .all(range.afterId,range.throughId) as {id:number;meta:string|null;first:string|null;channel:string|null}[];
  let count=0;
  db.transaction(()=>{
    for(const row of rows){
      const meta=JSON.parse(row.meta||'{}');
      const purpose=rolePurpose(meta)??purposeFromFirstWords(row.first)??purposeLine(meta.title??row.channel);
      if(!purpose||purpose===meta.summary)continue;
      db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({...meta,summary:purpose}),row.id);
      count++;
    }
  })();
  if(count)executionChanged();
  return {written:count};
}

export type SessionPurposeFile = { text:string; entries:[string,string][] };
export function readSessionPurposeFile(stateDir:string):SessionPurposeFile|null {
  const path=join(stateDir,'session-purposes.json');
  if(!existsSync(path))return null;
  const text=readFileSync(path,'utf8'),parsed=JSON.parse(text);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('The session purpose file must be an ID-to-purpose object.');
  return {text,entries:Object.entries(parsed) as [string,string][]};
}

/** Apply only the named file entries; fallback waits until every page has succeeded. */
export function applySessionPurposeEntries(entries:readonly [string,string][]):{written:number} {
  let count=0;
  db.transaction(()=>{
    for(const [key,value] of entries){
      const id=Number(key),stated=purposeLine(value);
      if(!Number.isSafeInteger(id)||id<=0||!stated)continue;
      const row=db.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(id) as {native_metadata_json:string|null}|null;
      if(!row)continue;
      const meta=JSON.parse(row.native_metadata_json||'{}');
      const current=purposeLine(meta.summary),title=purposeLine(meta.title);
      if(current&&current!==title)continue;
      const purpose=rolePurpose(meta)??stated;
      if(purpose===current)continue;
      db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({...meta,summary:purpose}),id);
      count++;
    }
  })();
  if(count)executionChanged();
  return {written:count};
}

/** Leave a changed file in place for the next pass rather than marking unapplied bytes done. */
export function markSessionPurposeFileApplied(stateDir:string,expectedText:string):boolean {
  const path=join(stateDir,'session-purposes.json');
  if(!existsSync(path)||readFileSync(path,'utf8')!==expectedText)return false;
  renameSync(path,`${path}.applied`);
  return true;
}
