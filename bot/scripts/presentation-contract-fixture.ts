import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {observedDatabase,withStorageReadBudget,StorageReadBudgetError} from '../src/storage-observation';
import {presentationContractFor} from '../src/presentation-reader-contracts';

export function checkReaderRefusals(){
 const database=observedDatabase(new Database(':memory:'));
 database.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO sample VALUES(1,'kept'),(2,'also kept')");
 const budget={maxCalls:2,maxRows:1,maxResultBytes:128};
 const refused=(reason:string,read:()=>unknown)=>assert.throws(()=>withStorageReadBudget(budget,read),
  error=>error instanceof StorageReadBudgetError&&error.reason===reason);
 try{
  // These run without a surrounding observer deliberately: enforcement is intrinsic.
  refused('write_in_reader',()=>database.query('WITH selected AS (SELECT 1) DELETE FROM sample RETURNING id').get());
  assert.equal((database.query('SELECT COUNT(*) AS n FROM sample').get() as {n:number}).n,2);
  refused('unbounded_collection',()=>database.query('SELECT * FROM sample').all());
  refused('unbounded_collection',()=>database.query('SELECT * FROM sample LIMIT 2').iterate());
  refused('rows',()=>database.query('SELECT * FROM sample LIMIT 2').all());
  refused('calls',()=>{for(let index=0;index<3;index++)database.query('SELECT id FROM sample WHERE id=99').get();});
  refused('bytes',()=>database.query("SELECT printf('%200s','x') AS value").get());
  assert.equal(withStorageReadBudget(budget,()=>database.query('SELECT value FROM sample WHERE id=1').get())?.value,'kept');
  assert.equal(presentationContractFor('GET','/sessions/v1/presentation/new-feature'),null);
  assert.equal(presentationContractFor('GET','/sessions/v1/presentation/messages/a/b/detail')?.name,'messageDetail');
 }finally{database.close();}
}
if(import.meta.main){checkReaderRefusals();console.log('reader refusal checks passed');}
