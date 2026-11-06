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
  sessionTitle?: string;
  prebuiltPrompt?: boolean;
  comparisonRequestId?: string;
  admissionOnly?: boolean;
  routedRequestId?: string;
  waitRequested?: boolean;
  dependencyTurnIds?: number[];
  expectedSessionId?: number;
}

export interface ActiveSteeringTarget {
  turnId: number;
  sessionId?: number;
  controller: TurnSteeringController;
  cancellation: TurnCancellationController;
  settled: Promise<void>;
}

export class TurnCancellationController {
  private cancel: (() => Promise<void>) | null = null;
  private requested = false;
  private waitForTools = false;
  private readonly activeTools = new Map<string,number>();
  private dispatched = false;
  private completion: Promise<void> | null = null;
  private resolveCompletion: (() => void) | null = null;
  private rejectCompletion: ((error: Error) => void) | null = null;
  private drainMayCancel: (() => boolean) | null = null;

  register(cancel: () => Promise<void>) {
    if (this.cancel || this.dispatched) return;
    this.cancel = cancel;
    if (this.requested) this.dispatch();
  }

  request() {
    // A person's Stop overrides an earlier release-only request.
    this.drainMayCancel = null;
    return this.requestInternal();
  }

  requestForDrain(mayCancel: () => boolean) {
    if (this.requested) return this.completion ?? Promise.resolve();
    this.drainMayCancel = mayCancel;
    return this.requestInternal();
  }

  resolveWithoutProviderCancellation() {
    if (!this.requested || this.dispatched) return;
    this.requested = false;
    this.drainMayCancel = null;
    const resolve = this.resolveCompletion;
    this.completion = null;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
    resolve?.();
  }

  private requestInternal() {
    this.requested = true;
    this.waitForTools = false;
    if (!this.completion) {
      this.completion = new Promise<void>((resolve, reject) => {
        this.resolveCompletion = resolve;
        this.rejectCompletion = reject;
      });
    }
    this.dispatch();
    return this.completion;
  }

  requestAtSafePoint() {
    this.drainMayCancel = null;
    this.requested = true;
    this.waitForTools = true;
    if (!this.completion) {
      this.completion = new Promise<void>((resolve, reject) => {
        this.resolveCompletion = resolve;
        this.rejectCompletion = reject;
      });
    }
    this.dispatch();
    return this.completion;
  }

  toolStarted(itemId: string) {
    this.activeTools.set(itemId,(this.activeTools.get(itemId)??0)+1);
  }

  toolFinished(itemId: string) {
    const active=this.activeTools.get(itemId)??0;
    if(active<=1)this.activeTools.delete(itemId);
    else this.activeTools.set(itemId,active-1);
    this.dispatch();
  }

  close(reason = new Error("The turn ended before provider cancellation was available.")) {
    if (!this.requested || this.dispatched) return;
    // A release only needs to stop work still owned by this dispatch. Settlement
    // ends that obligation even if no provider callback was ever registered.
    if (this.drainMayCancel) {
      this.resolveWithoutProviderCancellation();
      return;
    }
    this.rejectCompletion?.(reason);
    this.resolveCompletion = null;
    this.rejectCompletion = null;
  }

