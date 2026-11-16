import {PAGE_SESSIONS,usageBreakdownPage} from '../src/usage-breakdown-page';

// A week as large as the busiest one seen (1,546 conversations on 2026-11-16), three times over,
// with every field the full report carries, must reach the Accounts page under its 1 MiB read.
const raw=(n:number)=>({input:n,cacheWrite:n,cacheWrite1h:0,cacheRead:n*10,output:n});
const projection=(account:string,percent:number,complete=true)=>({usedPercent:percent,basis:'estimated',rawTokens:raw(1),callCount:3,
  components:[{provider:'codex',account,window:'Weekly',usedPercent:percent,currentPeriodPercent:percent/2,basis:'estimated',
    coverage:{from:'2026-11-10T00:00:00.000Z',through:'2026-11-16T00:00:00.000Z',observedDeltaPercent:10,transcriptWeighted:1,
      totalTranscriptWeighted:9,uncoveredTranscriptWeighted:0,complete,periods:1,otherProviderUseUnknown:true,bucketMinutes:15}}]});
const model=(name:string,weighted:number)=>({model:name,weighted,raw:raw(weighted),calls:4,helperWeighted:0,helperRaw:raw(0),helperCalls:0});
const sessions=(account:string,count:number)=>Array.from({length:count},(_,index)=>({sessionId:index,address:`concierge:${index}`,
  providerConversationId:`conversation-${account}-${index}`,title:`Session ${index}`,project:index%3?'thinkering':'slack-concierge',
  kind:'ordinary session',weighted:1000/(index+1),helperWeighted:0,share:0,raw:raw(index),
  cache:{callCount:9,flaggedCallCount:0,unknownCauseCount:0},unexplainedTopModelCalls:0,
  byModel:[model('gpt-6.1-sol',600/(index+1)),model('gpt-6-luna',400/(index+1))],
  byHelper:[{...model('gpt-6-luna',1),id:`helper-${index}`}],weeklyAllowance:projection(account,10/(index+1),index%7!==0)}));
const report={period:'week',since:'2026-11-09T00:00:00.000Z',through:'2026-11-16T00:00:00.000Z',timeZone:'America/New_York',
  computedAt:'2026-11-16T00:00:00.000Z',stale:false,callMix:{byModel:Array(50).fill({model:'x',calls:1})},
  cacheDiagnostics:{last48Hours:{callCount:5,expected:1,unexpected:2,unknown:2,byCause:{first_call:{calls:1,rewrittenInputTokens:9}},
    samples:Array(500).fill({callId:'x'.repeat(80)})}},byThread:Array(400).fill({topicId:'t',weeklyAllowance:projection('one',1)}),
  accounts:[{provider:'codex',account:'one',totalWeighted:1,raw:raw(1),byKind:[],bySession:sessions('one',3000)},
    {provider:'codex',account:'two',totalWeighted:1,raw:raw(1),byKind:[],bySession:sessions('two',2000)}]};

const page=usageBreakdownPage(report) as any;
const bytes=Buffer.byteLength(JSON.stringify(page));
const weighted=(value:any)=>value.accounts.reduce((total:number,account:any)=>total+account.bySession
  .reduce((sum:number,row:any)=>sum+row.weighted,0),0);
const named=page.accounts.flatMap((account:any)=>account.bySession.filter((row:any)=>row.address));
const smaller=page.accounts.flatMap((account:any)=>account.bySession.filter((row:any)=>row.kind==='smaller sessions'));
const restOfOne=report.accounts[0]!.bySession.filter(row=>!named.some((kept:any)=>kept.providerConversationId===row.providerConversationId));
const restAllowance=restOfOne.reduce((sum,row)=>sum+row.weeklyAllowance.components[0]!.usedPercent,0);
const foldedAllowance=page.accounts[0].bySession.filter((row:any)=>row.kind==='smaller sessions')
  .reduce((sum:number,row:any)=>sum+row.weeklyAllowance.components[0].usedPercent,0);
if(bytes>=1024*1024/2||named.length!==PAGE_SESSIONS||smaller.length!==4
  ||Math.abs(weighted(page)-weighted(report))>1e-6||Math.abs(foldedAllowance-restAllowance)>1e-6
  ||smaller.some((row:any)=>row.weeklyAllowance.components[0].coverage.complete!==false)
  ||page.sessionCount!==5000||page.byThread!==undefined||page.cacheDiagnostics.last48Hours.samples!==undefined)
  throw new Error(`usage page lost totals or outgrew its read: ${JSON.stringify({bytes,named:named.length,smaller:smaller.length})}`);
console.log(`usage page: 5000 conversations become ${named.length} named rows and ${smaller.length} folded rows in ${bytes} bytes with exact totals`);
