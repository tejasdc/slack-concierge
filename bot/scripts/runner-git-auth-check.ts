import assert from 'node:assert/strict';
import {execFile as execFileCallback,execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {chmodSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {runnerGithubGitEnvironment} from '../src/runner-git-auth';

const root=mkdtempSync(join(tmpdir(),'runner-git-auth-check-'));
const run=promisify(execFileCallback);
const bare=join(root,'private.git'),work=join(root,'work'),bin=join(root,'bin');
mkdirSync(bin);
const helper=join(bin,'gh');
writeFileSync(helper,'#!/bin/sh\n[ "$1" = auth ] && [ "$2" = git-credential ] || exit 1\ncat >/dev/null\nprintf "username=fixture\\npassword=fixture-token\\n\\n"\n');
chmodSync(helper,0o700);
execFileSync('git',['init','-q','--bare',bare]);
execFileSync('git',['--git-dir',bare,'config','http.receivepack','true']);
execFileSync('git',['init','-q','-b','main',work]);
execFileSync('git',['-C',work,'config','user.name','Runner fixture']);
execFileSync('git',['-C',work,'config','user.email','runner-fixture@example.invalid']);
writeFileSync(join(work,'README.md'),'Private runner project\n');
execFileSync('git',['-C',work,'add','README.md']);
execFileSync('git',['-C',work,'commit','-qm','fixture']);
execFileSync('git',['--git-dir',bare,'fetch','-q',work,'main:main']);
execFileSync('git',['--git-dir',bare,'symbolic-ref','HEAD','refs/heads/main']);

let unauthorized=0,authorized=0;
const expected=`Basic ${Buffer.from('fixture:fixture-token').toString('base64')}`;
const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==expected){unauthorized++;res.writeHead(401,{'WWW-Authenticate':'Basic realm="private fixture"'});res.end('authentication required');return;}
  authorized++;
  const body:Buffer[]=[];for await(const chunk of req)body.push(Buffer.from(chunk));
  const path=new URL(req.url??'/',`http://${req.headers.host}`).pathname;
  const query=new URL(req.url??'/',`http://${req.headers.host}`).search.slice(1);
  const env={...process.env,GIT_PROJECT_ROOT:root,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:path,QUERY_STRING:query,
    REQUEST_METHOD:req.method??'GET',CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:String(Buffer.concat(body).length),
    REMOTE_USER:'fixture',SERVER_PROTOCOL:'HTTP/1.1',SERVER_NAME:'127.0.0.1',SERVER_PORT:String((server.address() as any).port),
    HTTP_GIT_PROTOCOL:String(req.headers['git-protocol']??'')};
  const child=spawn('git',['http-backend'],{env,stdio:['pipe','pipe','pipe']});
  const output:Buffer[]=[];let stderr='';child.stdout.on('data',chunk=>output.push(Buffer.from(chunk)));child.stderr.on('data',chunk=>stderr+=String(chunk));
  child.on('error',error=>{res.writeHead(500);res.end(String(error));});
  child.on('close',code=>{
    const bytes=Buffer.concat(output),separator=bytes.indexOf('\r\n\r\n');
    if(code!==0||separator<0){res.writeHead(500);res.end(stderr||'git http-backend failed');return;}
    const headers=bytes.subarray(0,separator).toString('latin1').split('\r\n');
    let status=200;const forwarded:Record<string,string>= {};
    for(const line of headers){const colon=line.indexOf(':');if(colon<0)continue;const key=line.slice(0,colon).trim(),value=line.slice(colon+1).trim();if(key.toLowerCase()==='status')status=Number(value.split(' ')[0]);else forwarded[key]=value;}
    res.writeHead(status,forwarded);res.end(bytes.subarray(separator+4));
  });
  child.stdin.end(Buffer.concat(body));
});

try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}/private.git`;
  execFileSync('git',['-C',work,'remote','add','origin',url]);
  const env={...runnerGithubGitEnvironment(process.env,helper),PATH:`${bin}:${process.env.PATH??'/usr/bin:/bin'}`,GIT_ALLOW_PROTOCOL:'http'};
  await run('git',['-C',work,'push','-u','origin','main'],{env,encoding:'utf8',timeout:15_000});
  const cloned=join(root,'cloned');
  await run('git',['clone',url,cloned],{env,encoding:'utf8',timeout:15_000});
  assert.equal(execFileSync('git',['-C',cloned,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),execFileSync('git',['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).trim());
  assert(unauthorized>0,'fixture must challenge before accepting credentials');
  assert(authorized>0,'git push and clone must send the explicit GitHub credential helper credentials');
  console.log('runner-git-auth-check: isolated Git config retains gh credentials for authenticated push and clone');
}finally{
  server.close();rmSync(root,{recursive:true,force:true});
}
