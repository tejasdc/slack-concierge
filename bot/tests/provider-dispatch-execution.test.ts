import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderDispatchError } from "../src/provider-failures";
import type { AgentProvider } from "../src/providers";
import { TurnSteeringController } from "../src/steering";
import { executeAgentTurn, type TurnExecutionServices } from "../src/turn-execution";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimTurnStatusProjection,
  createOrGetSession,
  db,
  getChannel,
  getTurnStatusProjection,
  markTurnStatusProjectionDelivered,
  recordTurnStatusMessage,
  requestTurnStatusProjection,
  resumeParkedSessionTurn,
  upsertChannel,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
  projectDir = mkdtempSync(join(tmpdir(), "concierge-provider-retention-"));
  upsertChannel({
    slack_channel_id: "C1",
    slack_channel_name: "slack-inbox",
    group_name: null,
    name: "Slack Inbox",
    vault_path: projectDir,
    code_path: projectDir,
    provider_default: "claude-code",
  });
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

async function projectTurnStatus(client: any, turnId: number, text: string) {
  requestTurnStatusProjection(turnId, text);
  const projection = claimTurnStatusProjection(turnId, Date.now());
  if (!projection) return "permanent_failure" as const;
  if (projection.slack_status_msg_ts) {
    await client.chat.update({ ts: projection.slack_status_msg_ts, text: projection.desired_text });
  } else {
    const posted = await client.chat.postMessage({
      thread_ts: projection.slack_thread_ts,
      text: projection.desired_text,
    });
    recordTurnStatusMessage(turnId, projection.message_generation, posted.ts);
  }
  markTurnStatusProjectionDelivered(turnId, projection.desired_revision);
  return "delivered" as const;
}

async function runObservedFailure(message: string, options: {
  acceptedSteering?: boolean;
  boundProviderSessionId?: string;
  terminalConfirmed?: boolean;
  untagged?: boolean;
} = {}) {
  const session = createOrGetSession("C1", "root", "claude-code");
  if (options.boundProviderSessionId) {
    db.query("UPDATE sessions SET agent_session_uuid=? WHERE id=?")
      .run(options.boundProviderSessionId, session.id);
    session.agent_session_uuid = options.boundProviderSessionId;
  }
  const turn = acquireSessionTurn(session.id, "message", "preserve me", "runtime-1", undefined, "root");
  if (options.acceptedSteering) {
    db.query(`INSERT INTO turn_steering_messages (
      turn_id, slack_user_msg_ts, user_text, replay_text, status, provider_sent_at
    ) VALUES (?, 'steering-message', 'change direction', 'change direction', 'sent', CURRENT_TIMESTAMP)`)
      .run(turn.id);
  }
  const client = {
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    chat: {
      postMessage: async () => ({ ok: true, ts: "status-message" }),
      update: async () => ({ ok: true }),
    },
  };
  const provider: AgentProvider = {
    id: "claude-code",
    async run() {
      if (options.untagged) throw new Error(message);
      throw new ProviderDispatchError({
        message,
        terminalConfirmed: options.terminalConfirmed ?? true,
        toolsUsed: [],
        providerSessionId: "provider-session",
      });
    },
    async fork() { throw new Error("not used"); },
  };
  const services: TurnExecutionServices = {
    hydrateLegacyThreadOwnership: async () => 0,
    deliverOutcome: async () => "delivered",
    projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
    projectThreadSummary: async () => "delivered",
    scheduleTurnStatusProjection: (_client, turnId) => projectTurnStatus(client, turnId, getTurnStatusProjection(turnId).desired_text),
    scheduleWorkingReactionCleanup: async () => {},
    scheduleCanvasRefreshIfChanged: () => {},
  };
  const steeringController = new TurnSteeringController();
  const outcome = await executeAgentTurn({
    turnId: turn.id,
    session,
    channel: getChannel("C1"),
    channelId: "C1",
    threadTs: "root",
    userMsgTs: "message",
    user: "U1",
    text: "preserve me",
    prompt: "preserve me",
    files: [],
    client,
    provider,
    providerId: "claude-code",
    providerLabel: "Claude Code",
    sessionThreadTs: "root",
    sessionMode: "per-thread",
    hydrateSlackLinks: false,
    cwd: projectDir,
    additionalDirs: [],
    botToken: "test-token",
    ownerInstanceId: "runtime-1",
    turnKind: "slack_user",
    dispatchAttempt: turn.dispatchAttempt,
    steeringController,
    closeSteering: (reason) => steeringController.close(reason),
    services,
  });
  return { outcome, turnId: turn.id };
}

