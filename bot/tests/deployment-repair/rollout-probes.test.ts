import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRolloutProbeEnvironment,
  RolloutProbeExporter,
  type RolloutProbeContext,
} from "../../../deployment-control/kernel/rollout-probes";

describe("root-owned deployment rollout probes", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("normalizes the service manager name before composing the systemd unit", () => {
    expect(defaultRolloutProbeEnvironment("/repository").serviceName).toBe("concierge-bot");
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "concierge-rollout-probes-"));
    roots.push(root);
    mkdirSync(join(root, "bot/src/deployment-repair"), { recursive: true });
    writeFileSync(
      join(root, "bot/src/deployment-repair/synthetic-fixture.ts"),
      'export const rolloutSyntheticFixtureStatus = "healthy" as "faulted" | "healthy";\n',
    );
    const commit = "a".repeat(40);
    const context: RolloutProbeContext = {
      rollout: { id: "11111111-1111-4111-8111-111111111111", identity_digest: "b".repeat(64) },
      gates: {
        status: "held",
        held_at: "now",
        deployment_held_at: "now",
        capture_held_at: "now",
      },
      identityDigest: "b".repeat(64),
      lastKnownGood: { id: "release", git_commit: commit },
      incident: { id: "incident", rollout_id: "11111111-1111-4111-8111-111111111111", status: "learning" },
      incidentAttempt: { status: "succeeded", deployed_commit: commit, service_invocation_id: "invocation" },
      repairRun: { provider_session_uuid: "repair-session", integrated_commit: commit },
      reviewRun: { status: "ship", provider_session_uuid: "review-session" },
      learning: { id: "learning", status: "recorded" },
      canaryActivation: null,
      canaryHandoff: null,
      productionActivation: null,
      productionHandoff: null,
      incidentNotifications: [],
    };
    const exporter = new RolloutProbeExporter({
      repositoryRoot: root,
      runtimeRoot: join(root, "runtime"),
      releaseRoot: join(root, "releases"),
      applicationStatePath: join(root, "application.db"),
      captureStatePath: join(root, "capture.db"),
      slackConfigPath: join(root, "slack.toml"),
      systemctlBin: "/unused/systemctl",
      systemdRunBin: "/unused/systemd-run",
      runuserBin: "/unused/runuser",
      curlBin: "/unused/curl",
      bunBin: "/unused/bun",
      serviceName: "concierge-bot",
    }, {} as any);
    return { exporter, context };
  }

  test("derives synthetic success only from one repaired, reviewed, deployed, learned incident", async () => {
    const { exporter, context } = fixture();
    await expect(exporter.run("synthetic_incident", context)).resolves.toMatchObject({
      incident_id: "incident",
      repair_session_uuid: "repair-session",
      review_session_uuid: "review-session",
      integrated_commit: "a".repeat(40),
      deployed_commit: "a".repeat(40),
      fixture_status: "healthy",
    });
    context.reviewRun.status = "no_ship";
    await expect(exporter.run("synthetic_incident", context)).rejects.toThrow("independent SHIP");
  });

  test("requires exactly one delivered deterministic rollback alert", async () => {
    const { exporter, context } = fixture();
    context.incidentNotifications = [{
      id: "notice",
      kind: "runtime_restored",
      status: "delivered",
      slack_ts: "123.456",
      client_msg_id: "client",
    }];
    await expect(exporter.run("contained_rollback_alert", context)).resolves.toMatchObject({
      notification_id: "notice",
      slack_ts: "123.456",
      duplicate_count: 0,
    });
    context.incidentNotifications.push({ ...context.incidentNotifications[0], id: "duplicate" });
    await expect(exporter.run("contained_rollback_alert", context)).rejects.toThrow("exactly one");
  });
});
