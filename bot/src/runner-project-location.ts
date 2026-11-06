import { basename, isAbsolute, relative, sep } from 'node:path';
import { runnerMachineCall } from './runner-machine-calls';

export type RunnerProjectLocation={project:string|null;path:string;cwd:string};
type Coordinates={projectName?:unknown;projectPath?:unknown;project?:unknown;cwd?:unknown};

/** Resolve a persisted session location on its runner without probing the owner's workspace. */
export async function resolveRunnerProjectLocation(runner:string,metadata:Coordinates):Promise<RunnerProjectLocation> {
  let projectName=typeof metadata.projectName==='string'?metadata.projectName:null;
  let projectPath=typeof metadata.projectPath==='string'?metadata.projectPath:'';
  if(!projectName) {
    const recordedProject=typeof metadata.project==='string'?metadata.project:null;
    const recordedCwd=typeof metadata.cwd==='string'?metadata.cwd:recordedProject;
    if(!recordedCwd)return runnerMachineCall<RunnerProjectLocation>(runner,'projects.default',{});
    if(!isAbsolute(recordedCwd))throw new Error('This session has no stable project identity for its runner.');
    const projects=await runnerMachineCall<{projects:{name:string;path:string}[]}>(runner,'projects.list',{});
    const rootName=recordedProject&&isAbsolute(recordedProject)?basename(recordedProject):'';
    const rooted=projects.projects.filter(project=>project.name===rootName);
    if(recordedProject&&rooted.length===1&&recordedCwd.startsWith(recordedProject+sep)) {
      projectName=rooted[0]!.name;projectPath=relative(recordedProject,recordedCwd);
    } else {
      const segments=recordedCwd.split(sep).filter(Boolean);
      const candidates=projects.projects.flatMap(project=>{
        const index=segments.lastIndexOf(project.name);
        if(index<0)return [];
        return [{project,path:segments.slice(index+1).join('/') }];
      });
      if(candidates.length!==1)throw new Error('This session’s recorded project path does not identify one runner project.');
      projectName=candidates[0]!.project.name;projectPath=candidates[0]!.path;
    }
  }
  if(projectPath.startsWith('/')||projectPath.includes('\\')||projectPath.split('/').some(part=>part==='..'))
    throw new Error('This session’s stored project folder is invalid.');
  return runnerMachineCall<RunnerProjectLocation>(runner,'projects.resolve',{project:projectName,path:projectPath});
}
