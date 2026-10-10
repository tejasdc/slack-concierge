#!/usr/bin/env bun
/** Runs checks with fresh state before their first module import or child process. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {privateDatabaseCommand} from '../src/private-database-command';

const args=process.argv.slice(2);
if(args[0]==='--')args.shift();
if(!args.length){console.error('Usage: private-code-command -- <command> [args...]');process.exit(2);}
const state=mkdtempSync(join(tmpdir(),'concierge-private-code-'));
try{
  const command=privateDatabaseCommand(args);
  const env={...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_STATE_DB:join(state,'state.db'),
    CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture'),CONCIERGE_TEST_MODE:'1'};
  const result=spawnSync(command[0],command.slice(1),{env,stdio:'inherit',cwd:process.cwd()});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}finally{rmSync(state,{recursive:true,force:true});}
