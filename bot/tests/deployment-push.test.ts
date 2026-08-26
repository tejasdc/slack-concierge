import { expect, test } from "bun:test";
import { acceptGitHubDeploymentPush, type DeploymentPushServices } from "../src/deployment-push";

const lkg = "a".repeat(40);
const eventCommit = "b".repeat(40);
const currentMain = "c".repeat(40);

test("a push event fetches once and records the newest current main commit", async () => {
  const commands: string[][] = [];
  const observations: unknown[] = [];
  const ancestors = new Set([`${lkg}:${currentMain}`, `${eventCommit}:${currentMain}`]);
  const services: DeploymentPushServices = {
    git(arguments_) {
      commands.push(arguments_);
      if (arguments_[0] === "fetch") return { exitCode: 0, stdout: "", stderr: "" };
      if (arguments_[0] === "rev-parse" && arguments_[1] === "origin/main") {
        return { exitCode: 0, stdout: `${currentMain}\n`, stderr: "" };
      }
      if (arguments_[0] === "rev-parse") return { exitCode: 0, stdout: `${eventCommit}\n`, stderr: "" };
      const pair = `${arguments_[2]}:${arguments_[3]}`;
      return { exitCode: ancestors.has(pair) ? 0 : 1, stdout: "", stderr: "" };
    },
    getLastKnownGoodCommit: () => lkg,
    observe(input) {
      observations.push(input);
      return { state: { desired_commit: input.desiredCommit }, reason: "recorded" };
    },
  };
  const result = await acceptGitHubDeploymentPush({
    deliveryId: "delivery-b",
    repository: "tejasdc/slack-concierge",
    ref: "refs/heads/main",
    after: eventCommit,
  }, "/unused", services);

  expect(result).toEqual({
    desired_commit: currentMain,
    event_commit: eventCommit,
    observation: "recorded",
  });
  expect(commands.filter((command) => command[0] === "fetch")).toHaveLength(1);
  expect(observations).toHaveLength(1);
  expect((observations[0] as any).desiredCommit).toBe(currentMain);
});

test("a push that is outside current main ancestry is rejected without observation", async () => {
  let observed = false;
  const services: DeploymentPushServices = {
    git(arguments_) {
      if (arguments_[0] === "fetch") return { exitCode: 0, stdout: "", stderr: "" };
      if (arguments_[0] === "rev-parse" && arguments_[1] === "origin/main") {
        return { exitCode: 0, stdout: `${currentMain}\n`, stderr: "" };
      }
      if (arguments_[0] === "rev-parse") return { exitCode: 0, stdout: `${eventCommit}\n`, stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "not ancestor" };
    },
    getLastKnownGoodCommit: () => lkg,
    observe() {
      observed = true;
      return { state: { desired_commit: currentMain }, reason: "recorded" };
    },
  };
  await expect(acceptGitHubDeploymentPush({
    deliveryId: "delivery-b",
    repository: "tejasdc/slack-concierge",
    ref: "refs/heads/main",
    after: eventCommit,
  }, "/unused", services)).rejects.toThrow("not an ancestor");
  expect(observed).toBeFalse();
});
