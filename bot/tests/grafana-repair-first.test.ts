import {test,expect} from 'bun:test';
import {db} from '../src/state';
import {acquireDatabaseTestLock} from './db-lock';
import {GrafanaAlerts} from '../src/grafana-alerts';
import {publishNativeGrafanaAlert} from '../src/grafana-native';
import {GRAFANA_CONDITIONS,GRAFANA_EXTERNAL_CONDITIONS} from '../src/grafana-webhook';
import {ensureTable,pendingRepairNotices,markRepairNoticesDelivered} from '../src/repair-notices';
import {SessionOwner} from '../src/session-owner';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('all native health alerts stay with their repair owner and never open a human Inbox thread',async()=>{
 const unlock=await acquireDatabaseTestLock();ensureTable(db);
 const inputs=()=>Number((db.query('SELECT count(*) AS n FROM session_inputs').get() as any).n);
 const events=()=>Number((db.query('SELECT count(*) AS n FROM session_owner_events').get() as any).n);
 const before=[inputs(),events()];let admitted=0;
 const service=new GrafanaAlerts({db,ownerId:'repair-first-test',destinationChannel:'native:inbox',isOwnerAlive:()=>true,
  publish:publishNativeGrafanaAlert,admit:()=>++admitted,wakeTurns(){},observe(){}});
 try{
  db.query('DELETE FROM grafana_alerts').run();db.query('DELETE FROM repair_notices').run();
  let n=1,ordinary=0;
  for(const condition of Object.keys(GRAFANA_CONDITIONS)){
   const alert={fingerprint:(n++).toString(16).padStart(16,'0'),condition,status:'firing' as const,startsAt:'2026-10-08T12:00:00.000Z',endsAt:null,omitted:0};
   service.accept([alert]);await service.settled();service.accept([alert]);await service.settled();
   service.accept([{...alert,status:'resolved',endsAt:'2026-10-08T12:05:00.000Z'}]);await service.settled();
   if(!GRAFANA_EXTERNAL_CONDITIONS.has(condition)&&!['TestAlert','ConciergeWebhookAcceptance'].includes(condition))ordinary++;
  }
  expect([inputs(),events()]).toEqual(before);expect(admitted).toBe(0);
  const notices=pendingRepairNotices(db);expect(notices).toHaveLength(0);
  expect((db.query("SELECT count(*) AS n FROM repair_notices WHERE resolved_at_ms IS NOT NULL AND delivered_input_id IS NULL").get() as any).n).toBe(ordinary);
  expect(notices.every(row=>row.kind==='grafana_alert')).toBe(true);
  
  markRepairNoticesDelivered(db,notices.map(row=>row.key),'fixture:standing-repair-input');
  expect(pendingRepairNotices(db)).toHaveLength(0);
 }finally{await service.stop();db.query('DELETE FROM grafana_alerts').run();db.query('DELETE FROM repair_notices').run();unlock();}
});

test('a delivered Grafana condition sends recovery through the same standing repair session',async()=>{
 const unlock=await acquireDatabaseTestLock();ensureTable(db);
 const directory=mkdtempSync(join(tmpdir(),'grafana-repair-delivery-'));
 mkdirSync(join(directory,'slack-concierge','.git'),{recursive:true});writeFileSync(join(directory,'slack-concierge','AGENTS.md'),'Fixture project');
 const owner=new SessionOwner({wake(){},available(){return true;},steer(){return false;},async stop(){return false;}},directory);
 let admitted=0;
 const service=new GrafanaAlerts({db,ownerId:'standing-repair-test',destinationChannel:'native:inbox',isOwnerAlive:()=>true,
  publish:publishNativeGrafanaAlert,admit:()=>++admitted,wakeTurns(){},observe(){}});
 const alert={fingerprint:'f'.repeat(16),condition:'ThinkeringBackupStale',status:'firing' as const,startsAt:'2026-10-08T12:00:00.000Z',endsAt:null,omitted:0};
 try{
  db.query('DELETE FROM grafana_alerts').run();db.query('DELETE FROM repair_notices').run();
  service.accept([alert]);await service.settled();
  expect(owner.deliverRepairNotices()).toBe(1);
  const first=db.query('SELECT delivered_input_id FROM repair_notices WHERE resolved_at_ms IS NULL').get() as any;
  const firstInput=db.query('SELECT session_id,origin FROM session_inputs WHERE id=?').get(first.delivered_input_id) as any;
  expect(firstInput.origin).toBe('service');
  service.accept([{...alert,status:'resolved',endsAt:'2026-10-08T12:05:00.000Z'}]);await service.settled();
  expect(pendingRepairNotices(db)).toHaveLength(1);expect(pendingRepairNotices(db)[0]!.text).toContain('Recovered');
  expect(owner.deliverRepairNotices()).toBe(1);
  const last=db.query("SELECT delivered_input_id FROM repair_notices WHERE key LIKE '%:resolved'").get() as any;
  expect((db.query('SELECT session_id FROM session_inputs WHERE id=?').get(last.delivered_input_id) as any).session_id).toBe(firstInput.session_id);
  expect(JSON.parse((db.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(firstInput.session_id) as any).native_metadata_json).repairAgent).toBe(true);
  service.accept([{...alert,status:'resolved',endsAt:'2026-10-08T12:05:00.000Z'}]);await service.settled();
  expect(owner.deliverRepairNotices()).toBe(0);expect(admitted).toBe(0);
  expect(db.query("SELECT 1 FROM session_inputs WHERE scope='service:provider-free-notice' AND action_id LIKE 'service-notice:grafana:%' LIMIT 1").get()).toBeNull();
 }finally{await service.stop();db.query('DELETE FROM grafana_alerts').run();db.query('DELETE FROM repair_notices').run();rmSync(directory,{recursive:true,force:true});unlock();}
});
