import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fail closed if the runner cannot prove Google paid-credit overages are disabled. */
export function assertRunnerGoogleCreditPolicy(settingsPath=join(homedir(),'.gemini','antigravity-cli','settings.json')):void{
  let raw:string;
  try{raw=readFileSync(settingsPath,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return;throw new Error("Google's credit setting could not be verified.");}
  let settings:any;
  try{settings=JSON.parse(raw);}catch{throw new Error("Google's credit setting could not be verified.");}
  if(settings?.useG1Credits===true)throw new Error('Google AI credit overages are enabled; subscription-only dispatch is paused.');
}
