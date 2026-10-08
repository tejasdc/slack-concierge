import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='responsive-system-b1eed622')throw new Error('Scoped authorization required');
const [repository,ownerPort,session,queueToken]=process.argv.slice(2),require=createRequire(join(repository,'package.json'));
const {createServer}=await import(require.resolve('vite'));
const {default:react}=await import(require.resolve('@vitejs/plugin-react'));
const {chromium,expect}=require('@playwright/test');
await mkdir(join(repository,"tmp"),{recursive:true});
const fixtureDirectory=await mkdtemp(join(repository,"tmp/loaded-browser-"));
const wholeModule=join(fixtureDirectory,'whole.tsx');
await writeFile(wholeModule,`import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '/apps/web/src/app.tsx';
import {DiagnosticsProvider} from '/apps/web/src/diagnostics.tsx';
import {WorkspaceService} from '/packages/application/src/workspace-service.ts';
import {openBrowserWorkspaceRepository} from '/packages/adapters/src/browser-workspace.ts';
import {createTextUpdate} from '/packages/adapters/src/workspace-text.ts';
import '/apps/web/src/console.css';
import {retainedBrowserCommands} from '/packages/adapters/src/browser-command-custody.ts';
import {readSessionResource} from '/apps/web/src/session-cache-storage.ts';
window.fixture={retainedBrowserCommands,readSessionResource};
const namespace='whole-loaded-acceptance';
const repository=await openBrowserWorkspaceRepository({name:namespace,replication:null});
const service=new WorkspaceService(repository,{id:()=>crypto.randomUUID(),now:()=>new Date().toISOString(),initialEditorUpdate:createTextUpdate});
await service.open();
createRoot(document.getElementById('root')).render(<DiagnosticsProvider service={service}><App service={service} namespace={namespace} createPracticeWorkspace={async()=>{throw new Error('Outside acceptance scope');}}/></DiagnosticsProvider>);
`);
const gateway=require("fastify")();
gateway.decorateRequest("session",null);
gateway.addHook("onRequest",async request=>{request.session={get:()=> "device"};});
const loader=await createServer({configFile:false,root:repository,cacheDir:join(fixtureDirectory,'ssr-cache'),optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false}});
// Import the shipping adapter, including its cursor validation and durable command
// envelope. Only sign-in identity is synthetic; no user cookie or credential is used.
const {registerSessionOwnerRoutes,prepareOwnerMutation,deliverPreparedOwnerMutation}=await loader.ssrLoadModule('/packages/adapters/src/session-owner-routes.ts');
const {SessionOwnerClient}=await loader.ssrLoadModule('/packages/adapters/src/session-owner-client.ts');
const ownerClient=new SessionOwnerClient(`http://127.0.0.1:${ownerPort}`,{token:queueToken});
registerSessionOwnerRoutes(gateway,ownerClient,undefined,undefined,{endpoint:`http://127.0.0.1:${ownerPort}/commands`,token:queueToken});
gateway.post('/fixture/prepare',async(request,reply)=>{const command=request.body;
 try{return await prepareOwnerMutation(ownerClient,undefined,undefined,command.path,command.body,command.door);}
 catch(error){return reply.code(error.status??500).send({error:error.message});}
});
gateway.post('/fixture/deliver',async(request,reply)=>{const {command,prepared}=request.body;
 const result=await deliverPreparedOwnerMutation(ownerClient,command.path,prepared);return reply.code(result.status).send(result.value);
});
await gateway.listen({host:'127.0.0.1',port:0});
await fetch(`http://127.0.0.1:${ownerPort}/fixture/gateway`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port:gateway.server.address().port})});
const server=await createServer({configFile:false,root:repository,cacheDir:join(fixtureDirectory,'browser-cache'),optimizeDeps:{entries:[wholeModule]},plugins:[{name:'loaded-fixture',resolveId(id){if(id==='/whole-fixture.tsx')return wholeModule;if(id==='virtual:pwa-register')return id;},async load(id){if(id==='virtual:pwa-register')return 'export function registerSW(){return ()=>{}}';},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(!req.url?.startsWith('/agents'))return next();res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml(req.url,`<html><body><div id="root"></div><script type="module" src="/whole-fixture.tsx"></script></body></html>`));});}},react()],
 server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api/session-owner':`http://127.0.0.1:${gateway.server.address().port}`,'/fixture':`http://127.0.0.1:${ownerPort}`}},
 define:{__BUILD_ID__:JSON.stringify('loaded-fixture'),'import.meta.env.VITE_THINKERING_BUILD':JSON.stringify('loaded-fixture')}});
