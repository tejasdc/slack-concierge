import {mkdtempSync,mkdirSync,openSync,writeSync,closeSync,writeFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runFixtureChild} from './fixture-child';
import {privateCodeCommand} from '../src/private-database-command';
import POLICY from './release-check-policy.json';
import CHECKS from './release-checks.json';

type CheckResult={command:string[];status:'passed'|'failed';elapsedMs:number;error?:string};
type CheckGroup=keyof typeof CHECKS;
/** One inventory assigns every check exactly once. Host-only groups need the AX41's live-ledger
 * isolation and run inside the candidate's own presentation check before a release is sealed;
 * the hosted Release check runs every other group. Neither environment may skip its share. */
export const HOST_ONLY_GROUPS=new Set<string>(POLICY.hostOnlyGroups);
export function releaseCheckMatrix(){
 const groups=Object.keys(CHECKS) as CheckGroup[];
 if(!groups.length||groups.some(group=>!Array.isArray(CHECKS[group])||!CHECKS[group].length))throw Error('Release check groups must contain commands.');
 if([...HOST_ONLY_GROUPS].some(group=>!groups.includes(group as CheckGroup)))throw Error('A host-only release-check group is not declared.');
 const seen=new Set<string>();
 for(const group of groups)for(const command of CHECKS[group]){
  const key=JSON.stringify(command);
  if(seen.has(key))throw Error(`Release check assigned twice: ${command.join(' ')}`);
  seen.add(key);
 }
 return {include:groups.filter(group=>!HOST_ONLY_GROUPS.has(group)).map(group=>({group}))};
}
/** A physical fact, never an environment string: the canonical live ledger exists here. */
export function liveLedgerPresent():boolean {
 return existsSync(join(homedir(),'.local/state/concierge'));
}
export function selectReleaseCheckGroup(args:string[]):CheckGroup {
 const group=args.length===0?'build':args.length===1&&args[0]==='--history-cache'?'historyCache':
  args.length===2&&args[0]==='--group'?args[1]:null;
 if(!group||!Object.hasOwn(CHECKS,group))throw Error('Select one declared release-check group; CI runs each group in its own bounded job.');
 releaseCheckMatrix();
 return group as CheckGroup;
}
/** Independent commands keep separate state and full logs; build-group compilation runs last. */
export async function runCheckSuite(commands:string[][],options:{deadlineAt:number;parallelChecks:number;root:string}) {
 const start=performance.now(),controller=new AbortController(),results:CheckResult[]=[];
 let next=0;
 const cancel=()=>controller.abort();
 process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
 const timer=setTimeout(cancel,Math.max(0,options.deadlineAt-Date.now()));
 const run=async(command:string[],index:number)=>{
  const directory=join(options.root,String(index));mkdirSync(directory,{recursive:true});
  mkdirSync(join(directory,'state'));mkdirSync(join(directory,'capture'));
  const stdout=openSync(join(directory,'stdout'),'w'),stderr=openSync(join(directory,'stderr'),'w');
  const started=performance.now();
  try {
   // This root already established the independent private-code boundary.
   // Re-entering its user namespaces would exceed the supported nesting topology.
   const nestedPrivate=process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED==='1'
     &&command[0]==='bun'&&command[1]==='run'&&command[2]==='scripts/private-code-command.ts'&&command[3]==='--';
   const [executable,...args]=nestedPrivate?command.slice(4):command;
   const childEnv:NodeJS.ProcessEnv={...process.env,CONCIERGE_STATE_DIR:join(directory,'state'),
     CONCIERGE_CAPTURE_STATE_DIR:join(directory,'capture'),CONCIERGE_PRIVATE_CODE_STATE:join(directory,'state')};
   if(nestedPrivate){childEnv.CONCIERGE_STATE_DB=join(directory,'state/state.db');childEnv.CONCIERGE_TEST_MODE='1';}
   await runFixtureChild({command:executable==='bun'?process.execPath:executable!,args,
    cwd:resolve(import.meta.dir,'..'),env:childEnv,
    deadlineMs:Math.max(1,options.deadlineAt-Date.now()),signal:controller.signal,requireCheckpoint:false,
    fixture:command.join(' '),onOutput:(stream,chunk)=>writeSync(stream==='stdout'?stdout:stderr,chunk)});
   results.push({command,status:'passed',elapsedMs:Math.round(performance.now()-started)});
  } catch(error) {
   results.push({command,status:'failed',elapsedMs:Math.round(performance.now()-started),error:String(error)});
   controller.abort();
  } finally {closeSync(stdout);closeSync(stderr);}
  process.stderr.write(JSON.stringify(results.at(-1))+'\n');
 };
 try {
  const worker=async()=>{while(!controller.signal.aborted&&next<commands.length){const index=next++;await run(commands[index]!,index);}};
  await Promise.all(Array.from({length:Math.min(commands.length,options.parallelChecks)},worker));
  const report={fixture:'release-check-suite',status:results.length===commands.length&&results.every(x=>x.status==='passed')?'passed':'failed',
   elapsedMs:Math.round(performance.now()-start),expected:commands.length,completed:results.length,logs:options.root,results};
  writeFileSync(join(options.root,'report.json'),JSON.stringify(report,null,2)+'\n');
  if(report.status!=='passed')throw new Error(`Release checks failed or did not finish: ${JSON.stringify(report)}`);
  return report;
 } finally {clearTimeout(timer);process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
}

if(import.meta.main) {
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--matrix'){process.stdout.write(JSON.stringify(releaseCheckMatrix())+'\n');process.exit(0);}
 const group=selectReleaseCheckGroup(args.filter(arg=>arg!=='--suite-child'));
 if(process.argv.includes('--suite-child')) {
  // Isolation protects the live ledger. Host-only groups always require it; a portable group
  // may run without it only where no live ledger exists to protect (the hosted runner).
  if(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED!=='1'&&(HOST_ONLY_GROUPS.has(group)||liveLedgerPresent()))
   throw Error('Release checks require the verified private-code entrance.');
  process.env.CONCIERGE_RELEASE_CHECK_GROUP=group;
  const root=mkdtempSync(join(tmpdir(),'concierge-release-checks-'));
  process.stderr.write(JSON.stringify({fixture:'release-checks',phase:'started',logs:root})+'\n');
  const deadlineAt=Number(process.env.CONCIERGE_CHECK_DEADLINE_AT);
  if(!Number.isFinite(deadlineAt))throw new Error('Release check deadline is missing.');
  const commands=CHECKS[group],compile=group==='build'?commands.at(-1)!:null;
  const checks=compile?commands.slice(0,-1):commands;
  const first=await runCheckSuite(checks,{deadlineAt,parallelChecks:POLICY.parallelChecks,root});
  const compiled=compile?await runCheckSuite([compile],{deadlineAt,parallelChecks:1,root:join(root,'compile')}):{completed:0,elapsedMs:0};
  console.log(JSON.stringify({fixture:'release-checks',group,status:'passed',checks:first.completed+compiled.completed,elapsedMs:first.elapsedMs+compiled.elapsedMs,logs:root}));
 } else {
  const deadlineAt=Date.now()+POLICY.deadlineMs-POLICY.cleanupMs;
  const child=[process.execPath,import.meta.path,'--suite-child','--group',group];
  const environment={...process.env,CONCIERGE_CHECK_DEADLINE_AT:String(deadlineAt)};
  const isolated=HOST_ONLY_GROUPS.has(group)||liveLedgerPresent()?privateCodeCommand(child,environment)
   :{command:child,environment,cleanup:()=>{}};
  try{await runFixtureChild({command:isolated.command[0]!,args:isolated.command.slice(1),
   env:isolated.environment,deadlineMs:POLICY.deadlineMs-POLICY.cleanupMs,
   fixture:'release-checks',requireCheckpoint:false,requireOwnedGroup:true,onOutput:(stream,chunk)=>process[stream].write(chunk)});
  }finally{isolated.cleanup();}
 }
}
