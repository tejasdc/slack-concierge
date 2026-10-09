import {lstat, readFile, unlink} from 'node:fs/promises';
import {createConnection} from 'node:net';

/** Never take a socket from another live owner, including one not yet listening. */
export async function removeUnboundSocket(path:string) {
  let original;
  try { original=await lstat(path); }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return; throw error; }
  if(!original.isSocket())throw new Error('The request API path is not a socket; refusing to replace it.');
  if(process.platform==='linux') {
    const entries=(await readFile('/proc/net/unix','utf8')).split('\n');
    if(entries.some(line=>line.match(/^\S+(?:\s+\S+){6}\s+(.+)$/)?.[1]===path))
      throw new Error('The request API already has a live listener.');
  } else {
    const listening=await new Promise<boolean>((resolve,reject)=>{
      const socket=createConnection(path);
      socket.once('connect',()=>{socket.destroy();resolve(true);});
      socket.once('error',(error:NodeJS.ErrnoException)=>{
        if(error.code==='ECONNREFUSED'||error.code==='ENOENT')resolve(false); else reject(error);
      });
    });
    if(listening)throw new Error('The request API already has a live listener.');
  }
  const current=await lstat(path);
  if(!current.isSocket()||current.dev!==original.dev||current.ino!==original.ino)
    throw new Error('The request API socket changed during startup; refusing to replace it.');
  await unlink(path);
}
