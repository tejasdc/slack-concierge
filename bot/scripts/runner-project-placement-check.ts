import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjectPlacementJob } from '../src/runner-project-placement';

const workspace=mkdtempSync(join(tmpdir(),'runner-project-placement-check-'));
const prior=process.env.CONCIERGE_RUNNER_NAME;
process.env.CONCIERGE_RUNNER_NAME='ax41';
const orderId='0123456789abcdef0123456789abcdef';
const sha='a'.repeat(40);
const calls:string[][]=[];
const run=async(_file:string,args:string[])=>{
  calls.push(args);
  if(args[0]==='repo'&&args[1]==='view')return JSON.stringify({visibility:'PRIVATE',url:'https://github.com/tejasdc/example-project'});
  if(args[0]==='repo'&&args[1]==='clone'){
    const destination=args[3]!;mkdirSync(join(destination,'.git'),{recursive:true});writeFileSync(join(destination,'AGENTS.md'),'Project instructions\n');
    return '';
  }
  const command=args.slice(args.indexOf('-C')+2);
  if(command[0]==='remote'&&command[1]==='get-url')return 'https://github.com/tejasdc/example-project.git';
  if(command[0]==='rev-parse')return sha;
  if(command[0]==='ls-remote')return `${sha}\trefs/heads/main\n`;
  throw new Error(`Unexpected command: ${args.join(' ')}`);
};
try{
  const payload={orderId,project:'example-project',targetRunner:'ax41'};
  const created=await runProjectPlacementJob(payload,{workspaceRoot:workspace,run});
  assert.equal(created.state,'done');
  assert.equal(created.commit,sha);
  const repeated=await runProjectPlacementJob(payload,{workspaceRoot:workspace,run});
  assert.equal(repeated.state,'already_present');
  assert.equal(repeated.commit,sha);
  assert.equal(calls.filter(args=>args[0]==='repo'&&args[1]==='clone').length,1);
  await assert.rejects(()=>runProjectPlacementJob({...payload,targetRunner:'other'}, {workspaceRoot:workspace,run}),/wrong runner/);
  console.log('runner-project-placement-check: private repo checkout is staged, verified, and replay-safe');
}finally{
  if(prior===undefined)delete process.env.CONCIERGE_RUNNER_NAME;else process.env.CONCIERGE_RUNNER_NAME=prior;
  rmSync(workspace,{recursive:true,force:true});
}
