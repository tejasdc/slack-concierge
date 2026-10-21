/**
 * Every commit says whether it fixes a failure, and a fix names its failure record.
 *
 * Tejas, 2026-10-21: "hopefully we're capturing every single failure mode when it happens. So when
 * we run the experiments, we can look through all of these failure modes and use them as criteria
 * to see whether the evolved software removes any or all of them, and use them as test cases and
 * test scenarios." An audit of Oct 7–21 found only about a quarter of fixed failures had a record,
 * because writing one was a habit. This makes it a declaration git asks for:
 *
 *   Failure-record: docs/incidents/2026-10-21-some-failure.md   (this commit fixes that failure)
 *   Failure-record: none                                         (this commit fixes no failure)
 *
 * The author declares rather than this script guessing from words: the audit's fix subjects read
 * "Keep paused repeating firings out of recurrence advancement", which no word list recognises, and
 * a guess that refuses real work is the shape removed from the shell guard on 2026-10-07. Words that
 * sound like a fix on a `none` commit are flagged, never refused.
 *
 * Two entrances, one rule:
 *   commit-msg <message-file>   .githooks/commit-msg, while the author is still there.
 *   range <base>..<head>        the GitHub release check, over every commit a branch brings to main,
 *                               so a commit made with --no-verify or on a machine without the hook
 *                               cannot reach main undeclared. There a commit may instead be named in
 *                               a record's `fix_commits`, which is how a record is added afterwards
 *                               without rewriting pushed history.
 * Structured records (front matter) are validated in both, and a new file in docs/incidents must be
 * one. The format is in docs/incidents/README.md.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

/** Commits before the check existed are not asked to declare; they predate the rule. */
const CHECK_SINCE_MS=Date.parse('2026-10-21T17:00:00Z');
const RECORD_DIRS=['docs/incidents/','docs/retrospectives/'];
const TRAILER=/^Failure-record:[ \t]*(.*)$/gim;
/** A later commit on the branch declares for an earlier pushed one, since pushed history is never rewritten. */
const LATE_TRAILER=/^Failure-record-for:[ \t]*([0-9a-f]{7,40})[ \t]+(.+)$/gim;
const SOUNDS_LIKE_A_FIX=/\b(fix(es|ed)?|crash(es|ed)?|regression|froze|freez\w*|stall(s|ed)?|hang(s)?|lost|dropped|broke(n)?|outage|incident|bug)\b/i;
const REQUIRED_FIELDS=['failure','date','fix_commits'];
const REQUIRED_SECTIONS=['## What was seen','## Cause','## Fix','## Acceptance scenario'];
const REQUIRED_SCENARIO=['**Seed:**','**Action:**','**Expected:**'];

const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64<<20}).trimEnd();
const gitOk=(...args:string[])=>{try{execFileSync('git',args,{stdio:'ignore'});return true;}catch{return false;}};

export type Declaration={kind:'none'}|{kind:'records';paths:string[]}|{kind:'missing'};

