import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {GrafanaAlerts} from '../src/grafana-alerts';
import type {GrafanaAlert} from '../src/grafana-webhook';

test('host and owner pressure retain native notices without admitting a second investigator',async()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE turns(id INTEGER PRIMARY KEY,turn_kind TEXT,status TEXT)');
 let admitted=0;const published:string[]=[];
 const alerts=new GrafanaAlerts({db,ownerId:'fixture',destinationChannel:'native:inbox',isOwnerAlive:()=>true,
  publish:async row=>{published.push(row.condition+':'+row.status);return 'service:fixture:'+row.fingerprint;},
  admit:()=>++admitted,wakeTurns:()=>{},observe:()=>{}});
 const pressure:GrafanaAlert={fingerprint:'a'.repeat(16),condition:'AX41ResourcePressure',startsAt:'2026-10-08T12:00:00.000Z',endsAt:null,status:'firing',omitted:0};
 try{
  alerts.accept([pressure]);await alerts.settled();
  alerts.accept([{...pressure,fingerprint:'b'.repeat(16),condition:'ConciergeDegraded'}]);await alerts.settled();
  expect(admitted).toBe(0);expect(published).toHaveLength(2);
  expect(alerts.row(pressure.fingerprint)?.investigation_episode).toBe(pressure.startsAt);
  alerts.accept([{...pressure,status:'resolved',endsAt:'2026-10-08T12:10:00.000Z'}]);await alerts.settled();
  alerts.accept([pressure]);await alerts.settled();
  expect(alerts.row(pressure.fingerprint)?.status).toBe('resolved');
  expect(db.query("SELECT fingerprint FROM grafana_alerts INDEXED BY grafana_condition_state WHERE condition='AX41ResourcePressure' AND status='firing' ORDER BY starts_at DESC LIMIT 1").get()).toBeNull();
  alerts.accept([{...pressure,fingerprint:'c'.repeat(16),condition:'ThinkeringBackupStale'}]);await alerts.settled();
  expect(admitted).toBe(1);
 }finally{await alerts.stop();db.close();}
});
