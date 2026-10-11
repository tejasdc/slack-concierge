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
 * Fills every session still without a purpose, once per startup and only where none is stored,
 * so it never overwrites one a creator, a session or Tejas wrote. Purposes written for existing
 * sessions in plain words (`session-purposes.json` in the state directory, `{"<id>": "<line>"}`,
 * produced once from each session's first words and its project's instructions) come first;
 * the file is renamed `.applied` afterwards so it is read once. Anything still empty takes its
 * first words, and a session with no words at all its name.
 */
export function fillMissingSessionPurposes(stateDir:string):{written:number;fromFile:number} {
  const file=join(stateDir,'session-purposes.json');
  const written:Record<string,string>=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
  const rows=db.query(`SELECT s.id,s.native_metadata_json AS meta,
      (SELECT user_text FROM turns t WHERE t.session_id=s.id ORDER BY t.id LIMIT 1) AS first,
      (SELECT name FROM channels c WHERE c.slack_channel_id=s.slack_channel_id) AS channel
    FROM sessions s WHERE COALESCE(TRIM(json_extract(s.native_metadata_json,'$.summary')),'')=''
      OR TRIM(json_extract(s.native_metadata_json,'$.summary'))=TRIM(json_extract(s.native_metadata_json,'$.title'))`)
    .all() as {id:number;meta:string|null;first:string|null;channel:string|null}[];
  let count=0,fromFile=0;
  db.transaction(()=>{
    for(const row of rows){
      const meta=JSON.parse(row.meta||'{}');
      const stated=purposeLine(written[String(row.id)]);
      const purpose=stated??purposeFromFirstWords(row.first)??purposeLine(meta.title??row.channel);
      if(!purpose||purpose===meta.summary)continue;
      db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({...meta,summary:purpose}),row.id);
      count++;if(stated)fromFile++;
    }
  })();
  if(count)executionChanged();
  if(existsSync(file))renameSync(file,`${file}.applied`);
  return {written:count,fromFile};
}
