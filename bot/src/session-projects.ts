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

/**
 * A registered project, or a folder inside one: `agent-ecology/expertise/alan-kay` (or its absolute
 * path) starts a session in that folder under the project's authority. Work that belongs to a
 * project stays inside it instead of becoming a top-level project of its own (Tejas, 2026-10-08:
 * "Why do we have an expertise folder in the root workspace?"). The folder must already exist and
 * must not leave the project through a link.
 */
export function sessionProject(workspaceRoot:string,requested:string,options:{inside?:boolean}={}):SessionProject|null {
  const projects=sessionProjects(workspaceRoot);
  const exact=projects.find(project=>project.name===requested||project.cwd===requested);
  if(exact||!options.inside)return exact??null;
  for(const project of projects) {
    const inside=requested.startsWith(`${project.name}/`)?join(project.cwd,requested.slice(project.name.length+1))
      :requested.startsWith(`${project.cwd}/`)?requested:null;
    if(!inside)continue;
    try {
      const cwd=realpathSync(inside);
      if(cwd.startsWith(`${project.cwd}/`)&&lstatSync(cwd).isDirectory())return {name:`${project.name}/${cwd.slice(project.cwd.length+1)}`,cwd};
    } catch {/* no such folder */}
    return null;
  }
  return null;
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

/** The registered project a folder belongs to: itself, or the project it is inside. Task lists and instructions belong to the project, not its subfolders. */
export function containingProject(workspaceRoot:string,cwd:string):SessionProject|null {
  return sessionProjects(workspaceRoot).find(project=>cwd===project.cwd||cwd.startsWith(`${project.cwd}/`))??null;
}
