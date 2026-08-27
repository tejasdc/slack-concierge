import { describe, expect, test } from "bun:test";
import { scopeSlackIdempotencyKey } from "../src/slack-idempotency";

describe("Slack idempotency scope", () => {
  test("preserves production identities and isolates fresh sandbox runs", () => {
    const key = "turn:1:outcome";
    expect(scopeSlackIdempotencyKey(key, {})).toBe(key);
    expect(scopeSlackIdempotencyKey(key, {
      CONCIERGE_RUNTIME_PROFILE: "sandbox",
      CONCIERGE_SANDBOX_RUN_ID: "20260827T050646Z-1005162-22742",
    })).toBe("sandbox:20260827T050646Z-1005162-22742:turn:1:outcome");
    expect(scopeSlackIdempotencyKey(key, {
      CONCIERGE_RUNTIME_PROFILE: "sandbox",
      CONCIERGE_SANDBOX_RUN_ID: "20260827T060000Z-2000000-42",
    })).not.toBe("sandbox:20260827T050646Z-1005162-22742:turn:1:outcome");
  });

  test("fails closed when a sandbox run has no safe namespace", () => {
    expect(() => scopeSlackIdempotencyKey("turn:1:outcome", {
      CONCIERGE_RUNTIME_PROFILE: "sandbox",
    })).toThrow("exact safe run ID");
  });
});
