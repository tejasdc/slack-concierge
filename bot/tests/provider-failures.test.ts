import { describe, expect, test } from "bun:test";
import {
  classifyProviderDispatchFailure,
  isRefreshableAuthFailure,
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

describe("refreshable auth failure detection", () => {
  test("treats login-repairable auth failures as refreshable", () => {
    expect(isRefreshableAuthFailure("Failed to authenticate: OAuth session expired and could not be refreshed")).toBeTrue();
    expect(isRefreshableAuthFailure("401 Unauthorized")).toBeTrue();
    expect(isRefreshableAuthFailure("You are not logged in")).toBeTrue();
    expect(isRefreshableAuthFailure("credentials have expired")).toBeTrue();
  });

  test("excludes entitlement, billing, and admin-disabled-subscription failures", () => {
    expect(isRefreshableAuthFailure(
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    )).toBeFalse();
    expect(isRefreshableAuthFailure("Your billing account is past due")).toBeFalse();
    expect(isRefreshableAuthFailure("Entitlement not found for this workspace")).toBeFalse();
  });

  test("does not treat generic non-auth failures as refreshable", () => {
    expect(isRefreshableAuthFailure("API Error: 529 Overloaded")).toBeFalse();
    expect(isRefreshableAuthFailure("provider transport closed without a terminal result")).toBeFalse();
  });
});
