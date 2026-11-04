/**
 * How the coordinator reaches one execution's host (docs/architecture/EXECUTION-HOST.md,
 * docs/architecture/RUNNERS.md "Turns on a runner"). Two places can hold a host:
 *
 * - `local`: the host runs on the coordinator's own machine under systemd or launchd; the
 *   coordinator starts it, attaches to its socket and reads its journal from disk (unchanged).
 * - `runner`: a runner machine started the same host program for a `turn` job; the host's journal
 *   frames arrive as the job's sequenced events in this ledger and the coordinator's commands go to
 *   the runner as job commands (runner-host-access.ts). Nothing about it is on this machine.
 *
 * Every custody decision (adoption, replay, held runs, settlement from a record, release only after
 * settlement) is written once against this interface, so both places get the same rules.
 */
import type { HostCustody, HostFrame, HostLaunch, HostStatus, SupervisorView } from "./execution-host-client";

export type HostManifest = {
  executable: string; args: string[]; cwd: string; environment: Record<string, string>;
  /** Whether the provider's environment starts from the machine's own (a consultation starts empty). */
  inheritEnvironment: boolean;
  initialInput: string; initialMeta?: Record<string, unknown>;
};

/** One attached connection to a host: the only writer of its execution while it holds. */
export interface HostLink {
  /** The protocol the host speaks, learned at attach. */
  protocol: number | null;
  /** Set when another coordinator attached instead; the run must not continue here. */
  fenced: boolean;
  /** Write outcomes the host sent ahead of a streamed replay (a later protocol fact). */
  readonly replayWriteOutcomes: Map<string, "written" | "failed">;
  attach(from: number, onFrame: (frame: HostFrame) => void): Promise<HostStatus & { until: number; streamingReplay?: boolean }>;
  command(message: { op: string; id: string; [key: string]: unknown }): Promise<any>;
  status(timeoutMs?: number): Promise<HostStatus>;
  onClosed(handler: (reason: string) => void): void;
  close(): void;
  /**
   * Follow Claude's own transcript for picked-up messages where the provider runs. Present only on
   * a link whose host is on another machine; a local run reads the transcript itself.
   */
  watchTranscript?(input: { sessionUuid: string; fromStart: boolean; onPickup: (pickup: any) => void }): () => void;
}

export interface HostAccess {
  /** `local` or `runner`, the executions row's supervisor family. */
  readonly place: "local" | "runner";
  /** Start the host; a HostNotStartedError proves nothing runs. */
  launch(manifest: HostManifest, files?: { path: string; base64: string }[]): Promise<HostLaunch>;
  /** Attach after a launch: waits for the host to open; `adopt` uses connect. */
  connectWhenReady(): Promise<HostLink>;
  connect(timeoutMs?: number): Promise<HostLink>;
  custody(): Promise<HostCustody>;
  journal(): AsyncGenerator<HostFrame>;
  release(): Promise<boolean>;
  stopSuperseded(): Promise<boolean>;
  supervisorView(): Promise<SupervisorView>;
}
