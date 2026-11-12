import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { serveProjectCall } from '../src/runner-projects';

const workspace=mkdtempSync(join(tmpdir(),'runner-projects-check-'));
const prior=process.env.CONCIERGE_WORKSPACE_ROOT;
try {
  const project=join(workspace,'example-project');
  mkdirSync(project,{recursive:true});
  execFileSync('git',['init','--quiet',project]);
  execFileSync('git',['-C',project,'-c','user.name=Runner Check','-c','user.email=runner-check@example.invalid','commit','--allow-empty','--quiet','-m','initial']);
  mkdirSync(join(project,'.wt'),{recursive:true});
  const worktree=join(project,'.wt','feature');
  execFileSync('git',['-C',project,'worktree','add','--quiet','--detach',worktree,'HEAD']);
  writeFileSync(join(worktree,'uncommitted.txt'),'changed\n');
  mkdirSync(join(project,'docs'),{recursive:true});
  mkdirSync(join(project,'notes'),{recursive:true});
  writeFileSync(join(project,'AGENTS.md'),'Project guide\n');
  writeFileSync(join(project,'docs','guide.md'),'Readable guide\n');
  writeFileSync(join(project,'notes','TODOS.md'),'# Tasks\n');
  const agents=join(workspace,'agents');
  const standingProject=join(agents,'concierge-repair');
  mkdirSync(standingProject,{recursive:true});
  execFileSync('git',['init','--quiet',standingProject]);
  writeFileSync(join(standingProject,'AGENTS.md'),'Repair agent guide\n');
  const outside=mkdtempSync(join(tmpdir(),'runner-projects-outside-'));
  writeFileSync(join(outside,'secret.md'),'secret\n');
  symlinkSync(outside,join(project,'escape'));
  process.env.CONCIERGE_WORKSPACE_ROOT=workspace;

  const listed=await serveProjectCall('projects.list',{}) as any;
  assert.deepEqual(listed.projects.map((entry:any)=>entry.name),['concierge-repair','example-project']);
  assert.equal(listed.workspaceRoot,workspace);
  assert.deepEqual(await serveProjectCall('projects.exists',{project:'example-project'}),{exists:true});
  assert.deepEqual(await serveProjectCall('projects.exists',{project:'missing-project'}),{exists:false});
  const shareStatus=await serveProjectCall('projects.shareStatus',{project:'example-project'},{git:async(_cwd,args)=>{
    if(args[0]==='remote')return 'https://github.com/tejasdc/example-project.git';
    if(args[0]==='branch')return 'main';
    if(args[0]==='rev-parse')return 'a'.repeat(40);
    if(args[0]==='ls-remote')return `${'a'.repeat(40)}\trefs/heads/main\n`;
    throw new Error(`unexpected git read ${args.join(' ')}`);
  }}) as any;
  assert.equal(shareStatus.remoteHead,shareStatus.head);
  assert.equal((await serveProjectCall('projects.resolve',{project:'example-project',path:'docs'} ) as any).cwd,join(project,'docs'));
  assert.deepEqual(await serveProjectCall('projects.locate',{location:join(workspace,'legacy-copy','example-project','docs')}),
    {project:'example-project',path:'docs',cwd:join(project,'docs')});
  assert.deepEqual(await serveProjectCall('projects.locate',{location:'agents/concierge-repair'}),
    {project:'concierge-repair',path:'',cwd:standingProject});
  await assert.rejects(()=>serveProjectCall('projects.locate',{location:'agents/missing-repair'}),/not registered/);
  assert.equal((await serveProjectCall('projects.instructions',{project:'example-project'}) as any).content,'Project guide\n');
  assert.equal((await serveProjectCall('projects.file',{project:'example-project',path:'docs/guide.md'}) as any).file.content,'Readable guide\n');
  assert.equal((await serveProjectCall('projects.fileAt',{path:join(project,'docs','guide.md')}) as any).file.content,'Readable guide\n');
  assert.deepEqual(await serveProjectCall('projects.fileAt',{path:join(outside,'secret.md')}),{workspaceRoot:workspace,matched:false});
  assert.equal((await serveProjectCall('projects.todos',{project:'example-project'}) as any).content,'# Tasks\n');
  const marker='<!-- concierge-capture-v1:'+'a'.repeat(64)+' -->';
  assert.equal((await serveProjectCall('projects.todos.append',{project:'example-project',text:'A task from the runner',marker}) as any).appended,true);
  assert.equal((await serveProjectCall('projects.todos.append',{project:'example-project',text:'A task from the runner',marker}) as any).appended,false);
  const priorTodos=await serveProjectCall('projects.todos',{project:'example-project'}) as any;
  const changedTodos=await serveProjectCall('projects.todos.update',{project:'example-project',content:'# Updated\n',sha256:priorTodos.sha256}) as any;
  assert.equal(changedTodos.content,'# Updated\n');
  await assert.rejects(()=>serveProjectCall('projects.todos.update',{project:'example-project',content:'# Stale\n',sha256:priorTodos.sha256}),/changed/);
  assert.equal((await serveProjectCall('projects.files',{project:'example-project',path:'docs'}) as any).entries[0].name,'guide.md');
  const transcript=join(workspace,'session.jsonl');writeFileSync(transcript,JSON.stringify({cwd:worktree})+'\n');
  const worktrees=await serveProjectCall('projects.worktrees',{project:'example-project',provider:'codex',sessionUUID:'01234567-89ab-cdef-0123-456789abcdef',account:'test'},
    {findProviderSessionHome:()=>({account:'test',home:workspace,transcript})}) as any;
  assert.equal(worktrees.items.length,1);
  assert.ok(worktrees.items.every((item:any)=>typeof item.head==='string'&&item.head.length===40));
  assert.ok(worktrees.items[0].uncommittedFiles>0);
  assert.equal((await serveProjectCall('projects.worktrees',{project:'example-project',provider:'codex',sessionUUID:'bad'},
    {findProviderSessionHome:()=>null}).catch(()=>null)),null);
  await assert.rejects(()=>serveProjectCall('projects.resolve',{project:'example-project',path:'../'}),/inside the registered project/);
  await assert.rejects(()=>serveProjectCall('projects.file',{project:'example-project',path:'escape/secret.md'}),/inside the registered project/);
  await assert.rejects(()=>serveProjectCall('projects.resolve',{project:project}),/registered project name/);
  const worktreeServices={createImplementationWorktree:async(root:string,name:string)=>{
    execFileSync('git',['-C',root,'worktree','add','--quiet','-b',`worktree-${name}`,join(root,'.wt',name),'HEAD']);
  }};
  const implementation=await serveProjectCall('projects.implementationWorktree',{project:'example-project',key:'a'.repeat(20)},worktreeServices) as any;
  assert.equal(implementation.project,'example-project');
  assert.equal(implementation.path,`.wt/impl-${'a'.repeat(20)}`);
  assert.equal((await serveProjectCall('projects.implementationWorktree',{project:'example-project',key:'a'.repeat(20)},worktreeServices) as any).cwd,implementation.cwd);
  await assert.rejects(()=>serveProjectCall('projects.implementationWorktree',{project:'example-project/docs',key:'a'.repeat(20)}),/exact registered Git project/);
  await assert.rejects(()=>serveProjectCall('projects.launch',{project:'example-project'}),/Unknown runner project operation/);

  const settings=readFileSync(new URL('../src/claude-code.ts',import.meta.url),'utf8');
  assert.match(settings,/command: `"\$CONCIERGE_BUN_BIN" run/);
  assert.match(settings,/\$\{CONCIERGE_CODEX_SYSTEM_DIR:-\/etc\/codex\}/);
  assert.doesNotMatch(settings,/command: `"\$\{process\.execPath\}/);
  console.log('runner-projects-check: bounded project calls and machine-neutral Claude hooks passed');
  rmSync(outside,{recursive:true,force:true});
} finally {
  if(prior===undefined)delete process.env.CONCIERGE_WORKSPACE_ROOT;else process.env.CONCIERGE_WORKSPACE_ROOT=prior;
  rmSync(workspace,{recursive:true,force:true});
}
