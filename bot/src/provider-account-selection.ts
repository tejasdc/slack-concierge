import {db} from './state';

db.exec(`CREATE TABLE IF NOT EXISTS provider_account_selection (
  provider TEXT PRIMARY KEY CHECK(provider='claude-code'),
  profile_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
)`);

export function claudeAccountSelection():{profileId:string;label:string;revision:number}|null {
  const row=db.query("SELECT profile_id,account_label,revision FROM provider_account_selection WHERE provider='claude-code'").get() as {profile_id:string;account_label:string;revision:number}|null;
  return row?{profileId:row.profile_id,label:row.account_label,revision:row.revision}:null;
}

export function selectClaudeAccount(profileId:string,label:string):void {
  db.query(`INSERT INTO provider_account_selection(provider,profile_id,account_label,revision) VALUES('claude-code',?,?,1)
    ON CONFLICT(provider) DO UPDATE SET profile_id=excluded.profile_id,account_label=excluded.account_label,revision=revision+1`).run(profileId,label);
}

/**
 * Claude account homes proven to do real work (the account check, or a finished turn). Kept in the
 * ledger so a restart does not forget them: on 2026-10-07 a restart at 8:43 PM left the account
 * with room unproven, its new check took two minutes, and work kept failing on the full account.
 */
db.exec(`CREATE TABLE IF NOT EXISTS claude_home_proof (
  home TEXT PRIMARY KEY,
  proven_at_ms INTEGER NOT NULL
)`);
export function claudeHomeProven(home:string):boolean {
  return !!db.query('SELECT 1 FROM claude_home_proof WHERE home=?').get(home);
}
export function recordClaudeHomeProof(home:string,proven:boolean):void {
  if(proven)db.query('INSERT INTO claude_home_proof(home,proven_at_ms) VALUES(?,?) ON CONFLICT(home) DO UPDATE SET proven_at_ms=excluded.proven_at_ms').run(home,Date.now());
  else db.query('DELETE FROM claude_home_proof WHERE home=?').run(home);
}
