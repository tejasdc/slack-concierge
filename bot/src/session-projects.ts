import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export type SessionProject = {name:string;cwd:string};

// Project directories are the routing authority. Slack channel rows are retained
// as historical evidence and must not decide where a new provider starts.
export function sessionProjects(workspaceRoot:string):SessionProject[] {
  const root=realpathSync(workspaceRoot);
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    if(!entry.isDirectory()||entry.name==='d0bmwuj3rd5')return [];
    const cwd=join(root,entry.name);
    try {
      if(!lstatSync(join(cwd,'.git')).isDirectory()||!lstatSync(join(cwd,'AGENTS.md')).isFile())return [];
      if(realpathSync(cwd)!==cwd)return [];
      return [{name:entry.name,cwd}];
    } catch {return [];}
  }).sort((a,b)=>a.name.localeCompare(b.name));
}

export function sessionProject(workspaceRoot:string,requested:string):SessionProject|null {
  return sessionProjects(workspaceRoot).find(project=>project.name===requested||project.cwd===requested)??null;
}
