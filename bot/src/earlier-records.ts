import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * The two written records a new piece of work is compared against before it starts: thnkr.ing's
 * failure cases and his decision record. Plain folder readers with no ledger access, so a check can
 * read the real folders without opening Concierge's database.
 *
 * thnkr.ing's failure cases have been one file each since 2026-11-05. Until 2026-11-12 Concierge read
 * the old single ledger file, which had become a pointer, so every brief for a week said "the failure
 * ledger was not found" and no agent was handed an earlier lesson
 * (failure case lessons-not-handed-to-new-agents).
 *
 * His decision record is what he decided, in his words, with how firmly. Tejas, 2026-11-12, after a
 * Threads search shipped with no reference to his earlier search requirements: "When there's a
 * requirement that was already present for a search, how can you come back and implement a search
 * which has no reference to the older one that was done? ... Why are the lessons not captured
 * automatically and transferred to future sessions?"
 */
export const FAILURE_CASES_DIR=process.env.CONCIERGE_FAILURE_CASES||'/root/workspace/thinkering/docs/retrospectives/failure-cases';
export const DECISIONS_DIR=process.env.CONCIERGE_DECISIONS||'/root/workspace/decision-record/decisions';
/**
 * His taste profile: what he consistently wants and rejects, with his words, grouped under principles
 * T1-T17. Most of his requirements for a kind of feature (search, loading signs, notices, flow) live
 * here rather than in a single decision.
 */
export const TASTE_PROFILE=process.env.CONCIERGE_TASTE_PROFILE||'/root/workspace/skills/interface-decisions-skill/references/taste-profile.md';

export const oneLine=(text:unknown,max:number)=>{
  const words=String(text??'').replace(/\s+/g,' ').trim();
  return words.length>max?`${words.slice(0,max).replace(/\s+\S*$/,'')}…`:words;
};

type Cached<T>={key:string;items:T[]};
/**
 * A folder of records, re-read only when a file is added, removed or edited: the file count catches
 * additions and removals, and the newest file time catches edits.
 */
async function folderRecords<T>(dir:string,cache:Cached<T>|null,parse:(body:string)=>T|null):Promise<Cached<T>|null> {
  const names=(await readdir(dir).catch(()=>null))?.filter(name=>name.endsWith('.md')).sort();
  if(!names?.length)return null;
  const times=await Promise.all(names.map(name=>stat(join(dir,name)).then(info=>info.mtimeMs,()=>0)));
  const key=`${names.length}:${Math.max(...times)}`;
  if(cache?.key===key)return cache;
  const items:T[]=[];
  for(const name of names){
    const item=parse(await readFile(join(dir,name),'utf8').catch(()=>''));
    if(item)items.push(item);
  }
  return {key,items};
}

export type FailureCase={id:string;date:string;text:string};
const CASE_HEADING='### Failure-case: ';
let casesCache:Cached<FailureCase>|null=null;
/** The failure cases: each file's case heading and opening words; later reports of one incident are counted under it. */
export async function failureCases():Promise<FailureCase[]> {
  casesCache=await folderRecords(FAILURE_CASES_DIR,casesCache,body=>{
    const at=body.indexOf(`\n${CASE_HEADING}`)+1||(body.startsWith(CASE_HEADING)?0:-1);
    if(at<0)return null;
    const section=body.slice(at+CASE_HEADING.length);
    const heading=/^(\S+)\s*\(([^)]*)\)/.exec(section);
    if(!heading||/\*\*Same incident as:\*\*/.test(section))return null;
    return {id:heading[1]!,date:heading[2]!,text:oneLine(section.slice(heading[0].length).replace(/\*\*/g,''),700)};
  });
  return casesCache?.items??[];
}

export type TastePassage={key:string;principle:string;text:string};
let tasteCache:{mtime:number;items:TastePassage[]}|null=null;
/**
 * The taste profile cut into passages an agent can be handed: each principle's opening (his quotes,
 * Why and Do) is one passage, and each bolded rule under it is another, labelled with its principle.
 */
export async function tastePassages():Promise<TastePassage[]> {
  const mtime=(await stat(TASTE_PROFILE).catch(()=>null))?.mtimeMs;
  if(mtime===undefined)return [];
  if(tasteCache?.mtime===mtime)return tasteCache.items;
  const body=await readFile(TASTE_PROFILE,'utf8');
  const items:TastePassage[]=[];
  for(const chunk of body.split(/^## /m).slice(1)){
    const [title,...rest]=chunk.split('\n');
    const principle=/^(T\d+)/.exec(title!)?.[1];
    if(!principle)continue;
    const label=`${principle}: ${title!.replace(/^T\d+\s*[—-]\s*/,'').trim()}`;
    let current:string[]=[];
    const flush=()=>{const text=oneLine(current.join(' '),900);if(text)items.push({key:`taste:${principle}:${items.length}`,principle:label,text});current=[];};
    for(const paragraph of rest.join('\n').split(/\n\s*\n/)){
      if(/^\*\*/.test(paragraph)&&!/^\*\*(Why|Do|Don't|Not)\b/.test(paragraph))flush();
      current.push(paragraph.replace(/^>\s?/gm,'').replace(/\*\*/g,''));
    }
    flush();
  }
  tasteCache={mtime,items};
  return items;
}

export type Decision={id:string;date:string;status:string;decision:string;scope:string;words:string};
let decisionsCache:Cached<Decision>|null=null;
/** The text under one "## Heading" up to the next heading. */
function section(body:string,heading:string) {
  const start=body.indexOf(`\n## ${heading}\n`);
  if(start<0)return '';
  const from=start+heading.length+5;
  const end=body.indexOf('\n## ',from);
  return body.slice(from,end<0?undefined:end).trim();
}
/** His decisions still in force: permanent and for-now, not superseded. */
export async function decisions():Promise<Decision[]> {
  decisionsCache=await folderRecords(DECISIONS_DIR,decisionsCache,body=>{
    const id=/^ID: (\S+)/m.exec(body)?.[1];
    const status=/^Status: (\S+)/m.exec(body)?.[1]??'';
    if(!id||!['permanent','for-now'].includes(status))return null;
    const superseded=section(body,'Superseded by');
    if(superseded&&!/^[-—–]$|^none\b/i.test(superseded))return null;
    return {id,date:/^Date: (\S+)/m.exec(body)?.[1]??'',status,decision:oneLine(section(body,'Decision'),300),
      scope:oneLine(section(body,'Scope'),300),words:oneLine(section(body,'Words'),500)};
  });
  return decisionsCache?.items??[];
}