export function declaration(message:string):Declaration{
  const values=[...message.replace(/^#.*$/gm,'').matchAll(TRAILER)].map(match=>match[1].trim()).filter(Boolean);
  if(!values.length)return {kind:'missing'};
  if(values.some(value=>/^none\b/i.test(value)))return {kind:'none'};
  return {kind:'records',paths:values.map(value=>value.split(/\s+/)[0])};
}

/** Problems with one record's text; empty when it is well formed or an older unstructured record. */
export function recordProblems(path:string,text:string):string[]{
  if(!text.startsWith('---\n'))return [];
  const end=text.indexOf('\n---',4);
  if(end<0)return [`${path}: front matter is not closed with ---`];
  const front=text.slice(4,end);
  const body=text.slice(end+4);
  const problems:string[]=[];
  for(const field of REQUIRED_FIELDS){
    if(!new RegExp(`^${field}:`,'m').test(front))problems.push(`${path}: front matter has no ${field}:`);
  }
  if(/^date:/m.test(front)&&!/^date:[ \t]*\d{4}-\d{2}-\d{2}[ \t]*$/m.test(front))problems.push(`${path}: date: is not YYYY-MM-DD`);
  if(/^fix_commits:/m.test(front)&&!/^fix_commits:[ \t]*\[[0-9a-f, \t]*\][ \t]*$/m.test(front))problems.push(`${path}: fix_commits: is not a [hash, hash] list`);
  for(const section of REQUIRED_SECTIONS){
    if(!body.split('\n').some(line=>line.trim()===section))problems.push(`${path}: missing section "${section}"`);
  }
  const scenario=body.slice(body.indexOf('## Acceptance scenario'));
  if(body.includes('## Acceptance scenario')){
    for(const part of REQUIRED_SCENARIO){
      if(!scenario.includes(part))problems.push(`${path}: acceptance scenario has no ${part}`);
    }
  }
  return problems;
}

export function fixCommits(text:string):string[]{
  const line=text.startsWith('---\n')?text.slice(4,text.indexOf('\n---',4)).match(/^fix_commits:[ \t]*\[([^\]]*)\]/m):null;
  return line?line[1].split(',').map(hash=>hash.trim().toLowerCase()).filter(hash=>hash.length>=7):[];
}

const isRecordPath=(path:string)=>RECORD_DIRS.some(dir=>path.startsWith(dir));
const soundsLikeAFix=(message:string)=>SOUNDS_LIKE_A_FIX.test(message.split(/^Failure-record:/im)[0]);

const HOW=`
  Every commit declares whether it fixes a failure, with one trailer line:

    Failure-record: docs/incidents/YYYY-MM-DD-<what-went-wrong>.md
    Failure-record: none

  A fix names its record: what was seen, the cause, the fix, and a replayable acceptance
  scenario (seed, action, expected). The format is in docs/incidents/README.md; write the record
  in the same commit or an earlier one. Use "none" for work that fixes no failure.
  For a commit already pushed, add a later commit carrying
    Failure-record-for: <hash> <record path | none>
  or list the hash in its record's fix_commits. Never rewrite the pushed commit.`;

function commitMsg(messageFile:string){
  const message=readFileSync(messageFile,'utf8');
  const subject=message.replace(/^#.*$/gm,'').trim().split('\n')[0]??'';
  if(/^(Merge |fixup! |squash! |amend! |Revert ")/.test(subject))return 0;
  const problems:string[]=[];
  const found=declaration(message);
  if(found.kind==='missing')problems.push('this commit has no Failure-record: line.');
  if(found.kind==='records'){
    for(const path of found.paths){
      if(!isRecordPath(path))problems.push(`${path} is not under ${RECORD_DIRS.join(' or ')}.`);
      else if(!gitOk('cat-file','-e',`:${path}`))problems.push(`${path} is not in this commit or an earlier one; stage the record with this commit.`);
    }
  }
  for(const path of git('diff','--cached','--name-only','--diff-filter=AM','--','docs/incidents').split('\n').filter(Boolean)){
    if(!path.endsWith('.md')||path.endsWith('README.md'))continue;
    const text=git('show',`:${path}`)+'\n';
    problems.push(...recordProblems(path,text));
  }
  for(const path of git('diff','--cached','--name-only','--diff-filter=A','--','docs/incidents').split('\n').filter(Boolean)){
    if(path.endsWith('.md')&&!path.endsWith('README.md')&&!git('show',`:${path}`).startsWith('---\n'))problems.push(`${path} is a new record without the record front matter.`);
  }
  if(found.kind==='none'&&soundsLikeAFix(message)){
    console.error('failure-record: this commit says "none" but its message reads like a fix. If it fixes a failure Tejas, an agent or the system hit, name its record instead.');
  }
  if(!problems.length)return 0;
  console.error(`failure-record: commit refused.\n${problems.map(problem=>`  - ${problem}`).join('\n')}\n${HOW}\n`);
  return 1;
}

function range(spec:string){
  const head=spec.includes('..')?spec.split('..')[1]||'HEAD':'HEAD';
  const problems:string[]=[];
  const recorded=new Set<string>();
  const recordFiles=git('ls-tree','-r','--name-only',head,'--','docs/incidents','docs/retrospectives').split('\n').filter(path=>path.endsWith('.md'));
  for(const path of recordFiles){
    const text=git('show',`${head}:${path}`)+'\n';
    for(const hash of fixCommits(text))recorded.add(hash);
    if(path.startsWith('docs/incidents/'))problems.push(...recordProblems(path,text));
  }
  for(const path of git('diff','--name-only','--diff-filter=A',spec,'--','docs/incidents').split('\n').filter(Boolean)){
    if(path.endsWith('.md')&&!path.endsWith('README.md')&&gitOk('cat-file','-e',`${head}:${path}`)&&!git('show',`${head}:${path}`).startsWith('---\n'))problems.push(`${path} is a new record without the record front matter.`);
  }
  const commits=git('rev-list','--no-merges',spec).split('\n').filter(Boolean);
  const late=new Map<string,string>();
  for(const commit of commits){
    for(const match of git('show','-s','--format=%B',commit).matchAll(LATE_TRAILER))late.set(match[1].toLowerCase(),match[2].trim());
  }
  let flagged=0;
  for(const commit of commits){
    if(Number(git('show','-s','--format=%ct',commit))*1000<CHECK_SINCE_MS)continue;
    const message=git('show','-s','--format=%B',commit);
    const subject=message.split('\n')[0];
    if(/^(Merge |Revert ")/.test(subject))continue;
    const short=commit.slice(0,8);
    const listed=[...recorded].some(hash=>commit.startsWith(hash));
    const lateValue=[...late].find(([hash])=>commit.startsWith(hash))?.[1];
    const own=declaration(message);
    const found=own.kind==='missing'&&lateValue?declaration(`Failure-record: ${lateValue}`):own;
    if(found.kind==='missing'&&!listed)problems.push(`${short} "${subject}" has no Failure-record: line and no record lists it in fix_commits.`);
    if(found.kind==='records'){
      for(const path of found.paths){
        if(!isRecordPath(path))problems.push(`${short} names ${path}, which is not under ${RECORD_DIRS.join(' or ')}.`);
        else if(!gitOk('cat-file','-e',`${head}:${path}`)&&!gitOk('cat-file','-e',`${commit}:${path}`))problems.push(`${short} names ${path}, which does not exist.`);
      }
    }
    if(found.kind==='none'&&!listed&&soundsLikeAFix(message)){
      flagged++;
      console.log(`failure-record: ${short} "${subject}" says none but reads like a fix; name its record if it fixed a failure.`);
    }
  }
  if(problems.length){
    console.error(`failure-record: ${problems.length} problem(s) in ${spec}.\n${problems.map(problem=>`  - ${problem}`).join('\n')}\n${HOW}\n`);
    return 1;
  }
  console.log(`failure-record: ${commits.length} commit(s) in ${spec} declared; ${recordFiles.length} record file(s) checked; ${flagged} flagged.`);
  return 0;
}

if(import.meta.main){
  const [mode,arg]=process.argv.slice(2);
  if(mode==='commit-msg'&&arg)process.exit(commitMsg(arg));
  if(mode==='range'&&arg)process.exit(range(arg));
  console.error('usage: failure-record-check.ts commit-msg <message-file> | range <base>..<head>');
  process.exit(2);
}
