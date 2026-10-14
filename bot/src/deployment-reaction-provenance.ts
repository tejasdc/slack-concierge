import { getDeliveredTurnMessageTarget, getTurnCommitProvenance } from "./state";
import type { DeploymentTurnReactionTarget } from "./deployment-state";
import { deploymentReactionTokensForCommitRange } from "./deployment-reaction-tokens";

export function resolveDeploymentReactionTargets(tokens: readonly string[]): DeploymentTurnReactionTarget[] {
  const targets = new Map<number, DeploymentTurnReactionTarget>();
  for (const token of tokens) {
      const provenance = getTurnCommitProvenance(token);
      if (!provenance || targets.has(provenance.turn_id)) continue;
      const delivered = getDeliveredTurnMessageTarget(provenance.turn_id);
      if (!delivered || delivered.slack_channel_id !== provenance.slack_channel_id) continue;
      targets.set(provenance.turn_id, {
        turnId: provenance.turn_id,
        slackChannelId: delivered.slack_channel_id,
        // Machine triggers have no originating user message. Their delivered
        // response already owns deployment state; do not invent an Activity target.
        slackUserMessageTs: /^\d+\.\d+$/.test(provenance.slack_user_msg_ts)
          ? provenance.slack_user_msg_ts : delivered.slack_message_ts,
        slackMessageTs: delivered.slack_message_ts,
      });
  }
  return [...targets.values()];
}

export async function deploymentReactionTargetsForCommitRange(
  repositoryRoot: string,
  baseCommit: string,
  candidateCommit: string,
): Promise<DeploymentTurnReactionTarget[]> {
  return resolveDeploymentReactionTargets(
    await deploymentReactionTokensForCommitRange(repositoryRoot, baseCommit, candidateCommit));
}
