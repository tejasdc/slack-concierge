#!/usr/bin/env python3
"""Bounded native cooperative-close acceptance; external observer owns every latch and child."""
import pathlib,os,json,time,subprocess,tempfile,urllib.request,hashlib
ART=pathlib.Path(__file__).resolve().parent
START=time.monotonic();DEADLINE=START+90
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='wal9747-native-lifetime79-'))
HEADERS=pathlib.Path(os.environ['SQLITE_FIXTURE_HEADERS'])
assert (HEADERS/'sqlite3ext.h').exists() and (HEADERS/'sqlite3.h').exists(),'provide pinned SQLite extension headers for native witness'
SOURCES=[ART.parent/'src'/name for name in ['ledger-durability.ts','ledger-durability-worker.ts','ledger-checkpoint-protocol.ts','ledger-admission.ts']]
SOURCE_HASHES={str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in SOURCES}
def wait(predicate,label,seconds=14):
 end=min(time.monotonic()+seconds,DEADLINE)
 while not predicate():
  if time.monotonic()>end:raise RuntimeError('deadline '+label)
  time.sleep(.005)
def request(port,path,timeout=1):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=timeout) as response:return json.load(response)
for name,args in [('latch',['cc','-shared','-fPIC','-O2','-pthread',str(ART/'ledger-recycling-sync-latch.c'),'-ldl','-o',str(ROOT/'latch.so')]),
 ('witness',['cc','-shared','-fPIC','-O2','-I'+str(HEADERS),str(ART/'ledger-worker-close-witness.c'),'-o',str(ROOT/'close-witness.so')])]:
 build=subprocess.run(args,capture_output=True,text=True,timeout=15);(ROOT/(name+'.compile.txt')).write_text(build.stdout+build.stderr);assert build.returncode==0
