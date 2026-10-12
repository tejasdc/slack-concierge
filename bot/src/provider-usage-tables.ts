import type { AccountIdentityProvider } from "./provider-accounts";

// The original tables retain their installed CHECK constraints. Google uses additive tables,
// so a deployment never rebuilds an existing account or refusal snapshot.
export const accountUsageTable = (provider: AccountIdentityProvider) => provider === "antigravity"
  ? "antigravity_account_usage" : "provider_account_usage";

export const usageCacheTable = (provider: AccountIdentityProvider) => provider === "antigravity"
  ? "antigravity_usage_cache" : "provider_usage_cache";