describe("provider dispatch execution retention", () => {
  test("requeues the observed Claude 529 instead of terminalizing the input", async () => {
    const { outcome, turnId } = await runObservedFailure(
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
    );
    expect(outcome).toEqual({ status: "retry_queued", turnId });
    expect(db.query(`SELECT status, dispatch_failure_class, owner_instance_id,
                            provider_admission_intended_at IS NOT NULL AS admitted
                     FROM turns WHERE id=?`).get(turnId)).toEqual({
      status: "queued",
      dispatch_failure_class: "retryable",
      owner_instance_id: null,
      admitted: 1,
    });
    expect(getTurnStatusProjection(turnId).desired_text).toContain("input preserved and retrying automatically");
  });

  test("parks the observed subscription failure with a resumable turn id", async () => {
    const { outcome, turnId } = await runObservedFailure(
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    );
    expect(outcome).toEqual({ status: "provider_parked", turnId });
    expect(db.query("SELECT status, dispatch_failure_class, owner_instance_id FROM turns WHERE id=?")
      .get(turnId)).toEqual({
        status: "parked",
        dispatch_failure_class: "parked_access",
        owner_instance_id: null,
      });
    expect(getTurnStatusProjection(turnId).desired_text).toContain(`input preserved as turn ${turnId}`);
  });

  test("parks but blocks replay when accepted steering makes the provider attempt non-representable", async () => {
    const { outcome, turnId } = await runObservedFailure(
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary.",
      { acceptedSteering: true },
    );

    expect(outcome).toEqual({ status: "provider_parked", turnId });
    expect(db.query("SELECT status, dispatch_failure_class FROM turns WHERE id=?").get(turnId))
      .toEqual({ status: "parked", dispatch_failure_class: "parked_ambiguous" });
    expect(getTurnStatusProjection(turnId).desired_text).toContain("replay is blocked until reconciled");
    expect(resumeParkedSessionTurn(turnId)).toBe("unsafe");
  });

  test("parks but blocks replay when a post-admission provider error is untagged", async () => {
    const { outcome, turnId } = await runObservedFailure(
      "provider transport closed without a terminal result",
      { untagged: true },
    );

    expect(outcome).toEqual({ status: "provider_parked", turnId });
    expect(db.query("SELECT dispatch_failure_class FROM turns WHERE id=?").get(turnId))
      .toEqual({ dispatch_failure_class: "parked_ambiguous" });
    expect(resumeParkedSessionTurn(turnId)).toBe("unsafe");
  });

  test("parks but blocks replay when a tagged provider outcome is unconfirmed", async () => {
    const { turnId } = await runObservedFailure(
      "provider transport closed before terminal confirmation",
      { terminalConfirmed: false },
    );
    expect(db.query("SELECT dispatch_failure_class FROM turns WHERE id=?").get(turnId))
      .toEqual({ dispatch_failure_class: "parked_ambiguous" });
    expect(resumeParkedSessionTurn(turnId)).toBe("unsafe");
  });

  test("parks but blocks replay when provider session identity drifts", async () => {
    const { turnId } = await runObservedFailure(
      "API Error: 529 Overloaded",
      { boundProviderSessionId: "already-bound-provider-session" },
    );
    expect(db.query("SELECT dispatch_failure_class FROM turns WHERE id=?").get(turnId))
      .toEqual({ dispatch_failure_class: "parked_ambiguous" });
    expect(resumeParkedSessionTurn(turnId)).toBe("unsafe");
  });
});
