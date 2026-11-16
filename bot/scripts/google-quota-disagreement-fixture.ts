import assert from 'node:assert/strict';
import {googleQuotaDisagreement} from '../src/google-quota-disagreement';
import type {ProviderUsage,UsageWindow} from '../src/provider-account-usage';
import {Database} from 'bun:sqlite';
import {recordRepairNotice,pendingRepairNotices,repairNoticeText,markRepairNoticesDelivered} from '../src/repair-notices';

const now=Date.parse('2026-11-13T23:20:00Z'),at=new Date(now).toISOString();
const window=(name:string,usedPercent:number,resetsAt:string|null):UsageWindow=>({name,usedPercent,resetsAt,willLastToReset:null,runsOutAt:null});
const reading:ProviderUsage={observedAt:at,sourceRunner:'fixture-runner',problem:null,accounts:[{
  label:'fixture@example.test',plan:null,current:true,problem:null,readAt:at,windows:[
    window('Gemini · 5-hour',2.8,'2026-11-14T04:20:00Z'),
    window('Gemini · weekly',1,'2026-11-20T23:20:00Z'),window('Argon · weekly',100,null)]}]};
const context={model:'gemini-3.8-flash-high',account:'fixture@example.test',runner:'fixture-runner',
  dispatchObservedAt:'2026-11-13T23:19:50Z',refusalAt:'2026-11-13T23:19:59Z',error:'Individual quota reached.'};
const original=JSON.stringify(reading);
const room=googleQuotaDisagreement({...context,reading},now);
assert.equal(room.evidence.assessment,'room','unrelated exhausted Argon meter cannot hide true Flash room');
assert.equal(room.evidence.account,context.account);
assert.equal(room.evidence.model,context.model);
assert.equal(room.evidence.runner,context.runner);
assert.equal(room.evidence.refusalAt,context.refusalAt);
assert.equal(room.evidence.dispatchObservedAt,context.dispatchObservedAt);
assert.deepEqual(room.evidence.reading!.windows,reading.accounts[0]!.windows);
assert.equal(room.evidence.reading!.readAt,at);
assert.match(room.text,/reports room/);
for(const unavailable of [null,{observedAt:at,accounts:[],problem:'reader failed'},
  {...reading,problem:'runner unavailable'},
  {...reading,accounts:[{...reading.accounts[0]!,problem:'no verified allowance'}]},
  {...reading,accounts:[{...reading.accounts[0]!,readAt:'2026-11-13T23:00:00Z'}]},
  {...reading,accounts:[{...reading.accounts[0]!,windows:[]}]}] as (ProviderUsage|null)[]){
  const notice=googleQuotaDisagreement({...context,reading:unavailable},now);
  assert.equal(notice.evidence.assessment,'unavailable');
  assert.match(notice.text,/room is unknown/);
  assert.doesNotMatch(notice.text,/reports room|shows room/,'unknown must not become a false capacity claim');
}
const exhausted={...reading,accounts:[{...reading.accounts[0]!,windows:[
  window('Gemini · 5-hour',0,null),window('Gemini · weekly',100,null)]}]};
const noReset=googleQuotaDisagreement({...context,reading:exhausted},now);
assert.equal(noReset.evidence.assessment,'exhausted');
assert.equal(noReset.evidence.resetAt,null);
assert.match(noReset.text,/exhaustion without a usable reset/);
assert.doesNotMatch(noReset.text,/reports room|shows room/);
const changed=googleQuotaDisagreement({...context,reading:{...reading,accounts:[{...reading.accounts[0]!,label:'other@example.test'}]}},now);
assert.equal(changed.evidence.account,'fixture@example.test');
assert.equal(changed.evidence.reading!.account,'other@example.test','dispatch and post-refusal identities remain distinct');
assert.equal(changed.evidence.assessment,'unavailable','another account meter does not establish room for the refused account');
assert.equal(googleQuotaDisagreement({...context,account:'FIXTURE@EXAMPLE.TEST',reading},now).evidence.assessment,'room','normalized same account matches');
assert.equal(googleQuotaDisagreement({...context,reading:{...reading,sourceRunner:'other-runner'}},now).evidence.assessment,'unavailable');
assert.equal(googleQuotaDisagreement({...context,account:null,reading},now).evidence.assessment,'unavailable');
assert.equal(googleQuotaDisagreement({...context,model:null,reading},now).evidence.assessment,'unavailable');
assert.equal(googleQuotaDisagreement({...context,model:'unknown-model',reading},now).evidence.assessment,'unavailable');
assert.equal(googleQuotaDisagreement({...context,model:'gemini-4-argon-medium',reading},now).evidence.assessment,'exhausted');
assert.equal(JSON.stringify(reading),original,'diagnostic formatting cannot mutate the meter or admission state');
const db=new Database(':memory:');
try{
  const unknown=googleQuotaDisagreement({...context,reading:null},now);
  for(const [key,notice] of [['room',room],['unknown',unknown],['exhausted',noReset]] as const)
    assert.equal(recordRepairNotice(db,{key,kind:'usage_reading_disagrees',text:notice.text}),true);
  assert.equal(recordRepairNotice(db,{key:'room',kind:'usage_reading_disagrees',text:'replacement must not win'}),false);
  const retained=pendingRepairNotices(db);
  const deliveredText=repairNoticeText(retained,()=>at);
  for(const notice of [room,unknown,noReset])assert.ok(deliveredText.includes(JSON.stringify(notice.evidence)),
    'exact identity, meter and unknown-state evidence survives real repair-notice storage and delivery rendering');
  const unknownRow=retained.find(row=>row.key==='unknown')!;
  assert.doesNotMatch(unknownRow.text,/reports room|shows room/);
  assert.equal(JSON.parse(unknownRow.text.split('Evidence: ')[1]!).assessment,'unavailable');
  markRepairNoticesDelivered(db,retained.map(row=>row.key),'fixture-delivery');
  assert.equal(pendingRepairNotices(db).length,0,'existing notice custody and deduplication remain unchanged');
}finally{db.close();}
console.log('google-quota-disagreement-fixture: true room, unavailable/unknown reset, account/runner/family correspondence, exact evidence and disposable repair-notice storage/rendering passed; zero provider actions.');
