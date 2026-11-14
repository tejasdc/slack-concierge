import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws-node';
import {CodexMutationChannel,mutationDigest} from '../src/codex-mutation-channel.mjs';
import {codexMutationOwnerGate} from '../src/codex-mutation-owner.mjs';
import {managedCodexInvocation} from '../src/codex-managed-launch-classifier';
export {managedCodexInvocation} from '../src/codex-managed-launch-classifier';

async function launch(native:string,argv:string[]){
  const invocation=managedCodexInvocation(argv);
  if(invocation.kind==='read')return await child(native,argv);
  if(invocation.kind==='proxy')return await proxy(native,argv,invocation.proxyIndex);
  const connectionId=randomUUID(),permitId=`${connectionId}:lifetime`;
  const params={argvDigest:mutationDigest(argv)};
  const identity={connectionId,permitId,intentId:permitId,threadId:invocation.threadId,
    method:'managed/cli-lifetime',paramsDigest:mutationDigest(params),params};
  const prepared:any=await codexMutationOwnerGate({phase:'prepare',...identity});
  if(!prepared?.allowed)throw new Error(prepared?.reason??'This Codex invocation conflicts with protected work.');
  const consumed:any=await codexMutationOwnerGate({phase:'consume',...identity});
  if(!consumed?.forward)throw new Error('This Codex invocation was already issued or refused.');
  // The lifetime intent is already durable before spawn. Register the exact child
  // immediately; failure leaves the intent outstanding and never replays the command.
  const nativeChild=Bun.spawn([native,...argv],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});
  let registration:any;
  try{registration=await codexMutationOwnerGate({phase:'register-process',...identity,pid:nativeChild.pid});}
  catch(error){nativeChild.kill();await nativeChild.exited;throw new Error(`Native Codex child registration is unconfirmed; its lifetime remains held: ${error instanceof Error?error.message:'owner unavailable'}`);}
  if(!registration?.registered){nativeChild.kill();await nativeChild.exited;throw new Error('Native Codex child registration was not confirmed; its lifetime remains held.');}
  const exitCode=await nativeChild.exited;
  const exitEvidenceDigest=mutationDigest({pid:nativeChild.pid,startTicks:registration.startTicks,exitCode,observedExit:true});
  const observed=await codexMutationOwnerGate({phase:'observed-exit',...identity,pid:nativeChild.pid,
    startTicks:registration.startTicks,exitCode,exitEvidenceDigest,responseDigest:exitEvidenceDigest});
  if(!observed?.observed)throw new Error('Native Codex child exit is not durably observed; its lifetime remains held.');
  return exitCode;
}
async function child(native:string,argv:string[]){return await Bun.spawn([native,...argv],{stdin:'inherit',stdout:'inherit',stderr:'inherit'}).exited;}

