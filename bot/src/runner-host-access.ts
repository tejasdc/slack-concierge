/**
 * The coordinator's side of a host that runs on a runner (docs/architecture/RUNNERS.md, "Turns on
 * a runner"). The runner starts the unchanged execution host for a `turn` job, attaches to it on its
 * own machine and ships every journal frame as one of the job's sequenced events; the coordinator's
 * submit, close, signal and release go back as the job's commands, whose results are the host's own
 * receipts. Everything here is a read or write of this owner's ledger: nothing assumes the agent
 * shares this machine.
 *
 * Event frames a runner sends (`h` is the highest host sequence shipped so far, so a restarted runner
 * resumes the host's journal where its acknowledged events stopped):
 *   {k:'attached', protocol, hostPid, providerPid, h}   the runner attached to the host it started
 *   {k:'host', f:<journal frame>, h}                     one host journal frame, in host order
 *   {k:'pickup', watch, pickup, h}                       a message Claude's transcript shows it took
 *
 * Invariants carried over from local hosts: a launch either proves nothing started (withdrawn before
 * any runner claimed it, or the runner's definite refusal) or leaves custody to the evidence; a turn
 * job is never replayed (a passed lease makes it `unconfirmed`, settled like a lost host unless its
 * events hold the provider's exit); release is sent only after the owner settles the turn.
 */
import { createHash } from "node:crypto";
import { ledgerDurable } from "./ledger-durability-barrier";
import { runnerActivity } from "./runner-leases";
import { runnerLedger } from "./runner-ledger";
import { ADOPTABLE_HOST_PROTOCOLS, HOST_PROTOCOL_VERSION, HostNotStartedError, HostUnavailableError,
  type HostCustody, type HostFrame, type HostLaunch, type HostStatus, type SupervisorView } from "./execution-host-client";
import type { HostAccess, HostLink, HostManifest } from "./host-access";

export const RUNNER_SUPERVISOR = "runner";
export const TURN_JOB_KIND = "turn";
const engine = runnerLedger;

export const turnJobId = (executionId: string) => `turn:${executionId}`;
/** How long a new turn waits for a runner to claim and start it before it is withdrawn, unstarted. */
const claimDeadlineMs = () => Number(process.env.CONCIERGE_RUNNER_CLAIM_MS) || 120_000;
const POLL_MS = 1_000;

type Position = { attempt: number; seq: number };
type RunnerEvent = { attempt: number; seq: number; frame: any };

/** Resolves on the next runner write for this job, or after the poll interval, whichever is first. */
function nextActivity(jobId: string, ms = POLL_MS): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); runnerActivity.off(jobId, done); resolve(); };
    const timer = setTimeout(done, ms);
    runnerActivity.once(jobId, done);
  });
}

async function* jobEvents(jobId: string, from: Position = { attempt: 0, seq: 0 }): AsyncGenerator<RunnerEvent> {
  let position = from;
  for (;;) {
    const page = engine().eventsAfter(jobId, position, 500);
    if (!page.length) return;
    for (const event of page) yield event;
    const last = page.at(-1)!;
    position = { attempt: last.attempt, seq: last.seq };
    // Yield the event loop between pages: a long journal is read in bounded steps.
    await new Promise(resolve => setImmediate(resolve));
  }
}

const ended = (state: string) => state === "finished" || state === "unconfirmed";

export class RunnerHostAccess implements HostAccess {
  readonly place = "runner" as const;
  readonly jobId: string;
  constructor(readonly executionId: string) { this.jobId = turnJobId(executionId); }

