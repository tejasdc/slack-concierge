export interface SteeringInput {
  clientMessageId: string;
  text: string;
}

export type SteeringSender = (input: SteeringInput) => Promise<void>;

export class SteeringNotSentError extends Error {}

export function steeringTargetKey(channel: string, replyThreadTs: string) {
  return `${channel}:${replyThreadTs}`;
}

interface PendingSteeringInput extends SteeringInput {
  prepareText?: (attachmentRoot: string | undefined) => Promise<string>;
  onSending?: () => void | Promise<void>;
  onSent: () => void | Promise<void>;
  onError: (error: Error) => void | Promise<void>;
  onAmbiguous?: (error: Error) => void | Promise<void>;
  onAmbiguousFinalized?: () => void | Promise<void>;
}

interface QueuedSteeringInput extends PendingSteeringInput {
  settled: boolean;
  deliveryStarted: boolean;
  transitions: Promise<void>;
}

export class TurnSteeringController {
  private sender: SteeringSender | null = null;
  private queue: QueuedSteeringInput[] = [];
  private current: QueuedSteeringInput | null = null;
  private draining = false;
  private closed = false;
  private attachmentRoot: string | undefined;
  private preparation: Promise<string> | null = null;

  registerSender(sender: SteeringSender, attachmentRoot?: string) {
    if (this.closed) return;
    this.attachmentRoot = attachmentRoot;
    this.sender = sender;
    void this.drain();
  }

  async waitForPreparation() {
    await this.preparation?.catch(() => {});
  }

  enqueue(input: PendingSteeringInput): boolean {
    if (this.closed) return false;
    this.queue.push({ ...input, settled: false, deliveryStarted: false, transitions: Promise.resolve() });
    void this.drain();
    return true;
  }

  close(reason = new Error("The provider turn ended before this steering message was sent.")) {
    if (this.closed) return;
    this.closed = true;
    if (this.current) {
      if (this.current.deliveryStarted) void this.settleAmbiguous(this.current, reason).catch(() => {});
      else void this.settleError(this.current, reason).catch(() => {});
    }
    const queued = this.queue.splice(0);
    for (const input of queued) void this.settleError(input, reason).catch(() => {});
  }

  private transition(input: QueuedSteeringInput, callback: () => void | Promise<void>) {
    const result = input.transitions.then(callback);
    input.transitions = result.catch(() => {});
    return result;
  }

  private settleSent(input: QueuedSteeringInput) {
    return this.transition(input, async () => {
      // A successful provider acknowledgement can upgrade an already-durable
      // ambiguous state. Durable success must precede in-memory settlement.
      await input.onSent();
      input.settled = true;
    });
  }

  private settleError(input: QueuedSteeringInput, error: Error) {
    return this.transition(input, async () => {
      if (input.settled) return;
      await input.onError(error);
      input.settled = true;
    });
  }

  private settleAmbiguous(input: QueuedSteeringInput, error: Error) {
    return this.transition(input, async () => {
      if (input.settled) return;
      if (input.onAmbiguous) await input.onAmbiguous(error);
      else await input.onError(error);
      input.settled = true;
    });
  }

  private async drain() {
    if (this.draining || this.closed || !this.sender) return;
    this.draining = true;
    try {
      while (!this.closed && this.sender && this.queue.length > 0) {
        const input = this.queue.shift()!;
        this.current = input;
        try {
          this.preparation = input.prepareText ? input.prepareText(this.attachmentRoot) : null;
          const text = this.preparation ? await this.preparation : input.text;
          if (this.closed || input.settled) continue;
          if (input.onSending) await this.transition(input, input.onSending);
          if (this.closed || input.settled) {
            await input.transitions;
            continue;
          }
          input.deliveryStarted = true;
          await this.sender({ clientMessageId: input.clientMessageId, text });
          // Provider acknowledgement always wins. If close already persisted
          // provisional ambiguity, this transition upgrades it to sent.
          await this.settleSent(input);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (input.settled && input.deliveryStarted) await input.onAmbiguousFinalized?.();
          else if (failure instanceof SteeringNotSentError) await this.settleError(input, failure);
          else if (input.deliveryStarted) {
            await this.settleAmbiguous(input, failure);
            await input.onAmbiguousFinalized?.();
          }
          else await this.settleError(input, failure);
        } finally {
          this.preparation = null;
          if (this.current === input) this.current = null;
        }
      }
    } finally {
      this.draining = false;
      if (!this.closed && this.sender && this.queue.length > 0) void this.drain();
    }
  }
}
