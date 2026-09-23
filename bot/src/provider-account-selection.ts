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
