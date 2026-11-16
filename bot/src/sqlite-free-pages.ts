import type {Database} from 'bun:sqlite';
import {openSync,readSync,statSync} from 'node:fs';

/**
 * Returns the disk blocks behind a WAL database's free pages to the filesystem without
 * rewriting any live page. VACUUM would rewrite the whole file in one burst; on this host a
 * multi-gigabyte burst stalls the ledger's fsyncs (docs/incidents/2026-10-23-ledger-snapshot-
 * copy-stalled-the-owner.md). Punching holes is metadata-only I/O.
 *
 * Safety: SQLite never reads a free-list leaf page's content, and reuses one by writing it
 * whole. The caller must be the database's only writer. The list is read from the main file
 * only after a truncating checkpoint, inside a write transaction, with an empty WAL, so it is
 * exactly the committed free list and cannot change while holes are punched.
 */
const PUNCH_HOLE_KEEP_SIZE=0x02|0x01;
const PUNCHES_PER_PAUSE=2048,PUNCH_PAUSE_MS=20;
/** Bounds one call's hold on the write lock well under the worker's 10 s lease; the rest waits for the next call. */
const MAX_RANGES_PER_CALL=16_384;
type Fallocate=(fd:number,mode:number,offset:number,length:number)=>number;
let fallocate:Fallocate|null|undefined;
function loadFallocate():Fallocate|null {
 if(fallocate!==undefined)return fallocate;
 if(process.platform!=='linux')return fallocate=null;
 try {
  const {dlopen,FFIType}=require('bun:ffi') as typeof import('bun:ffi');
  const libc=dlopen('libc.so.6',{fallocate:{args:[FFIType.i32,FFIType.i32,FFIType.i64,FFIType.i64],returns:FFIType.i32}});
  return fallocate=(fd,mode,offset,length)=>Number(libc.symbols.fallocate(fd,mode,offset,length));
 } catch {return fallocate=null;}
}

export type FreePageRelease={released:true;pages:number;ranges:number;bytes:number;more:boolean}
 |{released:false;reason:'unsupported'|'checkpoint_busy'|'wal_not_empty'|'free_list_mismatch'|'punch_failed'};

/** Reads the committed free list: header bytes 32..39, then each trunk's leaf numbers. */
export function readFreeLeafPages(fd:number):{pageSize:number;leaves:number[];total:number;trunks:number} {
 const header=Buffer.alloc(100);readSync(fd,header,0,100,0);
 const rawSize=header.readUInt16BE(16),pageSize=rawSize===1?65536:rawSize;
 let trunk=header.readUInt32BE(32);const total=header.readUInt32BE(36);
 const leaves:number[]=[];let trunks=0;const page=Buffer.alloc(pageSize);
 while(trunk){
  if(++trunks>total)throw new Error('FREE_LIST_CYCLE');
  readSync(fd,page,0,pageSize,(trunk-1)*pageSize);
  const count=page.readUInt32BE(4);
  if(count>pageSize/4-2)throw new Error('FREE_LIST_TRUNK_INVALID');
  for(let index=0;index<count;index++)leaves.push(page.readUInt32BE(8+index*4));
  trunk=page.readUInt32BE(0);
 }
 return {pageSize,leaves,total,trunks};
}

/**
 * POSIX record locks belong to the process and are all dropped when ANY descriptor of the file
 * closes. Closing a second descriptor of the database would silently drop SQLite's own locks, so
 * another process could believe it is the last connection and reset the WAL under this one. The
 * descriptor is therefore opened once per file and kept for the life of the process.
 */
const descriptors=new Map<string,number>();
function descriptor(path:string){
 let fd=descriptors.get(path);
 if(fd===undefined){fd=openSync(path,'r+');descriptors.set(path,fd);}
 return fd;
}

/**
 * Where a partial release stopped, per file. The next call continues after it, so a bounded
 * call never re-walks holes it already punched; a complete pass starts over at page 1, which
 * also covers pages freed below the position meanwhile. Safety never depends on it: only pages
 * on the current free list are punched.
 */
const resumeAfter=new Map<string,number>();

export function releaseFreePages(db:Database,path:string,maxRanges=MAX_RANGES_PER_CALL):FreePageRelease {
 const punch=loadFallocate();
 if(!punch)return {released:false,reason:'unsupported'};
 const checkpoint=db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number;log:number};
 if(checkpoint.busy!==0)return {released:false,reason:'checkpoint_busy'};
 return db.transaction(():FreePageRelease=>{
  // Taking the write lock without writing keeps the WAL exactly as the checkpoint left it.
  let walSize=0;try{walSize=statSync(`${path}-wal`).size;}catch{}
  if(walSize!==0)return {released:false,reason:'wal_not_empty'};
  const fd=descriptor(path);
  {
   const {pageSize,leaves,total,trunks}=readFreeLeafPages(fd);
   if(leaves.length+trunks!==total)return {released:false,reason:'free_list_mismatch'};
   leaves.sort((a,b)=>a-b);
   let ranges=0,pages=0;
   const after=resumeAfter.get(path)??0;
   for(let index=0;index<leaves.length;){
    if(leaves[index]!<=after){index++;continue;}
    if(ranges>=maxRanges){resumeAfter.set(path,leaves[index-1]!);return {released:true,pages,ranges,bytes:pages*pageSize,more:true};}
    let end=index;while(end+1<leaves.length&&leaves[end+1]===leaves[end]!+1)end++;
    const first=leaves[index]!,count=end-index+1;
    if(punch(fd,PUNCH_HOLE_KEEP_SIZE,(first-1)*pageSize,count*pageSize)!==0)return {released:false,reason:'punch_failed'};
    ranges++;pages+=count;index=end+1;
    // Each hole is a journaled extent change on the ledger's filesystem; spread them out.
    if(ranges%PUNCHES_PER_PAUSE===0)Bun.sleepSync(PUNCH_PAUSE_MS);
   }
   resumeAfter.delete(path);
   return {released:true,pages,ranges,bytes:pages*pageSize,more:false};
  }
 }).immediate();
}

/** Bytes the filesystem actually holds for a file (holes excluded). */
export function allocatedBytes(path:string){try{return statSync(path).blocks*512;}catch{return 0;}}
