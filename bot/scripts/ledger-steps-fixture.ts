import assert from 'node:assert/strict';
import {enableLedgerAdmission, runLedgerSteps, runLedgerSegment, maintainLedger, assertLedgerSegment,ledgerCallback} from '../src/ledger-admission';

const latch=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
enableLedgerAdmission();
const external=latch(),finish=latch();
const events:string[]=[];
const operation=runLedgerSteps((function*(){
  assertLedgerSegment();events.push('before');
  try {yield external.promise;throw new Error('resume-error');}
  catch(error){assertLedgerSegment();events.push((error as Error).message);}
  finally {assertLedgerSegment();events.push('finally-before');yield Promise.resolve();assertLedgerSegment();events.push('finally-after');}
  return 42;
})());
const maintenance=maintainLedger(async()=>{events.push('maintenance');await finish.promise;});
external.release();
await new Promise<void>(resolve=>setImmediate(resolve));
assert.deepEqual(events,['before','maintenance']);
assert.throws(assertLedgerSegment,/NOT_ADMITTED/);
finish.release();await maintenance;
assert.equal(await operation,42);
assert.deepEqual(events,['before','maintenance','resume-error','finally-before','finally-after']);
await assert.rejects(runLedgerSteps((function*(){try{yield Promise.reject(new Error('outside'));}finally{assertLedgerSegment();events.push('reject-finally');}})()),/outside/);
const nested=await runLedgerSegment(()=>runLedgerSteps((function*(){assertLedgerSegment();return 7;})()) as never).catch(error=>String(error));
// An async driver cannot itself be the value of a synchronous operation.
assert.match(String(nested),/MUST_BE_SYNCHRONOUS/);
assert.equal(await runLedgerSteps((function*(){try{return 1;}finally{yield Promise.resolve();assertLedgerSegment();return 2;}})()),2);
const receiver={value:11,async operation(argument:number){return runLedgerSteps((function*(this:typeof receiver){
  const nested=async()=>runLedgerSteps((function*(){yield Promise.resolve();assertLedgerSegment();return argument;})());
  return this.value+(yield nested());
}).call(this));}};
assert.equal(await receiver.operation(5),16);
assert.equal(await ledgerCallback(function(this:typeof receiver,argument:number){assertLedgerSegment();return this.value+argument;}).call(receiver,7),18);
const streamed:number[]=[];
// This matches the production journal adapter: collect only original frame evidence
// outside admission; all decisions after collection resume inside the generator.
async function collect(){for await(const value of (async function*(){yield 3;yield 4;})())streamed.push(value);return streamed;}
assert.deepEqual(await runLedgerSteps((function*(){const values=yield collect();assertLedgerSegment();return values;})()),[3,4]);
console.log(JSON.stringify({fixture:'ledger-steps',result:'pass',properties:['lexical synchronous continuation','freeze holds resumed operation','throw and catch','finally across wait','yield rejection','return value','finally return override','receiver and lexical argument','nested async callback','callback receiver and arguments','isolated async iterator evidence']}));
