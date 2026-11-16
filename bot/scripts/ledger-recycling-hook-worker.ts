import '../src/ledger-durability-worker';
import {parentPort} from 'node:worker_threads';
// Disposable acceptance wrapper: production workers have no fault entrance.
parentPort!.on('message',message=>{
  if(message.kind==='fixture-own-error')throw Error('disposable checkpoint worker own-error exit');
  if(message.kind==='fixture-own-exit')process.exit(1);
});
