/** Every retry budget in Concierge has one named home. Both bounds are required. */
export type RetryPolicy = Readonly<{
  name: string;
  maxAttempts: number;
  baseDelayMs: number;
  capDelayMs: number;
  jitterFraction: number;
  maxAgeMs: number;
}>;

function policy(value: RetryPolicy): RetryPolicy {
  if (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1
    || !Number.isFinite(value.maxAgeMs) || value.maxAgeMs <= 0
    || !Number.isFinite(value.baseDelayMs) || value.baseDelayMs <= 0
    || !Number.isFinite(value.capDelayMs) || value.capDelayMs < value.baseDelayMs
    || !Number.isFinite(value.jitterFraction) || value.jitterFraction < 0 || value.jitterFraction > 1) {
    throw new Error(`Retry policy ${value.name} must have finite attempt, age, delay and jitter bounds.`);
  }
  return Object.freeze(value);
}

export const RETRY_POLICIES = Object.freeze({
  peerReply: policy({ name: "peer-reply", maxAttempts: 30, baseDelayMs: 1_000, capDelayMs: 60_000, jitterFraction: 0.25, maxAgeMs: 15 * 60_000 }),
  peerNotify: policy({ name: "peer-notify", maxAttempts: 12, baseDelayMs: 5_000, capDelayMs: 60_000, jitterFraction: 0.25, maxAgeMs: 15 * 60_000 }),
  peerRequest: policy({ name: "peer-request", maxAttempts: 15, baseDelayMs: 5_000, capDelayMs: 10 * 60_000, jitterFraction: 0.25, maxAgeMs: 60 * 60_000 }),
  providerRequest: policy({ name: "provider-request", maxAttempts: 5, baseDelayMs: 15_000, capDelayMs: 30 * 60_000, jitterFraction: 0.25, maxAgeMs: 2 * 60 * 60_000 }),
  providerCredentialProbe: policy({ name: "provider-credential-probe", maxAttempts: 3, baseDelayMs: 1_500, capDelayMs: 1_500, jitterFraction: 0, maxAgeMs: 45_000 }),
  externalHttp: policy({ name: "external-http", maxAttempts: 5, baseDelayMs: 5_000, capDelayMs: 15 * 60_000, jitterFraction: 0.25, maxAgeMs: 30 * 60_000 }),
  deployHealthProbe: policy({ name: "deploy-health-probe", maxAttempts: 3, baseDelayMs: 60_000, capDelayMs: 60 * 60_000, jitterFraction: 0.25, maxAgeMs: 2 * 60 * 60_000 }),
  captureDelivery: policy({ name: "capture-delivery", maxAttempts: 5, baseDelayMs: 1_000, capDelayMs: 30_000, jitterFraction: 0.25, maxAgeMs: 15 * 60_000 }),
  noticeDelivery: policy({ name: "notice-delivery", maxAttempts: 5, baseDelayMs: 5_000, capDelayMs: 15 * 60_000, jitterFraction: 0.25, maxAgeMs: 30 * 60_000 }),
  observer: policy({ name: "observer", maxAttempts: 5, baseDelayMs: 100, capDelayMs: 60_000, jitterFraction: 0.25, maxAgeMs: 5 * 60_000 }),
  ledgerWrite: policy({ name: "ledger-write", maxAttempts: 8, baseDelayMs: 50, capDelayMs: 1_000, jitterFraction: 0.25, maxAgeMs: 5_000 }),
  // An agent's helper call waiting out a Concierge restart (deploy stop to online took ~25 s on
  // 2026-10-07); the Stop hook's own 20-second limit gets the shorter one.
  ownerRestart: policy({ name: "owner-restart", maxAttempts: 14, baseDelayMs: 500, capDelayMs: 8_000, jitterFraction: 0.25, maxAgeMs: 90_000 }),
  ownerRestartInHook: policy({ name: "owner-restart-in-hook", maxAttempts: 8, baseDelayMs: 500, capDelayMs: 4_000, jitterFraction: 0.25, maxAgeMs: 15_000 }),
  // A host just started by its supervisor opening its socket (it does within a second).
  hostStart: policy({ name: "host-start", maxAttempts: 120, baseDelayMs: 50, capDelayMs: 250, jitterFraction: 0.25, maxAgeMs: 15_000 }),
  slackRateLimit: policy({ name: "slack-rate-limit", maxAttempts: 5, baseDelayMs: 5_000, capDelayMs: 15 * 60_000, jitterFraction: 0.25, maxAgeMs: 30 * 60_000 }),
});

/** An acknowledged response with the wrong schema is version skew, not a transport outage. */
export const PEER_REPLY_SCHEMA_MISMATCH_ATTEMPTS = 3;
export const PEER_REQUEST_ORPHAN_GRACE_MS = 10 * 60_000;

export const RETRY_POLICY_FOR_SITE = Object.freeze({
  provider: RETRY_POLICIES.providerRequest,
  deployment: RETRY_POLICIES.deployHealthProbe,
  peer: RETRY_POLICIES.peerRequest,
  notice: RETRY_POLICIES.noticeDelivery,
  capture: RETRY_POLICIES.captureDelivery,
  "codex-observer": RETRY_POLICIES.observer,
  slack: RETRY_POLICIES.slackRateLimit,
});
