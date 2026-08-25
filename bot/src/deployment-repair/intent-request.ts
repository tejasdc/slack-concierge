import { randomUUID } from "node:crypto";
import {
  deploymentContinuationForAgent,
  type DeploymentContinuation,
} from "../deployment-state";
import { checkedKernelCommand } from "./kernel-client";
import {
  resolveProviderProject,
  type ProviderProjectRegistry,
} from "../provider-broker-client";

export interface AgentDeploymentContext {
  sourceTurnId: number;
  ownerInstanceId: string;
  sourceSessionId: number;
  slackChannelId: string;
  slackThreadTs: string;
}

export function resolveAgentDeploymentContinuation(input: AgentDeploymentContext) {
  return deploymentContinuationForAgent(input);
}

export function assertAgentDeploymentProject(
  continuation: DeploymentContinuation,
  projectId: string,
  registry: ProviderProjectRegistry,
) {
  const authorizedProject = resolveProviderProject(continuation.projectPath, registry);
  if (authorizedProject.id !== projectId) {
    throw new Error("Deployment intent project does not own the current provider session.");
  }
  return authorizedProject;
}

export async function submitAgentDeploymentIntent(input: {
  expectedCommit: string;
  continuation: DeploymentContinuation;
}) {
  if (!/^[0-9a-f]{40}$/i.test(input.expectedCommit)) {
    throw new Error("Deployment intent requires a full commit SHA.");
  }
  const activationSnapshot = await checkedKernelCommand(
    "bot",
    "snapshot.read",
    { entity: "target", id: "concierge", status: "ready" },
    {},
    { idempotencyKey: `kernel:snapshot.read:request:${randomUUID()}` },
  );
  const activationGeneration = activationSnapshot.active_activation;
  if (!activationGeneration || activationGeneration.kind !== "production") {
    throw new Error("Deployment control requests are not authorized by an exposed production generation.");
  }
  const result = await checkedKernelCommand(
    "bot",
    "intent.request",
    { entity: "target", id: "concierge", status: "ready" },
    {
      activation_generation_id: activationGeneration.id,
      expected_commit: input.expectedCommit.toLowerCase(),
      continuation: {
        source_turn_id: input.continuation.sourceTurnId,
        source_session_id: input.continuation.sourceSessionId,
        slack_channel_id: input.continuation.slackChannelId,
        slack_thread_ts: input.continuation.slackThreadTs,
        requested_by_user_id: input.continuation.requestedByUserId,
        provider_id: input.continuation.providerId,
        provider_model: input.continuation.providerModel,
        reasoning_effort: input.continuation.reasoningEffort,
        provider_session_uuid: input.continuation.providerSessionUuid,
      },
    },
    {
      idempotencyKey: `kernel:intent.request:${input.continuation.sourceTurnId}:${input.expectedCommit.toLowerCase()}`,
    },
  );
  return { status: "requested", intent: result.intent, origin: result.origin };
}
