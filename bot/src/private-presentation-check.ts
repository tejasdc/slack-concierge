import {privateCodeCommand} from './private-database-command';
import {runFixtureChild} from '../scripts/fixture-child';
import POLICY from '../scripts/release-check-policy.json';

/** The native group owner stays outside the private PID namespace. */
export async function runPrivatePresentationCheck(command:string[],cwd:string,environment:NodeJS.ProcessEnv){
 const started=performance.now(),stdout:Buffer[]=[],stderr:Buffer[]=[];
 const isolated=privateCodeCommand(command,environment);
 try{
  const deadlineMs=POLICY.deadlineMs-POLICY.cleanupMs-(performance.now()-started);
  if(deadlineMs<=0)throw Error('Presentation isolation consumed its existing work budget.');
  await runFixtureChild({command:isolated.command[0]!,args:isolated.command.slice(1),cwd,env:isolated.environment,
   deadlineMs,fixture:'presentation-release',requireCheckpoint:false,
   requireOwnedGroup:environment.CONCIERGE_FIXTURE_SHARED_GROUP!=='1',
   onOutput:(stream,chunk)=>(stream==='stdout'?stdout:stderr).push(Buffer.from(chunk))});
  return{exitCode:0,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)};
 }catch(error){
  stderr.push(Buffer.from(`\n${String(error)}\n`));
  return{exitCode:1,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)};
 }finally{isolated.cleanup();}
}