results=[]
for mode in os.environ.get('LEDGER_NATIVE_CASES','forced-request,own-error,own-exit,caught-prime,lost-success,finalize-failure,close-refusal,uncaught-close-refusal,own-exit-close-refusal').split(','):
 root=ROOT/mode;root.mkdir();(root/'close-witness.so').symlink_to(ROOT/'close-witness.so')
 env={**os.environ,'LEDGER_LATCH_ROOT':str(root),'LEDGER_LATCH_DB':str(root/'state.db'),'LEDGER_NATIVE_MODE':mode,'LD_PRELOAD':str(ROOT/'latch.so')}
 out=(root/'stdout.txt').open('w');err=(root/'stderr.txt').open('w');port=None
 owner=subprocess.Popen(['/root/.bun/bin/bun','run',str(ART/'ledger-worker-lifetime-native.ts')],env=env,stdout=out,stderr=err)
 pings=[]
 def ping(label):
  result=request(port,'/ping');assert result['ok'] and result['forceCalls']==0;pings.append({'label':label,'result':result});return result
 try:
  wait(lambda:(root/'ready.json').exists(),'owner ready');ready=json.loads((root/'ready.json').read_text());port=ready['port'];ping('before cycle')
  (root/'armed').write_text('native checkpoint and primer latches')
  if mode=='own-exit-close-refusal':
   request(port,'/fault');wait(lambda:ping('exit-hook refusal pending')['gate']['phase']=='failed','exit hook retains uncertain ledger before destructive sweep')
   request(port,'/queue');held=ping('exit hook retains attached worker');assert held['queuedExecutions']==0
   count=held['pumpEntries'];time.sleep(1.05);held=ping('periodic pump while refused exit is retained');assert held['pumpEntries']>count
   assert not (root/(ready['workerId']+'.native-close')).exists() and not (root/'checkpoint.entered').exists()
   assert not any(row['message'].get('kind')=='ledger-closed' for row in json.loads((root/'messages.json').read_text()))
   (root/'exit-hook-held.json').write_text(json.dumps(held,indent=2))
   # No selective Worker.terminate is permitted while attached. This deliberately
   # unrecoverable private process is reaped as a whole after the fail-closed proof.
   owner.kill();owner.wait(timeout=3);assert owner.returncode==-9
   results.append({'mode':mode,'ready':ready,'pings':pings,'final':{'held':held,'nativeCloseCertificateAbsent':True,'destructiveSweepAbsent':True},
    'cleanup':{'forceCalls':held['forceCalls'],'wholeOwnedProcessReaped':True,'exit':owner.returncode},'exit':owner.returncode});continue
  if mode in ['own-error','own-exit','uncaught-close-refusal']:
   if mode=='uncaught-close-refusal':
    request(port,'/fault');wait(lambda:ping('uncaught close refusal pending')['gate']['phase']=='failed','uncaught close refuses without parent force')
    request(port,'/queue');held=ping('uncaught close refused');assert held['queuedExecutions']==0
    assert not (root/(ready['workerId']+'.native-close')).exists()
    # This case never ran RESTART: release the unused native latches before the
    # canonical owner's legitimate last-connection cleanup can reach them.
    for phase in ['checkpoint','header','receipt1','receipt2']:(root/(phase+'.release')).write_text('external owned cleanup release')
    request(port,'/stop',timeout=5);owner.wait(timeout=5);assert owner.returncode==0
    cleanup=json.loads((root/'cleanup.json').read_text());assert cleanup['forceCalls']==0 and cleanup['allCheckpointWorkersExited']
    results.append({'mode':mode,'ready':ready,'pings':pings,'final':{'closeRefused':True,'held':held},'cleanup':cleanup,'exit':owner.returncode});continue
   request(port,'/fault');wait(lambda:ping('own failure pending')['gate']['phase']=='maintenance','own-failure closed epoch');request(port,'/queue')
  else:request(port,'/cycle')
  wait(lambda:(root/'checkpoint.entered').exists(),'actual worker checkpoint fsync')
  held=ping('checkpoint held');assert held['gate']['phase']=='maintenance' and held['queuedExecutions']==0
  if mode in ['forced-request','close-refusal']:
   request(port,'/fault')
   if mode=='forced-request':
    count=ping('retirement request queued')['pumpEntries'];time.sleep(1.05)
    assert ping('actual periodic pump while retirement is queued')['pumpEntries']>count
   assert not (root/'UNSAFE.force').exists()
  (root/'checkpoint.release').write_text('external observer release')
  wait(lambda:(root/'header.entered').exists(),'actual primer header fsync',seconds=16)
  held=ping('primer header held');assert held['gate']['phase']=='maintenance' and held['queuedExecutions']==0
  (root/'header.release').write_text('external observer release')
  if mode=='close-refusal':
   wait(lambda:(root/'cycle.failed').exists(),'close refusal fails closed');held=ping('close refused')
   assert held['gate']['phase']=='failed' and held['queuedExecutions']==0
   assert not (root/(ready['workerId']+'.native-close')).exists(),'native destructor did not run on refused close'
   assert not any(row['message'].get('kind')=='ledger-closed' for row in json.loads((root/'messages.json').read_text()))
   final={'closeRefused':True,'held':held}
  else:
   wait(lambda:ping('cooperative recovery pending')['gate']['phase']=='serving','same-epoch recycle completes',seconds=16)
   assert ping('resumed original mutation')['queuedExecutions']==1
   request(port,'/next',timeout=4);final=json.loads((root/'next.complete').read_text());assert final['forceCalls']==0 and final['syncWorkers']==1
   assert (root/(ready['workerId']+'.native-close')).exists(),'old connection actually deallocated'
  request(port,'/stop',timeout=5);owner.wait(timeout=5);assert owner.returncode==0
  cleanup=json.loads((root/'cleanup.json').read_text());assert cleanup['forceCalls']==0 and cleanup['allCheckpointWorkersExited']
  results.append({'mode':mode,'ready':ready,'pings':pings,'final':final,'cleanup':cleanup,'exit':owner.returncode,
   'nativeCloseWitnesses':{p.name:p.read_text() for p in root.glob('*.native-close')},
   'checkpoint':(root/'checkpoint.entered').read_text(),'header':(root/'header.entered').read_text()})
  (ROOT/'partial.json').write_text(json.dumps(results,indent=2))
 finally:
  for phase in ['checkpoint','header','receipt1','receipt2']:(root/(phase+'.release')).write_text('external final cleanup release')
  if owner.poll() is None:
   try:request(port,'/stop',timeout=2)
   except Exception:pass
   try:owner.wait(timeout=3)
   except subprocess.TimeoutExpired:owner.kill();owner.wait(timeout=3)
  out.close();err.close()
assert SOURCE_HASHES=={str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in SOURCES},'tested source changed during native acceptance'
report={'root':str(ROOT),'results':results,'elapsedSeconds':time.monotonic()-START,'deadlineSeconds':90,'sourceHashes':SOURCE_HASHES,
 'headerHashes':{name:hashlib.sha256((HEADERS/name).read_bytes()).hexdigest() for name in ['sqlite3.h','sqlite3ext.h']},
 'scope':'Actual coordinator source body with only Worker import/paths substituted, real canonical Bun SQLite and original sync worker, actual checkpoint worker. Fault wrapper adds only controlled failures and native xDestroy witness; no product extension. External Python observes HTTP and owns all syscall releases/cleanup. Not whole application or production/power-loss acceptance.'}
(ROOT/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
