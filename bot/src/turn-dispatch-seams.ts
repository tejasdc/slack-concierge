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
  cancellation: TurnCancellationController;
}

export class TurnCancellationController {
  private cancel: (() => Promise<void>) | null = null;
  private requested = false;
  private dispatched = false;
  private completion: Promise<void> | null = null;
  private resolveCompletion: (() => void) | null = null;
  private rejectCompletion: ((error: Error) => void) | null = null;

  register(cancel: () => Promise<void>) {
    if (this.cancel || this.dispatched) return;
    this.cancel = cancel;
    if (this.requested) this.dispatch();
  }

  request() {
    this.requested = true;
    if (!this.completion) {
      this.completion = new Promise<void>((resolve, reject) => {
        this.resolveCompletion = resolve;
        this.rejectCompletion = reject;
      });
    }
    this.dispatch();
    return this.completion;
  }

  close(reason = new Error("The turn ended before provider cancellation was available.")) {
    if (!this.requested || this.dispatched) return;
    this.rejectCompletion?.(reason);
    this.resolveCompletion = null;
    this.rejectCompletion = null;
  }

  private dispatch() {
    if (!this.cancel || this.dispatched) return;
    this.dispatched = true;
    const cancel = this.cancel;
    this.cancel = null;
    void cancel().then(
      () => this.resolveCompletion?.(),
      (error) => this.rejectCompletion?.(error instanceof Error ? error : new Error(String(error))),
    ).finally(() => {
      this.resolveCompletion = null;
      this.rejectCompletion = null;
    });
  }
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
      cancellation: TurnCancellationController,
    ) => Promise<T>,
  ): Promise<T> {
    const key = steeringTargetKey(input.channelId, input.threadTs);
    const controller = new TurnSteeringController();
    const cancellation = new TurnCancellationController();
    const target = { turnId: input.turnId, controller, cancellation };
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
      return await execute(controller, closeSteering, cancellation);
    } finally {
      cancellation.close();
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

  requestCancellation(
    channelId: string,
    threadTs: string,
    turnId: number,
  ): { matched: false } | { matched: true; completion: Promise<void> } {
    const target = this.targets.get(steeringTargetKey(channelId, threadTs));
    if (!target || target.turnId !== turnId) return { matched: false };
    return { matched: true, completion: target.cancellation.request() };
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
