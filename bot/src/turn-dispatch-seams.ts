import type { SlackMessageFile } from "./attachments";
import { steeringTargetKey, TurnSteeringController } from "./steering";
import type { ProviderId } from "./state";

export interface UserTurnDispatchOptions {
  channel: string;
  channelName?: string;
  threadTs: string;
  userMsgTs: string;
  user: string;
  text: string;
  files?: SlackMessageFile[];
  client: any;
  providerOverride?: ProviderId;
  modelOverride?: string | null;
  reasoningEffortOverride?: string | null;
  forceNewSession?: boolean;
  prebuiltPrompt?: boolean;
  comparisonRequestId?: string;
}

export interface ActiveSteeringTarget {
  turnId: number;
  controller: TurnSteeringController;
}

export class ActiveTurnDispatchRegistry {
  private readonly targets = new Map<string, ActiveSteeringTarget>();

  constructor(private readonly lifecycle: {
    onStarted(): void;
    onSettled(): void;
  }) {}

  async run<T>(
    input: { turnId: number; channelId: string; threadTs: string },
    execute: (
      controller: TurnSteeringController,
      closeSteering: (reason?: Error) => void,
    ) => Promise<T>,
  ): Promise<T> {
    const key = steeringTargetKey(input.channelId, input.threadTs);
    const controller = new TurnSteeringController();
    const target = { turnId: input.turnId, controller };
    let closed = false;
    const closeSteering = (reason?: Error) => {
      if (closed) return;
      closed = true;
      if (this.targets.get(key) === target) this.targets.delete(key);
      controller.close(reason);
    };

    this.lifecycle.onStarted();
    this.targets.set(key, target);
    try {
      return await execute(controller, closeSteering);
    } finally {
      closeSteering();
      this.lifecycle.onSettled();
    }
  }

  dispatchSteering<T>(
    channelId: string,
    threadTs: string,
    dispatch: (target: ActiveSteeringTarget) => T,
  ): { matched: false } | { matched: true; value: T } {
    const target = this.targets.get(steeringTargetKey(channelId, threadTs));
    if (!target) return { matched: false };
    return { matched: true, value: dispatch(target) };
  }
}

export async function startRecoveredSessionTurnQueue(dependencies: {
  recoverPriorTurns(): Promise<void>;
  startRuntime(): Promise<void>;
  verifyProviderReady(): Promise<void>;
  startQueue(): void;
}) {
  await dependencies.recoverPriorTurns();
  await dependencies.startRuntime();
  await dependencies.verifyProviderReady();
  dependencies.startQueue();
}

export function dispatchComparisonTurn<T>(input: {
  requestId: string;
  channelId: string;
  channelName: string;
  threadTs: string;
  userId: string;
  text: string;
  client: any;
  provider: ProviderId;
  model: string | null;
}, dependencies: {
  dispatch(options: UserTurnDispatchOptions): T;
}): T {
  return dependencies.dispatch({
    channel: input.channelId,
    channelName: input.channelName,
    threadTs: input.threadTs,
    userMsgTs: input.threadTs,
    user: input.userId,
    text: input.text,
    client: input.client,
    providerOverride: input.provider,
    modelOverride: input.model,
    forceNewSession: true,
    prebuiltPrompt: true,
    comparisonRequestId: input.requestId,
  });
}