  async launch(manifest: HostManifest, files: { path: string; base64: string }[] = []): Promise<HostLaunch> {
    const payload = { executionId: this.executionId, manifest, files, protocols: ADOPTABLE_HOST_PROTOCOLS };
    // The execution's intent and turn are on disk before any runner can see the work.
    await ledgerDurable();
    engine().enqueue({ jobId: this.jobId, kind: TURN_JOB_KIND, payload, replaySafe: false });
    const deadline = Date.now() + claimDeadlineMs();
    for (;;) {
      const job = engine().job(this.jobId, Number.MAX_SAFE_INTEGER);
      if (!job) throw new HostNotStartedError("the turn job disappeared before a runner claimed it");
      if (job.state === "queued" && Date.now() >= deadline) {
        // Withdrawn in one statement only while still queued: then no runner ever held it.
        if (engine().withdraw(this.jobId, "no runner claimed the turn in time"))
          throw new HostNotStartedError(`no runner claimed this turn within ${Math.round(claimDeadlineMs() / 1000)} s`);
        continue;
      }
      if (job.state === "finished" && job.result?.notStarted)
        throw new HostNotStartedError(`the runner could not start the host: ${job.result.notStarted}`);
      if (job.state === "finished" && job.result?.withdrawn) throw new HostNotStartedError(String(job.result.withdrawn));
      const attempt = job.attempts.at(-1);
      // Started: the runner reported its attachment, or the job already moved on (custody decides).
      if (ended(job.state) || (attempt && this.attachedEvent())) {
        return { executionId: this.executionId, directory: "", unit: `runner:${attempt?.runner ?? "unknown"}`,
          hostScript: "", runtime: "", manifestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
      }
      await nextActivity(this.jobId);
    }
  }

  /** The runner's report that it attached to the host it started, if it has made one. */
  attachedEvent(): any | null {
    for (const event of engine().eventsAfter(this.jobId, { attempt: 0, seq: 0 }, 5)) if (event.frame?.k === "attached") return event.frame;
    return null;
  }

  connectWhenReady() { return this.connect(); }
  async connect(): Promise<HostLink> {
    const job = engine().job(this.jobId, Number.MAX_SAFE_INTEGER);
    if (!job) throw new HostUnavailableError(`no runner job for execution ${this.executionId}`);
    if (ended(job.state)) throw new HostUnavailableError(`the runner job is ${job.state}`);
    return new RunnerLink(this);
  }

  async custody(): Promise<HostCustody> {
    const job = engine().job(this.jobId, Number.MAX_SAFE_INTEGER);
    if (!job) return "dead";
    if (!ended(job.state)) return "answering";
    for await (const frame of this.journal()) if (frame.k === "x") return "settle-from-record";
    return "dead";
  }

  async *journal(): AsyncGenerator<HostFrame> {
    for await (const event of jobEvents(this.jobId)) if (event.frame?.k === "host") yield event.frame.f as HostFrame;
  }

  async release(): Promise<boolean> {
    const job = engine().job(this.jobId, Number.MAX_SAFE_INTEGER);
    if (!job || ended(job.state)) return true;
    return runnerCommand(this.jobId, { op: "release", id: `release-${this.executionId}-${crypto.randomUUID()}` }, 30_000)
      // A runner finishes the job as soon as its host has let go, possibly before reporting the
      // release's own result: an ended job holds nothing either way.
      .then(result => !result?.refused, () => { const after = engine().job(this.jobId, Number.MAX_SAFE_INTEGER); return !after || ended(after.state); });
  }

  async stopSuperseded(): Promise<boolean> {
    const job = engine().job(this.jobId, Number.MAX_SAFE_INTEGER);
    if (!job || ended(job.state)) return true;
    return runnerCommand(this.jobId, { op: "stop-superseded", id: `superseded-${this.executionId}-${crypto.randomUUID()}` }, 30_000)
      .then(result => result?.stopped === true, () => false);
  }

  async supervisorView(): Promise<SupervisorView> {
    const job = engine().job(this.jobId, Number.MAX_SAFE_INTEGER);
    return !job ? "gone" : ended(job.state) ? "gone" : "alive";
  }
}

/**
 * Records a command for the job's runner and waits for its first result. The command is recorded
 * only after the rows it rests on are on disk, like a local host's commands.
 */
async function runnerCommand(jobId: string, message: { op: string; id: string; [key: string]: unknown }, timeoutMs: number | null): Promise<any> {
  const commandId = `${jobId}:${message.id}`;
  await ledgerDurable();
  engine().command(jobId, { commandId, kind: message.op, body: message });
  const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs;
  for (;;) {
    const answered = engine().commandResult(commandId);
    if (answered) return answered.result;
    const job = engine().job(jobId, Number.MAX_SAFE_INTEGER);
    if (!job || ended(job.state)) throw new HostUnavailableError(`the runner job ended before answering ${message.op}`);
    if (Date.now() >= deadline) throw new HostUnavailableError(`the runner did not answer ${message.op} in time`);
    await nextActivity(jobId);
  }
}

/** One coordinator's attachment to a runner-held host: frames from the ledger, commands into it. */
class RunnerLink implements HostLink {
  protocol: number | null = null;
  fenced = false;
  readonly replayWriteOutcomes = new Map<string, "written" | "failed">();
  private closed = false;
  private closedHandlers: Array<(reason: string) => void> = [];
  private pickupHandlers = new Map<string, (pickup: any) => void>();
  constructor(private readonly access: RunnerHostAccess) {}

