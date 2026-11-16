import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {isMainThread,threadId,workerData} from 'node:worker_threads';
import {logToStderr} from './log';

export function nativeIdentity(platform = process.platform, read = (path:string) => readFileSync(path, 'utf8')) {
  if (platform !== 'linux') return {nativeStatus:'unsupported',nativeTid:null,processStartTicks:null,threadStartTicks:null,bootId:null};
  try {
    const parse = (value:string) => {
      const end=value.lastIndexOf(')');
      const tid=Number(value.slice(0,value.indexOf(' ')));
      const start=value.slice(end+2).trim().split(/\s+/)[19];
      if(end<0 || !Number.isSafeInteger(tid) || tid<1 || !start || !/^\d+$/.test(start)) throw new Error('invalid proc stat');
      return {tid,start};
    };
    const task=parse(read('/proc/thread-self/stat'));
    const processStat=parse(read('/proc/self/stat'));
    return {nativeStatus:'available',nativeTid:task.tid,processStartTicks:processStat.start,
      threadStartTicks:task.start,bootId:read('/proc/sys/kernel/random/boot_id').trim()};
  } catch {
    // Diagnostics must never prevent a worker from doing its real work.
    return {nativeStatus:'unavailable',nativeTid:null,processStartTicks:null,threadStartTicks:null,bootId:null};
  }
}

// Imported first, before dependencies can open SQLite. Keep identity off the work protocol:
// older clients count unknown messages as work results.
export const sqliteWorkerIdentity = isMainThread ? null : {
  pid:process.pid,threadId,script:basename(Bun.main),
  role:basename(Bun.main).replace(/\.(ts|js)$/, '') + (typeof workerData?.role === 'string' ? ':'+workerData.role : ''),
  generation:randomUUID(),...nativeIdentity(),
};
if(sqliteWorkerIdentity) logToStderr('info','sqlite_worker_identity',sqliteWorkerIdentity);
