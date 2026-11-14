import {createHash,randomUUID} from 'node:crypto';
import {realpathSync,readFileSync} from 'node:fs';
import {beginCodexManagedHookInstall,completeCodexManagedHookInstall,registerCurrentManagedHookInstaller} from '../src/codex-managed-hook-config';
import {requireCodexMutationReleaseProtection,codexMutationFirstProtectionReadiness} from '../src/codex-mutation-release-compatibility';

function sha256(value:string|Uint8Array){return createHash('sha256').update(value).digest('hex');}
function argsAfterSeparator(argv:string[]){const separator=argv.indexOf('--');return separator<0?[]:argv.slice(separator+1);}
function option(argv:string[],name:string){const at=argv.indexOf(name);return at<0?null:argv[at+1]??null;}
async function forward(readable:ReadableStream<Uint8Array>,writable:NodeJS.WriteStream){
  const reader=readable.getReader();
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;if(!writable.write(chunk.value))await new Promise<void>(resolve=>writable.once('drain',resolve));}}
  finally{reader.releaseLock();}
}

const body=option(process.argv,'--body'),args=argsAfterSeparator(process.argv);
if(!body||!args.length){process.stderr.write('Managed hook installation requires the source body and original installer arguments.\n');process.exit(2);}
const firstProtection=codexMutationFirstProtectionReadiness();
if(!firstProtection.eligible){process.stderr.write(firstProtection.reason+'\n');process.exit(75);}
let bodyPath:string;
try{bodyPath=realpathSync(body);}catch{process.stderr.write('Managed hook installer body is unreadable.\n');process.exit(2);}
const bodyDigest=sha256(readFileSync(bodyPath));
const paramsDigest=sha256(JSON.stringify({bodyDigest,args}));
const operationId=randomUUID(),nowMs=Date.now();
const {db}=await import('../src/state');
try{requireCodexMutationReleaseProtection(db);}catch(error){process.stderr.write((error instanceof Error?error.message:'FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN')+'\n');process.exit(75);}
const begun=beginCodexManagedHookInstall(db,{operationId,paramsDigest,nowMs});
if(!begun.forward){process.stderr.write('Managed hook installation was held by an outstanding native or configuration mutation.\n');process.exit(75);}
registerCurrentManagedHookInstaller(db,{intentId:begun.intentId,nowMs:Date.now()});

// The body is the only child allowed to write installer state. Its exact process exit is
// observed before the durable global intent can be reconciled; process death leaves it held.
const child=Bun.spawn(['/bin/bash',bodyPath,...args],{stdin:'inherit',stdout:'pipe',stderr:'pipe',env:process.env});
const output=Promise.all([forward(child.stdout,process.stdout),forward(child.stderr,process.stderr)]);
const exitCode=await child.exited;
await output;
if(exitCode!==0){process.exit(exitCode??1);}
const responseDigest=sha256(JSON.stringify({operationId,bodyDigest,childExitCode:exitCode}));
const evidenceDigest=sha256(JSON.stringify({operationId,bodyDigest,observedChildExitCode:exitCode}));
completeCodexManagedHookInstall(db,{intentId:begun.intentId,responseDigest,evidenceDigest,nowMs:Date.now()});
