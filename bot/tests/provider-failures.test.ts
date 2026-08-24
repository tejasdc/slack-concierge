import { describe, expect, test } from "bun:test";
import {
  classifyProviderDispatchFailure,
  providerRetryDelayMs,
} from "../src/provider-failures";

describe("provider dispatch failure classification", () => {
  test("classifies the observed overload and access failures explicitly", () => {
    expect(classifyProviderDispatchFailure(
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
    )).toBe("retryable");
    expect(classifyProviderDispatchFailure(
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    )).toBe("parked_access");
  });

  test("retries HTTP 429 and 5xx with bounded exponential backoff", () => {
    expect(classifyProviderDispatchFailure("HTTP 429 rate limit exceeded")).toBe("retryable");
    expect(classifyProviderDispatchFailure("HTTP 503 Service Unavailable")).toBe("retryable");
    expect(providerRetryDelayMs(1)).toBe(15_000);
    expect(providerRetryDelayMs(20)).toBe(30 * 60_000);
  });
});