  private dispatch() {
    if (!this.requested || !this.cancel || this.dispatched || this.waitForTools && this.activeTools.size>0) return;
    if (this.drainMayCancel && !this.drainMayCancel()) {
      this.resolveWithoutProviderCancellation();
      return;
    }
    this.drainMayCancel = null;
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
  private readonly sessions = new Map<number, ActiveSteeringTarget>();
  private readonly activeTurnIds = new Set<number>();
  private readonly activeSessionIds = new Set<number>();

  get activeSessions(): readonly number[] { return [...this.activeSessionIds]; }
  get activeTurns(): readonly number[] { return [...this.activeTurnIds]; }

  constructor(private readonly lifecycle: {
    onStarted(): void;
    onSettled(turnId: number): void;
  }) {}

  async run<T>(
    input: { turnId: number; sessionId?: number; channelId?: string; threadTs?: string },
    execute: (
      controller: TurnSteeringController,
      closeSteering: (reason?: Error) => void,
      cancellation: TurnCancellationController,
    ) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(input.turnId) || input.turnId < 1
      || (input.sessionId !== undefined && (!Number.isSafeInteger(input.sessionId) || input.sessionId < 1))) {
      throw new Error("Active execution requires an exact turn and session identity.");
    }
    if ((input.channelId === undefined) !== (input.threadTs === undefined)
      || (input.sessionId === undefined && input.channelId === undefined)) {
      throw new Error("Active execution requires a canonical session or complete Slack target.");
    }
    if (this.activeTurnIds.has(input.turnId)
      || (input.sessionId !== undefined && this.activeSessionIds.has(input.sessionId))) {
      throw new Error("The turn or session already has an active execution owner.");
    }
    const key = input.channelId === undefined ? null : steeringTargetKey(input.channelId, input.threadTs!);
    const controller = new TurnSteeringController();
    const cancellation = new TurnCancellationController();
    let resolveSettled: () => void = () => {};
    const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    const target = { turnId: input.turnId, sessionId: input.sessionId, controller, cancellation, settled };
    let closed = false;
    const closeSteering = (reason?: Error) => {
      if (closed) return;
      closed = true;
      if (key !== null && this.targets.get(key) === target) this.targets.delete(key);
      if (input.sessionId !== undefined && this.sessions.get(input.sessionId) === target) this.sessions.delete(input.sessionId);
      controller.close(reason);
    };

    this.lifecycle.onStarted();
    this.activeTurnIds.add(input.turnId);
    if (input.sessionId !== undefined) {
      this.activeSessionIds.add(input.sessionId);
      this.sessions.set(input.sessionId, target);
    }
    if (key !== null) this.targets.set(key, target);
    try {
      return await execute(controller, closeSteering, cancellation);
    } finally {
      cancellation.close();
      closeSteering();
      this.activeTurnIds.delete(input.turnId);
      if (input.sessionId !== undefined) this.activeSessionIds.delete(input.sessionId);
      try { this.lifecycle.onSettled(input.turnId); }
      finally { resolveSettled(); }
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

  dispatchSessionSteering<T>(
    sessionId: number,
    dispatch: (target: ActiveSteeringTarget) => T,
  ): { matched: false } | { matched: true; value: T } {
    const target = this.sessions.get(sessionId);
    return target ? { matched: true, value: dispatch(target) } : { matched: false };
  }

  requestSessionCancellation(
    sessionId: number,
    turnId: number,
  ): { matched: false } | { matched: true; completion: Promise<void> } {
    const target = this.sessions.get(sessionId);
    if (!target || target.turnId !== turnId) return { matched: false };
    return { matched: true, completion: target.cancellation.request() };
  }

  requestSessionDrainCancellation(
    sessionId: number,
    turnId: number,
    mayCancel: () => boolean,
  ): { matched: false } | { matched: true; completion: Promise<void> } {
    const target = this.sessions.get(sessionId);
    if (!target || target.turnId !== turnId) return { matched: false };
    const cancellation = target.cancellation.requestForDrain(mayCancel);
    // An earlier Stop or banked yield has its own outcome. A release can proceed
    // when that cancellation succeeds or the exact dispatch has settled; an
    // inherited cancellation failure alone must not abort service shutdown.
    return { matched: true, completion: Promise.race([
      target.settled,
      cancellation.catch(() => target.settled),
    ]) };
  }

  requestSessionStop(sessionId: number, turnId: number): { matched: false } | { matched: true; completion: Promise<void> } {
    const target = this.sessions.get(sessionId);
    if (!target || target.turnId !== turnId) return { matched: false };
    // The provider may take time to cancel. Close its local steering line first so a
    // sentence waiting behind the current send cannot leave after Stop.
    target.controller.close(new Error("The run was stopped before this steering message was sent."));
    return { matched: true, completion: target.cancellation.request() };
  }

  requestSafeSessionCancellation(sessionId:number,turnId:number):{matched:false}|{matched:true;completion:Promise<void>} {
    const target=this.sessions.get(sessionId);
    if(!target||target.turnId!==turnId)return {matched:false};
    return {matched:true,completion:target.cancellation.requestAtSafePoint()};
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
  files?: SlackMessageFile[];
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
    files: input.files,
    client: input.client,
    providerOverride: input.provider,
    modelOverride: input.model,
    forceNewSession: true,
    prebuiltPrompt: true,
    comparisonRequestId: input.requestId,
  });
}
