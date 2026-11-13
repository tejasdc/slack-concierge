import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'claude-exact-resume-'));
const home=join(root,'.claude'), accountHome=join(root,'.claude-accounts','original');
const project=join(home,'projects','fixture');
const id='12345678-1234-4234-8234-123456789abc';
const transcript=join(project,`${id}.jsonl`), log=join(root,'requests');
const launcher=join(import.meta.dir,'agent-claude-launch.ts');
mkdirSync(project,{recursive:true}); mkdirSync(accountHome,{recursive:true});
symlinkSync(join(home,'projects'),join(accountHome,'projects'));
writeFileSync(join(accountHome,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'original',organizationUuid:'org',emailAddress:'original@example.test'}}));
const fake=join(root,'fake-claude');
writeFileSync(fake,`#!${process.execPath}\nimport {appendFileSync,writeFileSync} from 'node:fs';\nconst h=process.env.CLAUDE_CONFIG_DIR;\nif(process.argv[2]==='auth'){const ok=process.env.FIXTURE_ACCOUNT.split(':').includes(h);console.log(JSON.stringify({loggedIn:ok,authMethod:'claude.ai',apiProvider:'firstParty',email:'original@example.test',configDirectory:h}));process.exit(ok?0:1)}\nappendFileSync(process.env.FIXTURE_LOG,JSON.stringify({home:h,args:process.argv.slice(2)})+'\\n');\nif(process.argv.includes('fresh'))writeFileSync(process.env.FIXTURE_TRANSCRIPT,JSON.stringify({type:'session-owner',sessionId:process.env.FIXTURE_ID,accountUuid:'original',organizationUuid:'org'})+'\\n');\n`);
chmodSync(fake,0o755);
const server=Bun.serve({port:0,fetch:()=>Response.json({choice:{account:'original@example.test',home:accountHome}})});
const env={...process.env,HOME:root,CLAUDE_CONFIG_DIR:home,CONCIERGE_RUNNER_STATE:root,CONCIERGE_CLAUDE_CODE_EXECUTABLE:fake,CONCIERGE_OWNER_URL:`http://127.0.0.1:${server.port}`,CONCIERGE_AGENT_TOKEN:'fixture',FIXTURE_ACCOUNT:accountHome,FIXTURE_LOG:log,FIXTURE_TRANSCRIPT:transcript,FIXTURE_ID:id};
for(const name of ['CONCIERGE_CLAUDE_ACCOUNT_PIN','CONCIERGE_CLAUDE_LAUNCH_PARENT_PID','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[name];
async function run(args:string[]){
  const child=spawn(process.execPath,['run',launcher,...args],{env,stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',chunk=>error+=chunk);
  const code=await new Promise<number|null>(resolve=>child.on('exit',resolve));
  return {code,error};
}
const count=()=>readFileSync(log,'utf8').trim().split('\n').length;
try{
  const fresh=await run(['-p','fresh']); assert.equal(fresh.code,0,fresh.error);
  const resume=await run(['--resume',id,'-p','follow up']); assert.equal(resume.code,0,resume.error);
  const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,2); assert.equal(calls[1].home,accountHome); assert.deepEqual(calls[1].args,['--resume',id,'-p','follow up']);
  for(const option of [`-r${id}`,`--resume=${id}`]){
    const result=await run([option,'-p','follow up']); assert.equal(result.code,0,result.error);
    const call=JSON.parse(readFileSync(log,'utf8').trim().split('\n').at(-1)!);
    assert.equal(call.home,accountHome); assert.deepEqual(call.args,[option,'-p','follow up']);
  }
  writeFileSync(transcript,JSON.stringify({type:'session-owner',sessionId:id,accountUuid:'original',organizationUuid:'org'})+'\n'+JSON.stringify({type:'session-owner',sessionId:id,accountUuid:'other',organizationUuid:'other'})+'\n{partial');
  truncateSync(transcript,590*1024*1024);
  let result=await run([`-r${id}`,'-p','large transcript']); assert.equal(result.code,0,result.error);
  assert.equal(JSON.parse(readFileSync(log,'utf8').trim().split('\n').at(-1)!).home,accountHome);
  writeFileSync(transcript,JSON.stringify({type:'user'})+'\n');
  result=await run(['--resume',id,'-p','blocked']); assert.notEqual(result.code,0); assert.match(result.error,/binding is missing or malformed/); assert.equal(count(),5);
  result=await run([`--resume=${id}`,'-p','blocked']); assert.notEqual(result.code,0); assert.match(result.error,/binding is missing or malformed/); assert.equal(count(),5);
  for(const header of ['{broken\n',JSON.stringify({type:'session-owner',sessionId:id,accountUuid:'original',organizationUuid:'org'}), 'x'.repeat(65536)]){
    writeFileSync(transcript,header);
    result=await run([`-r${id}`,'-p','blocked']); assert.notEqual(result.code,0); assert.match(result.error,/header/); assert.equal(count(),5);
  }
  writeFileSync(transcript,JSON.stringify({type:'session-owner',sessionId:id,accountUuid:'other',organizationUuid:'org'})+'\n');
  result=await run(['--resume',id,'-p','blocked']); assert.notEqual(result.code,0); assert.match(result.error,/no working home/); assert.equal(count(),5);
  writeFileSync(transcript,JSON.stringify({type:'session-owner',sessionId:id,accountUuid:'original',organizationUuid:'org'})+'\n');
  env.FIXTURE_ACCOUNT=home;
  result=await run(['--resume',id,'-p','blocked']); assert.notEqual(result.code,0); assert.match(result.error,/no working home/); assert.equal(count(),5);
  env.FIXTURE_ACCOUNT=accountHome;
  const duplicate=join(root,'.claude-accounts','duplicate'); mkdirSync(duplicate);
  symlinkSync(join(home,'projects'),join(duplicate,'projects'));
  writeFileSync(join(duplicate,'.claude.json'),readFileSync(join(accountHome,'.claude.json')));
  env.FIXTURE_ACCOUNT=`${accountHome}:${duplicate}`;
  result=await run(['--resume',id,'-p','blocked']); assert.notEqual(result.code,0); assert.match(result.error,/ambiguous working homes/); assert.equal(count(),5);
  env.FIXTURE_ACCOUNT=accountHome;
  result=await run(['--resume',id,`-r${id}`,'-p','blocked']); assert.notEqual(result.code,0); assert.match(result.error,/multiple resume arguments/); assert.equal(count(),5);
  env.CONCIERGE_CLAUDE_ACCOUNT_PIN='1';
  result=await run(['--resume',id,'-p','pinned']); assert.equal(result.code,0,result.error);
  const pinned=JSON.parse(readFileSync(log,'utf8').trim().split('\n').at(-1)!); assert.equal(pinned.home,home);
  delete env.CONCIERGE_CLAUDE_ACCOUNT_PIN;
  result=await run(['--continue','-p','continued']); assert.equal(result.code,0,result.error);
  const continued=JSON.parse(readFileSync(log,'utf8').trim().split('\n').at(-1)!); assert.equal(continued.home,home);
  console.log('Exact resume spellings use the original verified home; malformed headers and unavailable or ambiguous homes refuse before a prompt. Large transcript tails are ignored.');
}finally{server.stop(true);rmSync(root,{recursive:true,force:true});}