async function proxy(native:string,argv:string[],proxyIndex:number){
  const args=argv.slice();
  let nativeSocket=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'app-server-control/app-server-control.sock');
  for(let index=proxyIndex+1;index<args.length;index++){
    if(args[index]==='--sock'){
      if(!args[index+1])throw new Error('Native proxy --sock requires a path.');
      nativeSocket=args[index+1]!;args.splice(index,2);index--;
    }else if(args[index]?.startsWith('--sock=')){nativeSocket=args[index]!.slice(7);args.splice(index,1);index--;}
  }
  const root=mkdtempSync(join(tmpdir(),'concierge-codex-proxy-'));
  const socket=join(root,'proxy.sock'),server=createServer();
  const sockets=new Set<WebSocket>();
  const connectionId=randomUUID(),permitId=`${connectionId}:process`;
  const processParams={kind:'rawproxy',threadScope:'*',mediated:true};
  const processIdentity={connectionId,permitId,intentId:null,threadId:null,method:'managed/proxy-process',
    paramsDigest:mutationDigest(processParams),params:processParams};
  let markRegistered!:()=>void,markRegistrationFailed!:(error:unknown)=>void;
  const registered=new Promise<void>((resolve,reject)=>{markRegistered=resolve;markRegistrationFailed=reject;});
  registered.catch(()=>{});
  const websocket=new WebSocketServer({noServer:true});
  server.on('upgrade',(request,socket,head)=>websocket.handleUpgrade(request,socket,head,client=>websocket.emit('connection',client,request)));
  websocket.on('connection',(client:WebSocket)=>{
    const upstream=new WebSocket('ws://localhost/',{createConnection:()=>createConnection(nativeSocket),perMessageDeflate:false});
    sockets.add(client);sockets.add(upstream);
    const opened=new Promise<void>((resolve,reject)=>{upstream.once('open',resolve);upstream.once('error',reject);});
    // Attach the handler before the first Desktop frame; awaiting the native
    // connection happens inside the ordered channel rather than dropping frames.
    const channel=new CodexMutationChannel({gate:codexMutationOwnerGate,
      send:(frame:unknown)=>upstream.send(JSON.stringify(frame)),
      reject:(frame:any,reason:string,ambiguous:boolean)=>{
        if(!ambiguous&&Object.hasOwn(frame,'id'))client.send(JSON.stringify({id:frame.id,error:{code:-32001,message:reason}}));
        else{client.close(1011,'Mutation forwarding unconfirmed');upstream.close();}
      }});
    let incoming=Promise.resolve();
    client.on('message',data=>{incoming=incoming.then(async()=>{await registered;await opened;await channel.forward(JSON.parse(data.toString()));})
      .catch(()=>{channel.close();client.close(1011,'Invalid or unconfirmed mutation');upstream.close();});});
    upstream.on('message',data=>{
      try{void channel.response(JSON.parse(data.toString())).then(()=>{
        if(client.readyState===WebSocket.OPEN)client.send(data.toString());
      }).catch(()=>client.close(1011,'Mutation receipt unconfirmed'));}
      catch{client.close(1011,'Invalid native frame');}
    });
    for(const [source,peer] of [[client,upstream],[upstream,client]]){
      source.on('close',()=>{channel.close();sockets.delete(source);peer.close();});
      source.on('error',()=>{channel.close();source.close();peer.close();});
    }
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  args.push('--sock',socket);
  const nativeChild=Bun.spawn([native,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});
  let registration:any;
  try{registration=await codexMutationOwnerGate({phase:'register-process',...processIdentity,pid:nativeChild.pid});}
  catch{
    const failure=new Error('Native App Server proxy registration is unconfirmed; no frames will be forwarded.');
    markRegistrationFailed(failure);nativeChild.kill();await nativeChild.exited;
    for(const peer of sockets)peer.close();websocket.close();server.close();rmSync(root,{recursive:true,force:true});
    throw failure;
  }
  if(!registration?.registered){
    const error=new Error('Native App Server proxy registration was not confirmed; no frames will be forwarded.');
    markRegistrationFailed(error);nativeChild.kill();await nativeChild.exited;
    for(const peer of sockets)peer.close();websocket.close();server.close();rmSync(root,{recursive:true,force:true});
    throw error;
  }
  markRegistered();
  const code=await nativeChild.exited;
  const exitEvidenceDigest=mutationDigest({pid:nativeChild.pid,startTicks:registration.startTicks,exitCode:code,observedExit:true});
  const observed:any=await codexMutationOwnerGate({phase:'observed-exit',...processIdentity,pid:nativeChild.pid,
    startTicks:registration.startTicks,exitCode:code,exitEvidenceDigest,responseDigest:exitEvidenceDigest});
  if(!observed?.observed){
    for(const peer of sockets)peer.close();websocket.close();server.close();rmSync(root,{recursive:true,force:true});
    throw new Error('Native App Server proxy exit is not durably observed.');
  }
  for(const socket of sockets)socket.close();websocket.close();server.close();
  rmSync(root,{recursive:true,force:true});
  return code;
}

if(import.meta.main){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--capabilities'){
    console.log(JSON.stringify({protocol:'concierge-managed-codex-launch',version:1,
      mutationProtocol:1,proxy:'websocket',cli:'durable-lifetime',
      controlRoot:process.env.CONCIERGE_DEPLOYMENT_CONTROL_ROOT??null}));process.exit(0);
  }
  if(args[0]!=='--native'||!args[1]||!isAbsolute(args[1])||args[2]!=='--'){
    console.error('Usage: codex-launch --native ABSOLUTE_NATIVE_BINARY -- ORIGINAL_FULL_ARGV');process.exit(2);
  }
  try{process.exit(await launch(args[1],args.slice(3)));}
  catch(error){console.error(error instanceof Error?error.message:'Codex managed launch refused.');process.exit(1);}
}
