import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROVIDER_ALLOWED_ENVIRONMENT,
  buildApplicationCutoverPlan,
  claudeProjectDirectory,
  providerProjectRegistry,
  renderContainedBotDropIn,
  renderContainedKernelDropIn,
  renderProviderBrokerDropIn,
  renderProviderWorkerDropIn,
  rewriteWorkspacePath,
} from "../src/deployment-repair/application-cutover";

const channels = [{
  slack_channel_id: "C1",
  slack_channel_name: "project-a",
  code_path: "/root/workspace/project-a",
  vault_path: "/root/workspace/vault/projects/project-a",
  additional_paths: JSON.stringify(["/root/workspace/shared-a"]),
}, {
  slack_channel_id: "C2",
  slack_channel_name: "project-b",
  code_path: null,
  vault_path: "/root/workspace/vault/project-b",
  additional_paths: "[]",
}];

const sessions = [{
  id: 1,
  slack_channel_id: "C1",
  provider_id: "codex" as const,
  agent_session_uuid: "019fffff-0000-7000-8000-000000000001",
}, {
  id: 2,
  slack_channel_id: "C2",
  provider_id: "claude-code" as const,
  agent_session_uuid: "10000000-0000-4000-8000-000000000002",
}];

describe("application containment cutover", () => {
  test("derives one deterministic project authority per non-overlapping managed root", () => {
    const plan = buildApplicationCutoverPlan({ channels, sessions });
    expect(plan.projects).toHaveLength(2);
    const project = plan.projects.find((candidate) => candidate.slackChannelIds.includes("C1"))!;
    expect(project.stablePath).toBe("/var/lib/concierge-workspace/project-a");
    expect(project.stableAllowedPaths).toEqual([
      "/var/lib/concierge-workspace/project-a",
      "/var/lib/concierge-workspace/shared-a",
      "/var/lib/concierge-workspace/vault/projects/project-a",
    ]);
    expect(project.sessions).toEqual([{
      databaseId: 1,
      provider: "codex",
      uuid: "019fffff-0000-7000-8000-000000000001",
    }]);
    expect(providerProjectRegistry(plan).projects.find((candidate) => candidate.id === project.id)).toEqual({
      id: project.id,
      stable_path: project.stablePath,
      socket_path: project.socketPath,
      scratch_path: project.scratchPath,
      allowed_paths: project.stableAllowedPaths,
    });
  });

  test("rejects unmanaged and overlapping provider roots", () => {
    expect(() => buildApplicationCutoverPlan({
      channels: [{ ...channels[0], code_path: "/etc" }],
      sessions: [],
    })).toThrow("must be a child");
    expect(() => buildApplicationCutoverPlan({
      channels: [channels[0], {
        ...channels[1],
        code_path: "/root/workspace/project-a/nested",
      }],
      sessions: [],
    })).toThrow("roots overlap");
  });

  test("renders an uncredentialed broker and exact-project worker namespace", () => {
    const project = buildApplicationCutoverPlan({ channels: [channels[0]], sessions }).projects[0];
    const broker = renderProviderBrokerDropIn(project);
    const worker = renderProviderWorkerDropIn(project);
    expect(broker).toContain(`CONCIERGE_PROVIDER_PROJECT_ID=${project.id}`);
    expect(broker).toContain(`CONCIERGE_PROVIDER_AUTHORITY_ROOT=${project.authorityRoot}`);
    expect(broker).toContain("TemporaryFileSystem=/run/concierge-provider:ro");
    expect(broker).toContain(`BindReadOnlyPaths=${project.workerSocketPath}`);
    expect(broker.split("\n").filter((line) => line.startsWith("BindReadOnlyPaths="))).toEqual([
      `BindReadOnlyPaths=${project.workerSocketPath}`,
    ]);
    expect(broker).not.toContain("auth.json");
    expect(worker).toContain(`BindPaths=\"${project.sourcePath}:${project.stablePath}\"`);
    expect(worker).toContain(`BindPaths=\"${project.sourcePath}:${project.sourcePath}\"`);
    expect(worker).toContain("CONCIERGE_PROVIDER_CODEX_BIN=/usr/local/lib/concierge-deployment/codex");
    expect(broker).toContain(`CONCIERGE_DEPLOYMENT_INTENT_SOCKET=${project.scratchPath}/deployment-intent/intent.sock`);
    expect(worker).toContain(`CONCIERGE_DEPLOYMENT_INTENT_SOCKET=${project.scratchPath}/deployment-intent/intent.sock`);
    expect(worker).toContain("CONCIERGE_BUN_BIN=/usr/local/lib/concierge-deployment/bun");
    expect(worker).toContain(`CONCIERGE_REPO=${project.stablePath}`);
    for (const name of PROVIDER_ALLOWED_ENVIRONMENT) expect(worker).toContain(name);
    expect(readFileSync(resolve(import.meta.dir, "../scripts/deployment-repair/application-cutover.ts"), "utf8"))
      .toContain('run(["chmod", "3770", project.scratchPath])');
  });

  test("never exposes one project worker socket in a sibling broker namespace", () => {
    const projects = buildApplicationCutoverPlan({ channels, sessions }).projects;
    const first = renderProviderBrokerDropIn(projects[0]);
    const second = renderProviderBrokerDropIn(projects[1]);
    expect(first).toContain(`BindReadOnlyPaths=${projects[0].workerSocketPath}`);
    expect(first).not.toContain(projects[1].workerSocketPath);
    expect(first).not.toContain(`${projects[1].scratchPath}/deployment-intent/intent.sock`);
    expect(second).toContain(`BindReadOnlyPaths=${projects[1].workerSocketPath}`);
    expect(second).not.toContain(projects[0].workerSocketPath);
    expect(second).not.toContain(`${projects[0].scratchPath}/deployment-intent/intent.sock`);
  });

  test("renders a non-root bot that receives Slack only through systemd credentials", () => {
    const unit = renderContainedBotDropIn();
    expect(unit).toContain("User=concierge-bot");
    expect(unit).toContain("SupplementaryGroups=concierge-provider");
    expect(unit).toContain("CONCIERGE_STATE_DIR=/var/lib/concierge-bot/state");
    expect(unit).toContain("CONCIERGE_PROVIDER_BROKER_ENABLED=1");
    expect(unit).toContain("LoadCredential=slack_config:/root/.config/concierge/slack.toml");
    expect(unit).toContain('BindPaths="/root/workspace:/root/workspace"');
    expect(unit).toContain("InaccessiblePaths=/root/.codex /root/.claude");
    expect(unit).not.toContain("ExecStartPre=/root/.codex");
  });

  test("rebinds the protected kernel to the contained application database", () => {
    const unit = renderContainedKernelDropIn();
    expect(unit).toContain("CONCIERGE_APPLICATION_STATE_PATH=/var/lib/concierge-bot/state/state.db");
    expect(unit).toContain("CONCIERGE_CAPTURE_STATE_PATH=/var/lib/concierge-capture/state.db");
    expect(unit).toContain("ReadWritePaths=/var/lib/concierge-bot/state /var/lib/concierge-capture");
  });

  test("rewrites only paths inside the canonical workspace", () => {
    expect(rewriteWorkspacePath(
      "/root/workspace/project-a/file.ts",
      "/root/workspace",
      "/var/lib/concierge-workspace",
    )).toBe("/var/lib/concierge-workspace/project-a/file.ts");
    expect(rewriteWorkspacePath("/etc/passwd", "/root/workspace", "/var/lib/concierge-workspace"))
      .toBe("/etc/passwd");
    expect(claudeProjectDirectory("/var/lib/concierge-workspace/project-a"))
      .toBe("-var-lib-concierge-workspace-project-a");
  });
});
