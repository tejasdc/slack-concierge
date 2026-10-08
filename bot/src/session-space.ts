import {basename} from 'node:path';

/** Folder identity is the sole authority for the lab/everyday split. This module has no
 * application state import, so a read-only presentation worker can apply the same rule. */
export const LAB_PROJECTS: readonly string[]=['agent-ecology','lab-commons'];
export const LAB_PROJECT_PREFIX='expertise-';
export type SessionSpace='lab'|'everyday';
export function isLabProject(cwd:string|null|undefined):boolean {
  if(!cwd)return false;
  return cwd.split('/').some(name=>LAB_PROJECTS.includes(name))||basename(cwd).startsWith(LAB_PROJECT_PREFIX);
}
export function spaceForCwd(cwd:string|null|undefined):SessionSpace {
  return isLabProject(cwd)?'lab':'everyday';
}
