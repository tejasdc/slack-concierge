export type LocalCaptureSnapshot = {
  version: 1;
  revision: number;
  active: boolean;
  captureId: string | null;
};

type CaptureUpdate = { active: boolean; captureId: string; leaseMs: number; sentAt: number };
type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array>; keepalive: ReturnType<typeof setInterval> };

const encoder = new TextEncoder();
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 30_000;

/**
 * One bounded, process-local claim from the native Mac capture helper. The timestamp belongs to
 * the helper, while expiry belongs to this listener's clock: delivery delay cannot extend a claim.
 */
export class LocalCaptureState {
  private active = false;
  private captureId: string | null = null;
  private revision = 0;
  private lastSentAt = 0;
  private expiresAt = 0;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly subscribers = new Set<Subscriber>();

  snapshot(): LocalCaptureSnapshot {
    this.expireIfNeeded();
    return { version: 1, revision: this.revision, active: this.active, captureId: this.active ? this.captureId : null };
  }

  update(input: CaptureUpdate): { accepted: boolean; state: LocalCaptureSnapshot } {
    this.expireIfNeeded();
    if (!Number.isSafeInteger(input.sentAt) || input.sentAt < 0) throw new Error("CAPTURE_INVALID_SENT_AT");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < MIN_LEASE_MS || input.leaseMs > MAX_LEASE_MS) throw new Error("CAPTURE_INVALID_LEASE");

    // A delayed heartbeat cannot resurrect capture after a newer stop, replacement, or expiry.
    if (input.sentAt < this.lastSentAt || (input.sentAt === this.lastSentAt && !this.active && input.active)) return { accepted: false, state: this.snapshot() };
    if (!input.active && (!this.active || this.captureId !== input.captureId)) return { accepted: false, state: this.snapshot() };

    const changed = this.active !== input.active || (input.active && this.captureId !== input.captureId);
    this.lastSentAt = input.sentAt;
    if (input.active) {
      this.active = true;
      this.captureId = input.captureId;
      this.expiresAt = input.sentAt + input.leaseMs;
      this.scheduleExpiry();
    } else {
      this.active = false;
      this.captureId = null;
      this.expiresAt = 0;
      this.clearExpiry();
    }
    if (changed) this.publish();
    return { accepted: true, state: this.snapshot() };
  }

  events(): ReadableStream<Uint8Array> {
    let subscriber: Subscriber | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const keepalive = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { this.remove(subscriber); }
        }, 15_000);
        keepalive.unref?.();
        subscriber = { controller, keepalive };
        this.subscribers.add(subscriber);
        this.enqueue(controller, this.snapshot());
      },
      cancel: () => this.remove(subscriber),
    });
  }

  close() {
    this.clearExpiry();
    for (const subscriber of [...this.subscribers]) {
      this.remove(subscriber);
      try { subscriber.controller.close(); } catch { /* already closed */ }
    }
  }

  private scheduleExpiry() {
    this.clearExpiry();
    this.expiry = setTimeout(() => {
      this.expiry = null;
      this.expireIfNeeded();
    }, Math.max(1, this.expiresAt - Date.now()));
    this.expiry.unref?.();
  }

  private expireIfNeeded() {
    if (!this.active) return;
    if (Date.now() < this.expiresAt) {
      if (!this.expiry) this.scheduleExpiry();
      return;
    }
    this.active = false;
    this.captureId = null;
    this.expiresAt = 0;
    // Reject a heartbeat sent before the lease expired even if it arrives afterwards.
    this.lastSentAt = Math.max(this.lastSentAt, Date.now());
    this.clearExpiry();
    this.publish();
  }

  private clearExpiry() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }

  private publish() {
    const snapshot = this.snapshot();
    this.revision += 1;
    const revised = { ...snapshot, revision: this.revision };
    for (const subscriber of [...this.subscribers]) {
      try { this.enqueue(subscriber.controller, revised); } catch { this.remove(subscriber); }
    }
  }

  private enqueue(controller: ReadableStreamDefaultController<Uint8Array>, snapshot: LocalCaptureSnapshot) {
    controller.enqueue(encoder.encode(`id: ${snapshot.revision}\nevent: capture\ndata: ${JSON.stringify(snapshot)}\n\n`));
  }

  private remove(subscriber: Subscriber | null) {
    if (!subscriber || !this.subscribers.delete(subscriber)) return;
    clearInterval(subscriber.keepalive);
  }
}

export const localCaptureId = (value: unknown) => {
  if (typeof value !== "string" || !/^[\w.:-]{1,128}$/.test(value)) throw new Error("CAPTURE_INVALID_ID");
  return value;
};
