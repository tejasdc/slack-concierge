#!/usr/bin/env bun
/** Runs checks with fresh state before their first module import or child process. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {privateCodeCommand} from '../src/private-database-command';

const args=process.argv.slice(2);
if(args[0]==='--')args.shift();
if(!args.length){console.error('Usage: private-code-command -- <command> [args...]');process.exit(2);}
const state=mkdtempSync(join(tmpdir(),'concierge-private-code-'));
try{
  const env={...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_STATE_DB:join(state,'state.db'),
    CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture'),CONCIERGE_TEST_MODE:'1',CONCIERGE_PRIVATE_CODE_STATE:state};
  const isolated=privateCodeCommand(args,env);
  try{
    const result=spawnSync(isolated.command[0],isolated.command.slice(1),{env:isolated.environment,stdio:'inherit',cwd:process.cwd()});
    if(result.error)throw result.error;
    process.exitCode=result.status??1;
  }finally{isolated.cleanup();}
}finally{rmSync(state,{recursive:true,force:true});}
