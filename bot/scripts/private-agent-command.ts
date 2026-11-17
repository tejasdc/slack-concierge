/** Host supervisors keep their access; only the command they launch receives the image mask. */
import {spawn} from 'node:child_process';
import {constants} from 'node:os';
import {agentLedgerImageCommand} from '../src/agent-ledger-image-boundary';
const args=process.argv.slice(2);
if(args[0]==='--')args.shift();
if(!args.length)throw new Error('Usage: agent-command -- <command> [args...]');
const [executable,...arguments_]=agentLedgerImageCommand(args);
const child=spawn(executable!,arguments_,{stdio:'inherit',env:process.env});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=signal?128+constants.signals[signal]:(code??1);});
