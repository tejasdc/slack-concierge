import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentLedgerImageCommand,inaccessibleDevice} from '../src/agent-ledger-image-boundary';
import {loopBackingFiles} from '../src/private-database-command';

function discover(ledger:string,image:string){return loopBackingFiles([ledger],path=>{
  if(path==='/proc/self/mountinfo')return `1 0 7:999 / ${ledger} rw - ext4 /dev/loop999 rw\n`;
  assert.equal(path,'/sys/block/loop999/loop/backing_file');return image+'\n';
});}
if(process.argv.includes('--masked-scratch')){
  const [ledger,image]=process.argv.slice(-2);
  assert(inaccessibleDevice(image!));assert.deepEqual(discover(ledger!,image!),[image]);
  console.log('PASS: discovered exact inherited mask retains its path');
}else{
  const root=mkdtempSync(join(tmpdir(),'private-wrapper-image-mask-'));
  try{
    const image=join(root,'image'),ledger=join(root,'ledger');mkdirSync(ledger);writeFileSync(image,'owned scratch');
    assert.deepEqual(discover(ledger,image),[image]);
    assert.throws(()=>discover(ledger,ledger),/Live store loop backing is not a file/);
    assert.throws(()=>discover(ledger,'/dev/null'),/Live store loop backing is not a file/);
    const protectedType='/run/systemd/inaccessible/chr';
    if(existsSync(protectedType)){
      assert(inaccessibleDevice(protectedType));assert.deepEqual(discover(ledger,protectedType),[protectedType]);
      console.log('PASS: protected 0:0 backing type retained (metadata only)');
    }else console.log('UNEXERCISED: protected backing type metadata; systemd inaccessible node absent');
    if(!process.argv.includes('--source-guard')){
      assert.equal(process.platform,'linux','Runtime acceptance requires Linux mount namespaces');
      const run=(command:string[],env=process.env)=>Bun.spawnSync(command,{env,stdout:'pipe',stderr:'pipe',timeout:15_000});
      const recognized=run(agentLedgerImageCommand([process.execPath,import.meta.path,'--masked-scratch',ledger,image],[image]));
      assert.equal(recognized.exitCode,0,recognized.stderr.toString());
      const home=join(root,'home'),state=join(home,'.local','state','concierge');mkdirSync(state,{recursive:true});
      writeFileSync(join(ledger,'state.db'),'owned scratch');symlinkSync(join(ledger,'state.db'),join(state,'state.db'));
      const bundle=join(root,'bundle');mkdirSync(bundle);
      const build=await Bun.build({entrypoints:[join(import.meta.dir,'private-code-command.ts')],target:'bun',outdir:bundle});
      assert(build.success,build.logs.map(String).join('\n'));
      const probe=`import os,sys,stat
print("child-started")
try:
 fd=os.open(sys.argv[1],os.O_RDONLY);os.close(fd)
except OSError as error:
 if error.errno not in (1,6,13): raise
else: raise RuntimeError("image mask opened")
for directory in sys.argv[2:]:
 assert stat.S_IMODE(os.stat(directory).st_mode)==0,directory
 try: assert os.listdir(directory)==[],directory
 except PermissionError: pass
print("image-denied; both-store-directories-masked")`;
      const checked=run(agentLedgerImageCommand([process.execPath,join(bundle,'private-code-command.js'),'--',
        '/usr/bin/python3','-c',probe,image,state,ledger],[image]),{...process.env,HOME:home});
      assert.equal(checked.exitCode,0,checked.stderr.toString());
      assert.match(checked.stdout.toString(),/child-started\nimage-denied; both-store-directories-masked/);
    }
    console.log(process.argv.includes('--source-guard')
      ?'PASS: regular backing retained and unsupported nonfiles refused (metadata-only source guard)'
      :'PASS: regular backing retained, unsupported nonfiles refused, inherited mask recognized and bundled scratch child isolated');
  }finally{rmSync(root,{recursive:true,force:true});}
}
