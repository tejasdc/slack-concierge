import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type SessionProject = {name:string;cwd:string};

// Project directories are the routing authority. Slack channel rows are retained
// as historical evidence and must not decide where a new provider starts.
//
// Two kinds of folder qualify. A code project is a folder with its own Git root and
// agent instructions: a workspace child, or a child of a grouping folder that is not
// itself a repository (the Mac's ideaflow/, holding team repositories such as Cortex,
// which were invisible until September 30, 2026). Team repositories keep their own
// layout, so CLAUDE.md counts as instructions and either file may be a symlink. A
// nested repository inside a project is never listed, and a workspace child keeps its
// name over a grouped one. A writing workspace is a child of an Obsidian vault with its own
// AGENTS.md: Obsidian Sync already keeps its one copy on every device, so it has no
// Git root and must not be given a second copy to become one (the blogs folder,
// September 25, 2026). A code project keeps its name when both kinds share one.
export function sessionProjects(workspaceRoot:string):SessionProject[] {
  const root=realpathSync(workspaceRoot);
  const children=canonicalChildren(root);
  const grouped=children.filter(child=>!isDirectory(join(child,'.git'))&&!isDirectory(join(child,'.obsidian'))).flatMap(canonicalChildren);
  const code=[...children,...grouped].filter(cwd=>isDirectory(join(cwd,'.git'))&&(resolvesToFile(join(cwd,'AGENTS.md'))||resolvesToFile(join(cwd,'CLAUDE.md'))));
  const writing=obsidianVaults(root).flatMap(vault=>canonicalChildren(vault).filter(cwd=>isFile(join(cwd,'AGENTS.md'))));
  const byName=new Map<string,SessionProject>();
  for(const cwd of [...code,...writing]) {
    const name=cwd.slice(cwd.lastIndexOf('/')+1);
    if(!byName.has(name))byName.set(name,{name,cwd});
  }
  return [...byName.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

export function sessionProject(workspaceRoot:string,requested:string):SessionProject|null {
  return sessionProjects(workspaceRoot).find(project=>project.name===requested||project.cwd===requested)??null;
}

// A vault is a workspace child (the server's vault/) or grandchild (the Mac's
// obsidian-vault/journalmaxx/) holding Obsidian's own .obsidian settings folder.
function obsidianVaults(root:string):string[] {
  return canonicalChildren(root).flatMap(child=>isDirectory(join(child,'.obsidian'))?[child]:canonicalChildren(child).filter(grandchild=>isDirectory(join(grandchild,'.obsidian'))));
}

function canonicalChildren(parent:string):string[] {
  try {
    return readdirSync(parent,{withFileTypes:true}).flatMap(entry=>{
      if(!entry.isDirectory()||entry.name.startsWith('.')||entry.name==='d0bmwuj3rd5')return [];
      const cwd=join(parent,entry.name);
      try {return realpathSync(cwd)===cwd?[cwd]:[];} catch {return [];}
    });
  } catch {return [];}
}

function isDirectory(path:string):boolean {try {return lstatSync(path).isDirectory();} catch {return false;}}
function isFile(path:string):boolean {try {return lstatSync(path).isFile();} catch {return false;}}
function resolvesToFile(path:string):boolean {try {return statSync(path).isFile();} catch {return false;}}
