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
  const outside=mkdtempSync(join(tmpdir(),'runner-projects-outside-'));
  writeFileSync(join(outside,'secret.md'),'secret\n');
  symlinkSync(outside,join(project,'escape'));
  process.env.CONCIERGE_WORKSPACE_ROOT=workspace;

  const listed=await serveProjectCall('projects.list',{}) as any;
  assert.deepEqual(listed.projects.map((entry:any)=>entry.name),['example-project']);
  assert.equal(listed.workspaceRoot,workspace);
  assert.equal((await serveProjectCall('projects.resolve',{project:'example-project',path:'docs'} ) as any).cwd,join(project,'docs'));
  assert.equal((await serveProjectCall('projects.instructions',{project:'example-project'}) as any).content,'Project guide\n');
  assert.equal((await serveProjectCall('projects.file',{project:'example-project',path:'docs/guide.md'}) as any).file.content,'Readable guide\n');
  assert.equal((await serveProjectCall('projects.fileAt',{path:join(project,'docs','guide.md')}) as any).file.content,'Readable guide\n');
  assert.deepEqual(await serveProjectCall('projects.fileAt',{path:join(outside,'secret.md')}),{workspaceRoot:workspace,matched:false});
  assert.equal((await serveProjectCall('projects.todos',{project:'example-project'}) as any).content,'# Tasks\n');
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
