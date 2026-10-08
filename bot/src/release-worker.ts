import {existsSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import declaration from './deployment-artifact-files.json';

const processEntry=process.argv[1]&&existsSync(process.argv[1])?realpathSync(process.argv[1]):process.argv[1]??"";
type WorkerName=Extract<keyof typeof declaration.controlBundles,`control/application/${string}.js`> extends `control/application/${infer Name}.js`?Name:never;
/** Resolve inside the application artifact, never the separately moving control link. */
export function releaseWorkerPath(name:WorkerName,entry=processEntry):string {
 const directory=dirname(resolve(entry));
 const root=resolve(directory,'../..');
 if(existsSync(join(root,'manifest.json'))){
  const destination=`control/application/${name}.js`;
  if(!declaration.applicationBundles.includes(destination)||!existsSync(join(root,destination)))
   throw new Error(`Application worker is absent from its sealed release: ${name}`);
  return join(root,destination);
 }
 const source=join(import.meta.dir,name+'.ts');
 if(existsSync(source))return source;
 throw new Error(`Application worker is unavailable: ${name}`);
}
