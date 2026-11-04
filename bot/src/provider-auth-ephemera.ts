import type {ProviderAccount} from './provider-accounts';

/** Volatile sign-in facts supplied by the one process that owns provider login flows. */
export type ProviderAuthEphemera=Readonly<{
  observedAtMs:number;
  checking:boolean;
  usageRefreshing:boolean;
  codexSignIn:'signed-in'|'signed-out'|'unknown';
  antigravityAccount:ProviderAccount|null;
  codexPending:boolean;
  claudePending:boolean;
  claudePendingFor:string|null;
  claudePendingUrl:string|null;
  accountFallback:Readonly<{codex:ProviderAccount|null;'claude-code':ProviderAccount|null}>;
  /** When a sign-in action on each other machine last finished, from the owner that carried it
   * (absent from an owner older than 2026-11-04); peer-account-answers.ts uses it. */
  peerAuthActedAtMs?:Readonly<Record<string,number>>;
  lastSignIn:Readonly<{
    codex:{ok:boolean;detail:string|null}|null;
    'claude-code':{ok:boolean;detail:string|null}|null;
  }>;
}>;
