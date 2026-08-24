import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { providerSessionFromEvent } from "../../../deployment-control/kernel/repair-agent";

describe("deployment repair provider runner", () => {
  test("accepts only an exact thread-started UUID", () => {
    const session = "123e4567-e89b-42d3-a456-426614174000";
    expect(providerSessionFromEvent({ type: "thread.started", thread_id: session })).toBe(session);
    expect(providerSessionFromEvent({ type: "thread.started", thread_id: "not-a-session" })).toBeNull();
    expect(providerSessionFromEvent({ type: "turn.started", thread_id: session })).toBeNull();
    expect(providerSessionFromEvent({ type: "thread.started", id: session, extra: "ignored" })).toBe(session);
  });

  test("durably admits a provider launch before either worker can spawn Codex", () => {
    for (const relative of [
      "deployment-control/kernel/repair-agent.ts",
      "deployment-control/kernel/review-agent.ts",
    ]) {
      const source = readFileSync(resolve(import.meta.dir, "../../..", relative), "utf8");
      expect(source.indexOf("provider_launch_begin")).toBeGreaterThan(0);
      expect(source.indexOf("provider_launch_begin")).toBeLessThan(source.indexOf("const child = Bun.spawn"));
    }
  });
});
