import {createRequire} from 'node:module';
import {join} from 'node:path';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='responsive-system-b1eed622')throw new Error('Scoped authorization required');
const [repository,ownerPort,session]=process.argv.slice(2),require=createRequire(join(repository,'package.json'));
const {createServer}=await import(require.resolve('vite'));
const {default:react}=await import(require.resolve('@vitejs/plugin-react'));
const {chromium,expect}=require('@playwright/test');
const moduleSource=`import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SessionComposer} from '/apps/web/src/session-composer.tsx';
import {useSendOutbox,deviceReceipts} from '/apps/web/src/session-send-outbox.ts';
import {sessionClient} from '/packages/adapters/src/browser-session-client.ts';
import {retainedBrowserCommands} from '/packages/adapters/src/browser-command-custody.ts';
import {readSessionResource,writeSessionResource} from '/apps/web/src/session-cache-storage.ts';
import '/apps/web/src/console.css';
const sessionId='concierge:${session}',drafts={conversations:[],text:new Map()};
window.fixture={retainedBrowserCommands,readSessionResource};
function App(){useSendOutbox();const [session,setSession]=useState(null),[cached,setCached]=useState(false);
 useEffect(()=>{void (async()=>{const retained=await readSessionResource('loaded','view');if(retained){setSession(retained);setCached(true);}const value=await sessionClient.view(sessionId);await writeSessionResource('loaded','view',value);setSession(value);})().catch(error=>{window.fixture.refreshError=String(error);});},[]);
 const receipts=deviceReceipts(sessionId);useEffect(()=>{if(receipts.length)requestAnimationFrame(()=>{window.fixture.paintedAt=performance.now();});},[receipts.length]);
 return <main style={{padding:24,maxWidth:700}}><h1>Loaded acceptance conversation</h1><output data-testid="cached">{cached?'cached':'fresh'}</output>
 {receipts.map(receipt=><article key={receipt.inputId} data-testid="pending-message"><p>{receipt.text}</p><p>{receipt.statusDetail.message}</p></article>)}
 {session?<SessionComposer session={session} namespace="loaded" drafts={drafts} disclosure={null} onClearReply={()=>{}} onAccepted={()=>{}} onCommand={async()=>{}}/>:<p>Opening conversation</p>}</main>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
await mkdir(join(repository,"tmp"),{recursive:true});
const fixtureDirectory=await mkdtemp(join(repository,"tmp/loaded-browser-"));
const fixtureModule=join(fixtureDirectory,"fixture.tsx");await writeFile(fixtureModule,moduleSource);
const server=await createServer({configFile:false,root:repository,plugins:[{name:'loaded-fixture',resolveId(id){if(id==='/loaded-fixture.tsx')return fixtureModule;if(id==='virtual:pwa-register')return id;},async load(id){if(id==='virtual:pwa-register')return 'export function registerSW(){return ()=>{}}';},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/loaded-fixture.html')return next();res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml(req.url,'<html><body><div id="root"></div><script type="module" src="/loaded-fixture.tsx"></script></body></html>'));});}},react()],
 server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api/session-owner':`http://127.0.0.1:${ownerPort}`,'/fixture':`http://127.0.0.1:${ownerPort}`}},
 define:{__BUILD_ID__:JSON.stringify('loaded-fixture'),'import.meta.env.VITE_THINKERING_BUILD':JSON.stringify('loaded-fixture')}});
await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}/loaded-fixture.html`;
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:900}});
const errors=[];let page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
try{
 await page.goto(url);await page.getByRole('textbox',{name:'Message agent',exact:true}).waitFor();
 await page.evaluate(()=>fetch('/fixture/start-load',{method:'POST'}));
 await page.getByRole('textbox',{name:'Message agent',exact:true}).fill('Browser closure keeps these exact words.');
 const started=await page.evaluate(()=>performance.now());await page.getByRole('textbox',{name:'Message agent',exact:true}).press('Enter');
 await page.getByTestId('pending-message').waitFor();
 await page.waitForFunction(()=>window.fixture.paintedAt>0);
 const paintMs=await page.evaluate(start=>window.fixture.paintedAt-start,started);
 assert.equal(await page.getByRole('textbox',{name:'Message agent',exact:true}).inputValue(),'');
 await expect.poll(()=>page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()).then(state=>state.custody))).toBe('pending');
 const before=await page.evaluate(async()=>({server:await fetch('/fixture/state').then(r=>r.json()),commands:await window.fixture.retainedBrowserCommands()}));
 console.error('before-close '+JSON.stringify(before));
 assert.equal(before.server.accepted,0);assert.equal(before.commands.length,1);assert.equal(before.commands[0].body.text,'Browser closure keeps these exact words.');
 await page.close();page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
 await page.route('**/api/session-owner/sessions/*/view',route=>route.abort('failed'));
 await page.goto(url);await page.getByTestId('pending-message').waitFor();assert.equal(await page.getByTestId('cached').innerText(),'cached');
 const commands=await page.evaluate(()=>window.fixture.retainedBrowserCommands());assert.equal(commands.length,1);assert.equal(commands[0].actionId,before.commands[0].actionId);assert.equal(commands[0].sequence,before.commands[0].sequence);
 await page.evaluate(()=>fetch('/fixture/release',{method:'POST'}));
 await expect.poll(()=>page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()).then(state=>({custody:state.custody,accepted:state.accepted}))),{timeout:10000}).toEqual({custody:'delivered',accepted:1});
 console.error('owner-accepted '+JSON.stringify(await page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()))));
 await page.getByTestId('pending-message').waitFor({state:'hidden'});
 assert.deepEqual(await page.evaluate(()=>window.fixture.retainedBrowserCommands()),[]);
 const after=await page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()));assert.equal(after.actionId,before.server.actionId);assert.equal(after.accepted,1);
 // The deliberately refused view refresh is exercised by this fixture wrapper, which
 // records it rather than allowing an unhandled promise rejection from the wrapper.
 assert.deepEqual(errors,[]);
 const directory=join(process.cwd(),'tmp/reviews');await mkdir(directory,{recursive:true});const screenshot=join(directory,'loaded-browser-boundary.png');await page.screenshot({path:screenshot,fullPage:true});
 console.log(JSON.stringify({kind:'browser-boundary',engine:'Chromium on Linux',paintMs,tabClosure:true,cachedViewWhileRefreshUnavailable:true,stableActionAndSequence:true,acceptedExactlyOnce:true,serverCustodyBeforeClosure:true,screenshot,productionGateway:false,providerObservation:false}));
}catch(error){console.error(JSON.stringify({failure:String(error),page:await page.locator('body').innerText(),errors,commands:await page.evaluate(()=>window.fixture?.retainedBrowserCommands()),server:await page.evaluate(()=>fetch('/fixture/state').then(r=>r.json()))}));throw error;}
finally{await browser.close();await server.close();await rm(fixtureDirectory,{recursive:true,force:true});}
