const MAX_TIMERS=128;
const MAX_OUTPUT_BYTES=256*1024;

type TimerRow={unit?:unknown;activates?:unknown;next?:unknown;last?:unknown};
function short(value:unknown):string|null {
  return typeof value==='string'&&value&&value!=='n/a'?value.slice(0,160):null;
}

/** Runs only in the isolated read executor. A missing host facility is an explicit view state. */
export async function hostTimerView() {
  if(process.platform!=='linux')return {status:'unavailable' as const,reason:'systemd timers are unavailable on this machine.',items:[]};
  let processHandle:ReturnType<typeof Bun.spawn>;
  try{processHandle=Bun.spawn(['systemctl','list-timers','--all','--output=json','--no-pager'],
    {stdout:'pipe',stderr:'ignore'});}catch{return {status:'unavailable' as const,reason:'systemctl is unavailable on this machine.',items:[]};}
  const timeout=setTimeout(()=>processHandle.kill(),3_000);
  try {
    const reader=processHandle.stdout.getReader();
    const chunks:Uint8Array[]=[];
    let bytes=0;
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_OUTPUT_BYTES){processHandle.kill();return {status:'unavailable' as const,reason:'The host timer list exceeded its read limit.',items:[]};}
      chunks.push(value);
    }
    if(await processHandle.exited!==0)return {status:'unavailable' as const,reason:'systemctl cannot list timers on this machine.',items:[]};
    const rows=JSON.parse(Buffer.concat(chunks).toString('utf8')) as TimerRow[];
    if(!Array.isArray(rows))throw new Error('Invalid timer list');
    return {status:'available' as const,reason:null,
      items:rows.slice(0,MAX_TIMERS).map(row=>({kind:'host timer' as const,name:short(row.unit),activates:short(row.activates),
        nextRun:short(row.next),lastRun:short(row.last)})),
      coverage:{complete:rows.length<=MAX_TIMERS,limit:MAX_TIMERS}};
  }catch{return {status:'unavailable' as const,reason:'systemctl returned an unreadable timer list.',items:[]};}
  finally{clearTimeout(timeout);}
}
