import {db} from './state';
import type {ProviderId} from './state';

// The observed Codex refusals recurred 17 and 13 minutes apart on October 13.
// Remember each one for 20 minutes, then let a fresh attempt provide new evidence.
const CAPACITY_REFUSAL_MS = 20 * 60_000;

export function modelCapacityRefused(provider:ProviderId, model:string, now=Date.now()):boolean {
  const row=db.query('SELECT expires_at_ms FROM provider_model_capacity WHERE provider_id=? AND model=?')
    .get(provider,model) as {expires_at_ms:number}|null;
  return !!row&&row.expires_at_ms>now;
}

export function rememberModelCapacityRefusal(provider:ProviderId, model:string, now=Date.now()):void {
  db.query(`INSERT INTO provider_model_capacity(provider_id,model,refused_at_ms,expires_at_ms)
    VALUES(?,?,?,?) ON CONFLICT(provider_id,model) DO UPDATE SET
    refused_at_ms=excluded.refused_at_ms,expires_at_ms=excluded.expires_at_ms`)
    .run(provider,model,now,now+CAPACITY_REFUSAL_MS);
}

export function clearModelCapacityRefusal(provider:ProviderId, model:string):void {
  db.query('DELETE FROM provider_model_capacity WHERE provider_id=? AND model=?').run(provider,model);
}
