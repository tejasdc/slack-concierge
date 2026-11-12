/**
 * Both owner compositions must run saved-work upkeep. On 2026-11-12 the server's composition
 * (index.ts) never called it, so no banked job could start there for weeks
 * (docs/incidents/2026-11-12-quiet-only-banked-job-never-started.md).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const required=[/createBankedUpkeep\(/,/\.onReading\(\)/,/\.onExecutionChange\(\)/,/\.started\(/,/\.settled\(/];
const failures:string[]=[];
for(const file of ['index.ts','session-runtime.ts']){
  const source=readFileSync(join(import.meta.dir,'..','src',file),'utf8');
  for(const pattern of required)if(!pattern.test(source))failures.push(`${file} is missing saved-work upkeep: ${pattern}`);
}
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
console.log('saved-work-composition-check: both owner compositions run saved-work upkeep.');
