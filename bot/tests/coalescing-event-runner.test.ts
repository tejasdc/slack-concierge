import { expect, test } from "bun:test";
import { createCoalescingEventRunner } from "../src/coalescing-event-runner";

test("an event arriving during a pass always causes a follow-up pass", async () => {
  const reasons: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const runner = createCoalescingEventRunner<string>({
    run: async (reason) => {
      reasons.push(reason);
      if (reasons.length === 1) {
        firstStarted();
        await firstBlocked;
      }
    },
  });

  const active = runner.request("startup");
  await firstStartedPromise;
  runner.request("github-push");
  releaseFirst();
  await active;

  expect(reasons).toEqual(["startup", "github-push"]);
  expect(runner.active()).toBeNull();
});
