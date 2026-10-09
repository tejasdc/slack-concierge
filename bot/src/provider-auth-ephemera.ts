import type {ProviderAccount} from './provider-accounts';

/** Volatile sign-in facts supplied by the one process that owns provider login flows. */
export type ProviderAuthEphemera=Readonly<{
  observedAtMs:number;
  checking:boolean;
  usageRefreshing:boolean;
  codexSignIn:'signed-in'|'signed-out'|'unknown';
  codexPending:boolean;
  claudePending:boolean;
  claudePendingFor:string|null;
  claudePendingUrl:string|null;
  accountFallback:Readonly<{codex:ProviderAccount|null;'claude-code':ProviderAccount|null}>;
  lastSignIn:Readonly<{
    codex:{ok:boolean;detail:string|null}|null;
    'claude-code':{ok:boolean;detail:string|null}|null;
  }>;
}>;
