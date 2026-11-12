import {Database} from 'bun:sqlite';
import {strict as assert} from 'node:assert';
import {PreparedSearchIndex,type PreparedSearchDocument} from '../src/prepared-search';

const db=new Database(':memory:');
const search=new PreparedSearchIndex(db);
const document=(id:number,text:string):PreparedSearchDocument=>({key:`message:${id}`,sessionId:id,kind:'message',
 eventId:`id:${id}`,sourceId:`native:${id}`,sourceVersion:null,textHash:null,role:'assistant',text,at:null,ordinal:id});
search.upsert(document(1,'A small AI assistant handles 京都 and naïve questions.'));
search.upsert(document(2,'A different machine handles long threaded recordings.'));
assert.equal(search.search('AI',20).hits[0]?.sessionId,1);
assert.equal(search.search('京都',20).hits[0]?.sessionId,1);
assert.equal(search.search('ïv',20).hits[0]?.sessionId,1);
assert.equal(search.search('threaded recordings',20).hits[0]?.sessionId,2);
assert.deepEqual(search.search('ai handles',20).hits.map(hit=>hit.sessionId),[1],'a short term beside a long one is checked by rowid');
search.upsert(document(2,'Replaced words about bicycles.'));
assert.equal(search.search('threaded',20).hits.length,0);
assert.equal(search.search('bicycles',20).hits.length,1);
assert.throws(()=>db.transaction(()=>{search.upsert(document(2,'Rolled back changes'));throw Error('rollback');})());
assert.equal(search.search('bicycles',20).hits.length,1);
search.remove('message:2');
assert.equal(search.search('bicycles',20).hits.length,0);
search.upsert(document(3,'x'.repeat(8000)+' late exact match'));
const large=search.search('late exact',20).hits[0]!;
assert.equal(large.text.length,6000);assert.equal(large.truncated,true);
assert.ok(large.snippet.includes('late exact match'));
assert.equal(large.eventId,'id:3');
search.upsert({...document(4,'Private tool output'),role:'tool'});
assert.equal(search.search('Private',20).hits.length,0);
assert.equal(search.search('Private',20,true).hits.length,0,'tool evidence is searched in the archive index');
const fixture=(from:number,to:number)=>{
 for(let start=from;start<to;start+=250){
  db.transaction(()=>{
   for(let id=start;id<Math.min(to,start+250);id++)search.upsert(document(id,`Unrelated archival text number ${id}`));
  })();
  if(search.mergeDue)search.maintain(512);
 }
};
fixture(10,1010);
const small=search.search('naïve',20);
fixture(1010,10010);
const largeCorpus=search.search('naïve',20);
assert.equal(small.examined,1);assert.equal(largeCorpus.examined,1);
assert.deepEqual(small.hits,largeCorpus.hits);
const plan=db.query('EXPLAIN QUERY PLAN SELECT rowid FROM search_text WHERE search_text MATCH ? ORDER BY rowid DESC LIMIT ?')
 .all('"naïve"',201) as {detail:string}[];
assert.ok(plan.some(row=>/VIRTUAL TABLE INDEX.*M/.test(row.detail)),JSON.stringify(plan));
assert.ok(!plan.some(row=>/TEMP B-TREE/.test(row.detail)),JSON.stringify(plan));
const many=search.search('archival',2);assert.equal(many.hits.length,2);assert.equal(many.hasMore,true);
console.log(JSON.stringify({check:'prepared-search',status:'passed',unrelated_documents:10000,examined:largeCorpus.examined,plan}));
db.close();