await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}/agents?sessionView=sessions&conversation=concierge%3A${session}`;
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']});
const exactContent='Full message Unicode 🙂 café\n'+'A complete retained sentence. '.repeat(20000)+'\nEXACT FULL MESSAGE END';
const detailBody=JSON.stringify({content:exactContent}),detailBytes=Buffer.byteLength(detailBody),detailDigest=createHash('sha256').update(detailBody).digest('hex');
let detailReads=0,corruptDetail=false;
// Synthetic retained bytes isolate the real browser controller, adapter verifier,
// renderer and clipboard from provider/storage behavior covered in other probes.
await context.route('**/api/session-owner/**/history**',async route=>{
 const requestUrl=new URL(route.request().url());
 if(requestUrl.pathname.endsWith('/messages/full-message-fixture/detail')){
  detailReads++;assert.equal(requestUrl.searchParams.get('digest'),detailDigest);assert.equal(requestUrl.searchParams.has('part'),false);
  return route.fulfill({status:200,contentType:'application/json',body:corruptDetail?detailBody.replace('café','cafe'):detailBody});
 }
 if(!requestUrl.pathname.endsWith('/history'))return route.continue();
 const response=await route.fetch(),value=await response.json();
 if(Array.isArray(value.messages))value.messages.push({id:'full-message-fixture',role:'assistant',content:'Retained preview only.',tool:null,phase:null,contentDetail:{digest:detailDigest,bytes:detailBytes,parts:Math.ceil(detailBytes/4096)}});
 return route.fulfill({response,json:value});
});
const errors=[];let page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
try{
 await fetch(`http://127.0.0.1:${ownerPort}/fixture/start-load`,{method:'POST'});
 const coldStarted=Date.now();await page.goto(url);
 const composer=()=>page.getByRole('textbox',{name:'Message agent',exact:true});
 await composer().waitFor();await page.getByText('prepared',{exact:true}).waitFor();
 const coldMs=Date.now()-coldStarted;
 await expect.poll(()=>page.evaluate(()=>window.fixture.readSessionResource('whole-loaded-acceptance','history:concierge:'+new URL(location.href).searchParams.get('conversation').split(':')[1]).then(value=>!!value?.loaded))).toBe(true);
 await page.evaluate(()=>{const observer=new MutationObserver(()=>{if(!document.querySelector('[role="log"]')?.textContent?.includes('Browser closure keeps these exact words.'))return;
  observer.disconnect();requestAnimationFrame(()=>window.fixture.paintedAt=performance.now());});observer.observe(document.body,{subtree:true,childList:true,characterData:true});});
 await composer().fill('Browser closure keeps these exact words.');
 const started=await page.evaluate(()=>performance.now());await composer().press('Enter');
 await page.getByRole('log').getByText('Browser closure keeps these exact words.',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.fixture.paintedAt>0);
 const paintMs=await page.evaluate(start=>window.fixture.paintedAt-start,started);assert.equal(await composer().inputValue(),'');
 await expect.poll(()=>page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()).then(state=>state.custody))).toBe('pending');
 const before=await page.evaluate(async()=>({server:await fetch('/fixture/state').then(r=>r.json()),commands:await window.fixture.retainedBrowserCommands()}));
 assert.equal(before.server.accepted,0);assert.equal(before.commands.length,1);assert.equal(before.commands[0].body.text,'Browser closure keeps these exact words.');
 await page.close();
 const restart=await fetch(`http://127.0.0.1:${ownerPort}/fixture/restart`,{method:'POST'}).then(response=>response.json());
 assert.ok(restart.beforePid&&restart.afterPid&&restart.beforePid!==restart.afterPid);
 page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
 // Keep the real resources unavailable while the reopened controller restores its own
 // catalogue/history and outbox. No fixture-written cache or pending-message DOM.
 await page.route('**/api/session-owner/**',route=>route.request().method()==='GET'?route.abort('failed'):route.continue());
 const warmStarted=Date.now();await page.goto(url);
 await composer().waitFor();await page.getByRole('log').getByText('Browser closure keeps these exact words.',{exact:true}).waitFor();
 await page.getByText('prepared',{exact:true}).waitFor();const warmCachedMs=Date.now()-warmStarted;
 const retained=await page.evaluate(()=>window.fixture.retainedBrowserCommands());assert.equal(retained.length,1);assert.equal(retained[0].actionId,before.commands[0].actionId);assert.equal(retained[0].sequence,before.commands[0].sequence);
 await page.screenshot({path:join(process.cwd(),'tmp/reviews/loaded-offline-reopen.png'),fullPage:true});
 await page.unroute('**/api/session-owner/**');
 await page.evaluate(()=>fetch('/fixture/release',{method:'POST'}));
 await expect.poll(()=>page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()).then(state=>({custody:state.custody,accepted:state.accepted}))),{timeout:10000}).toEqual({custody:'delivered',accepted:1});
 await expect.poll(()=>page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()).then(state=>state.providerObservation??state.providerFailure)),{timeout:10000}).toMatchObject({acknowledgements:1,exactText:true});
 await expect.poll(()=>page.evaluate(()=>window.fixture.retainedBrowserCommands())).toEqual([]);
 const after=await page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()));assert.equal(after.actionId,before.server.actionId);assert.equal(after.accepted,1);
 const notificationStarted=Date.now();
 const notificationHandled=await page.evaluate(async()=>{
  const channel=new MessageChannel();
  const handled=new Promise(resolve=>{channel.port2.onmessage=event=>resolve(event.data.handled===true);});
  navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'thnk:notification-open',
   path:location.pathname+'?sessionView=sessions&conversation='+encodeURIComponent(new URL(location.href).searchParams.get('conversation'))+'&message=fixture-message',
   title:'Synthetic notification',body:'Open the exact retained fixture message'},ports:[channel.port1]}));
  const result=await handled;channel.port1.close();channel.port2.close();return result;
 });
 assert.equal(notificationHandled,true);
 const target=page.locator('[data-message-id="fixture-message"][data-message-target="true"]');
 await expect(target).toBeInViewport();const notificationMs=Date.now()-notificationStarted;
 assert.equal(detailReads,0);
 const fullMessage=page.locator('[data-message-id="full-message-fixture"]');
 await fullMessage.getByRole('button',{name:'Read full message',exact:true}).click();
 await expect(fullMessage).toContainText('EXACT FULL MESSAGE END');assert.equal(detailReads,1);
 await page.screenshot({path:join(process.cwd(),"tmp/reviews/full-message-expanded.png")});
 await fullMessage.getByRole('button',{name:'Show preview',exact:true}).click();
 await expect(fullMessage).not.toContainText('EXACT FULL MESSAGE END');
 async function copyAction(label){await fullMessage.getByRole('button',{name:'Message actions',exact:true}).click();await fullMessage.locator('.session-message-menu').getByRole('button',{name:label,exact:true}).click();}
 await copyAction('Copy text');
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(exactContent);
 await fullMessage.getByRole('button',{name:'Show preview',exact:true}).click();
 await copyAction('Copy as quote');
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(exactContent.split('\n').map(line=>'> '+line).join('\n'));
 await fullMessage.getByRole('button',{name:'Show preview',exact:true}).click();
 corruptDetail=true;await fullMessage.getByRole('button',{name:'Read full message',exact:true}).click();
 await expect(fullMessage).toContainText('The full message could not be loaded. Try again.');
 await expect(fullMessage).not.toContainText('EXACT FULL MESSAGE END');
 assert.equal(detailReads,4);
 const fullMessageEvidence={kind:'full-message-browser',bytes:detailBytes,noEagerDetailRead:true,singleRequestPerExpansion:true,exactUnicodeCopy:true,exactQuote:true,corruptionRefused:true,detailReads,source:'synthetic retained bytes; real whole App, browser adapter, renderer and clipboard'};
 assert.deepEqual(errors,[]);
 const directory=join(process.cwd(),'tmp/reviews');await mkdir(directory,{recursive:true});const screenshot=join(directory,'loaded-whole-conversation.png');await page.screenshot({path:screenshot,fullPage:true});
 console.log(JSON.stringify({kind:'browser-boundary',fullMessageEvidence,engine:'Chromium on Linux',paintMs,coldMs,warmCachedMs,notificationMs,notification:'synthetic service-worker delivery; actual notification routing and exact-message viewport',restart,tabClosure:true,cachedViewWhileRefreshUnavailable:true,stableActionAndSequence:true,acceptedExactlyOnce:true,serverCustodyBeforeClosure:true,screenshot,productionGateway:true,wholeConversationController:true,authentication:'synthetic approved-device identity',providerObservation:after.providerObservation,providerAdmission:'fixture starts actual adapter after owner acceptance; normal queue coordinator is not exercised'}));
}catch(error){console.error(JSON.stringify({failure:String(error),page:await page.locator('body').innerText(),errors,commands:await page.evaluate(()=>window.fixture?.retainedBrowserCommands()),server:await page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()))}));throw error;}
finally{await browser.close();await server.close();ownerClient.close();await gateway.close();await loader.close();await rm(fixtureDirectory,{recursive:true,force:true});}
