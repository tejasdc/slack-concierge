import {existsSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import declaration from './deployment-artifact-files.json';

const processEntry=process.argv[1]&&existsSync(process.argv[1])?realpathSync(process.argv[1]):process.argv[1]??"";
type WorkerName=Extract<keyof typeof declaration.controlBundles,`control/application/${string}.js`> extends `control/application/${infer Name}.js`?Name:never;
function sealedRoot(entry:string):string|null {
 const root=resolve(dirname(resolve(entry)),'../..');
 return existsSync(join(root,'manifest.json'))?root:null;
}
/** Resolve inside the application artifact, never the separately moving control link. */
export function releaseWorkerPath(name:WorkerName,entry=processEntry):string {
 const root=sealedRoot(entry);
 if(root){
  const destination=`control/application/${name}.js`;
  if(!declaration.applicationBundles.includes(destination)||!existsSync(join(root,destination)))
   throw new Error(`Application worker is absent from its sealed release: ${name}`);
  return join(root,destination);
 }
 const source=join(import.meta.dir,name+'.ts');
 if(existsSync(source))return source;
 throw new Error(`Application worker is unavailable: ${name}`);
}

/** The Codex bridge is an application artifact, not a sibling of a bundled worker. */
export function releaseCodexBridgePath(entry=processEntry):string {
 const root=sealedRoot(entry);
 if(root){
  const destination=join(root,'bot/src/codex-app-server-bridge.mjs');
  if(!existsSync(destination))throw new Error('Codex bridge is absent from its sealed release.');
  return destination;
 }
 const source=join(import.meta.dir,'codex-app-server-bridge.mjs');
 if(existsSync(source))return source;
 throw new Error('Codex bridge is unavailable.');
}