  async attach(from: number, onFrame: (frame: HostFrame) => void): Promise<HostStatus & { until: number; streamingReplay?: boolean }> {
    const jobId = this.access.jobId;
    const attached = this.access.attachedEvent();
    const protocol = typeof attached?.protocol === "number" ? attached.protocol : HOST_PROTOCOL_VERSION;
    if (!ADOPTABLE_HOST_PROTOCOLS.includes(protocol)) throw new HostUnavailableError(`host protocol ${protocol} is not adoptable by this release`);
    this.protocol = protocol;
    // The boundary is the host sequence already recorded now; write outcomes are known before the
    // replay is streamed, exactly as a local host sends them ahead of its streamed prefix.
    let until = 0, providerPid: number | null = attached?.providerPid ?? null, exit: HostStatus["exit"] = null;
    let position: Position = { attempt: 0, seq: 0 };
    for await (const event of jobEvents(jobId)) {
      position = { attempt: event.attempt, seq: event.seq };
      if (event.frame?.k !== "host") continue;
      const frame = event.frame.f as HostFrame;
      until = Math.max(until, frame.s);
      if (frame.k === "c" && typeof frame.d?.id === "string") {
        if (frame.d.op === "written") this.replayWriteOutcomes.set(frame.d.id, "written");
        if (frame.d.op === "write-failed") this.replayWriteOutcomes.set(frame.d.id, "failed");
      }
      if (frame.k === "h" && typeof frame.d?.providerPid === "number") providerPid = frame.d.providerPid;
      if (frame.k === "x") exit = { code: frame.d?.code ?? null, signal: frame.d?.signal ?? null, at: frame.d?.at ?? frame.t };
    }
    // Pickups recorded before this attachment belong to earlier watches; only new ones are delivered.
    const pickupsFrom = position;
    setTimeout(() => void this.pump(from, onFrame, pickupsFrom), 0);
    return { protocol, executionId: this.access.executionId, hostPid: attached?.hostPid ?? 0, providerPid, lastSeq: until, exit,
      journalError: null, until, streamingReplay: true };
  }

  private async pump(from: number, onFrame: (frame: HostFrame) => void, pickupsFrom: Position) {
    const jobId = this.access.jobId;
    let position: Position = { attempt: 0, seq: 0 };
    while (!this.closed) {
      let read = 0;
      for await (const event of jobEvents(jobId, position)) {
        if (this.closed) return;
        position = { attempt: event.attempt, seq: event.seq };
        read++;
        const frame = event.frame;
        if (frame?.k === "host" && frame.f?.s >= from) onFrame(frame.f as HostFrame);
        else if (frame?.k === "pickup" && (event.attempt > pickupsFrom.attempt || (event.attempt === pickupsFrom.attempt && event.seq > pickupsFrom.seq)))
          this.pickupHandlers.get(frame.watch)?.(frame.pickup);
      }
      if (read) continue;
      const job = engine().job(jobId, Number.MAX_SAFE_INTEGER);
      // Every event the job will ever have is stored before it ends, so an ended job with nothing
      // left to read is the connection's end; custody then decides from the record.
      if (!job || ended(job.state)) { this.end(`the runner job is ${job?.state ?? "gone"}`); return; }
      await nextActivity(jobId);
    }
  }

  command(message: { op: string; id: string; [key: string]: unknown }): Promise<any> {
    if (this.closed) return Promise.reject(new HostUnavailableError("host connection is closed"));
    return runnerCommand(this.access.jobId, message, null).then(result => {
      if (result?.refused) throw new Error(`host refused: ${result.refused}`);
      return result;
    });
  }

  status(timeoutMs = 15_000): Promise<HostStatus> {
    return runnerCommand(this.access.jobId, { op: "status", id: `status-${crypto.randomUUID()}` }, timeoutMs);
  }

  watchTranscript(input: { sessionUuid: string; fromStart: boolean; onPickup: (pickup: any) => void }): () => void {
    const watch = `watch-${crypto.randomUUID()}`;
    this.pickupHandlers.set(watch, input.onPickup);
    void runnerCommand(this.access.jobId, { op: "watch-transcript", id: watch, sessionUuid: input.sessionUuid, fromStart: input.fromStart }, null).catch(() => {});
    return () => {
      this.pickupHandlers.delete(watch);
      void runnerCommand(this.access.jobId, { op: "unwatch-transcript", id: `un${watch}`, watch }, null).catch(() => {});
    };
  }

  onClosed(handler: (reason: string) => void) { if (this.closed) handler("connection closed"); else this.closedHandlers.push(handler); }
  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closedHandlers) handler(reason);
  }
  close() { this.closed = true; }
}
