import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runProjectSetupJob} from '../src/runner-project-setup';

const root=mkdtempSync(join(tmpdir(),'runner-project-setup-check-'));
process.env.CONCIERGE_RUNNER_NAME='ax41';
const commit='a'.repeat(40);let origin:string|null=null,remoteHead='';let publicRepo=false;
const calls:string[]=[];
const run=async(file:string,args:string[],cwd?:string):Promise<string>=>{
  calls.push(`${file} ${args.join(' ')}`);
  if(file==='git'){
    if(args.includes('init')){const root=args[args.indexOf('-C')+1]??cwd;mkdirSync(join(root!,'.git'));return 'Initialized';}
    if(args.includes('remote')&&args.includes('get-url')){if(!origin)throw new Error('missing origin');return origin;}
    if(args.includes('rev-parse'))return commit;
    if(args.includes('status'))return '';
    if(args.includes('branch'))return 'main';
    if(args.includes('remote')&&args.includes('add')){origin=args.at(-1)!;return '';}
    if(args.includes('remote')&&args.includes('set-url')){origin=args.at(-1)!;return '';}
    if(args.includes('push')){remoteHead=commit;return '';}
    if(args.includes('ls-remote'))return `${remoteHead}\tHEAD`;
    return '';
  }
  if(file==='gh'&&args[0]==='repo'&&args[1]==='create'){origin='https://github.com/tejasdc/field-notes.git';remoteHead=commit;return '';}
  if(file==='gh'&&args[0]==='repo'&&args[1]==='view')return JSON.stringify({visibility:publicRepo?'PUBLIC':'PRIVATE',url:'https://github.com/tejasdc/field-notes'});
  throw new Error(`unexpected command ${file} ${args.join(' ')}`);
};
try{
  const input={orderId:'a'.repeat(32),project:'field-notes',purpose:'A project for field notes.',targetRunner:'ax41'};
  const first=await runProjectSetupJob(input,{workspaceRoot:root,run});
  assert.deepEqual(first,{state:'done',project:'field-notes',relativePath:'field-notes',commit});
  assert.match(readFileSync(join(root,'field-notes','AGENTS.md'),'utf8'),new RegExp(join(root,'field-notes').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(readFileSync(join(root,'field-notes','CLAUDE.md'),'utf8'),readFileSync(join(root,'field-notes','AGENTS.md'),'utf8'));
  const second=await runProjectSetupJob(input,{workspaceRoot:root,run});
  assert.equal(second.state,'already_present','an acknowledged GitHub create can be reconciled without creating another repository');
  publicRepo=true;
  const publicResult=await runProjectSetupJob({...input,orderId:'b'.repeat(32)},{workspaceRoot:root,run});
  assert.equal(publicResult.state,'refused','existing repo must remain private');
  await assert.rejects(()=>runProjectSetupJob({...input,project:'../escape'},{workspaceRoot:root,run}),/Invalid project name/);
  await assert.rejects(()=>runProjectSetupJob({...input,targetRunner:'other'},{workspaceRoot:root,run}),/wrong runner/);
  assert.equal(calls.filter(call=>call.startsWith('gh repo create')).length,1,'retry must not create a second repository');
  console.log('runner-project-setup-check: owner-validated job creates once, verifies private origin, stages then finalizes, and safely reconciles retries');
}finally{rmSync(root,{recursive:true,force:true});}
