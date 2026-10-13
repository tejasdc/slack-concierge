/**
 * What an agent provider gives a session, decided in one place. Every provider that runs sessions
 * answers every guarantee: `met`, or the reason it is missing and what happens instead. The type
 * is keyed by the literal unions of providers and guarantees, so adding either without answering
 * every pair is a build error; the candidate release check (bot/scripts/provider-contract-check.ts)
 * refuses a provider whose live capabilities disagree with what it declares here.
 *
 * Gemini was added on 2026-10-12 with steering switched off and with runs an update never trusted,
 * because each guarantee was a separate branch naming Claude and Codex; nothing compared a new
 * provider against them (Tejas, 2026-10-13: "How can we build a third integration into our system
 * ... and completely miss what the other agents have?"). The update rule (execution-survival.ts),
 * the update-time queue and provider capabilities now read this table instead.
 */
import type { ProviderId } from "./state";

export type ProviderGuarantee =
  /** A message sent while the agent works reaches that running agent, not a later process. */
  | "steer"
  /** Stop ends the running turn. */
  | "stop"
  /** A Concierge update or restart leaves the run working and the next Concierge takes it back. */
  | "carriesOnThroughUpdate"
  /** The same provider runs sessions on the server and on the Mac. */
  | "bothMachines"
  /** Earlier messages are read from the provider's own conversation record. */
  | "history"
  /** A session can be copied into a new one from a chosen point. */
  | "fork";

export const PROVIDER_GUARANTEES = ["steer", "stop", "carriesOnThroughUpdate", "bothMachines", "history", "fork"] as const satisfies readonly ProviderGuarantee[];

export type GuaranteeAnswer =
  | { met: true; how: string }
  /** The platform itself does not allow it; `instead` is what the session does. */
  | { met: false; platformLimit: string; instead: string }
  /** Concierge has not built it yet; `instead` is what the session does until then. */
  | { met: false; notBuilt: string; instead: string };

/** Where a run lives while it works, which is what decides whether it outlives Concierge. */
export type RunsIn = "execution-host" | "codex-daemon" | "capability-host";

export type ProviderContract = Readonly<{ runsIn: RunsIn;
  /** Steps both installers (the server's deploy and the Mac's install) must run for this provider. */
  machineSetup: readonly string[];
  guarantees: Readonly<Record<ProviderGuarantee, GuaranteeAnswer>> }>;

export const PROVIDER_CONTRACT: Readonly<Record<ProviderId, ProviderContract>> = {
  "claude-code": { runsIn: "execution-host", machineSetup: [], guarantees: {
    steer: { met: true, how: "Joins Claude Code's own input queue; Claude reads it at its next step." },
    stop: { met: true, how: "Interrupts the Claude process." },
    carriesOnThroughUpdate: { met: true, how: "Runs in its own execution host, taken back by identity after a restart." },
    bothMachines: { met: true, how: "systemd host on the server, launchd host on the Mac." },
    history: { met: true, how: "Claude transcript through the SDK." },
    fork: { met: true, how: "Copies the transcript at a message." },
  } },
  codex: { runsIn: "codex-daemon", machineSetup: ["install-codex-stop-hook.sh"], guarantees: {
    steer: { met: true, how: "The App Server's turn/steer adds it to the running turn." },
    stop: { met: true, how: "turn/interrupt on the App Server." },
    carriesOnThroughUpdate: { met: true, how: "Runs in the shared App Server, followed by its ids after a restart." },
    bothMachines: { met: true, how: "Shared App Server on each machine." },
    history: { met: true, how: "Codex rollout files." },
    fork: { met: true, how: "Copies the thread at a turn." },
  } },
  antigravity: { runsIn: "execution-host", machineSetup: ["install-antigravity-account-hook.sh"], guarantees: {
    steer: { met: true, how: "Written into the running CLI's streaming input; Google's headless CLI answers it as soon as the current answer ends, in the same run (verified with agy 1.3.4 on 2026-10-13: it cannot add it mid-answer)." },
    stop: { met: true, how: "Interrupts the CLI process." },
    carriesOnThroughUpdate: { met: true, how: "Runs in the same execution host as Claude and replays its record when taken back." },
    bothMachines: { met: true, how: "The agy CLI in the execution host on each machine, signed in per machine." },
    history: { met: false, notBuilt: "Gemini's own conversation record is not read yet.", instead: "History shows the messages Concierge kept for this session." },
    fork: { met: false, notBuilt: "Copying a Google conversation is not built.", instead: "Start a new session." },
  } },
  chatgpt: { runsIn: "capability-host", machineSetup: [], guarantees: {
    steer: { met: false, platformLimit: "ChatGPT's web chat takes one message at a time.", instead: "The message waits and is sent when the current answer ends." },
    stop: { met: false, platformLimit: "The ChatGPT page has no reliable stop for a sent message.", instead: "The answer is kept when it arrives." },
    carriesOnThroughUpdate: { met: true, how: "Thinkering keeps the answer under the run id recorded before the send." },
    bothMachines: { met: false, platformLimit: "ChatGPT runs in the server's signed-in Chrome.", instead: "ChatGPT sessions live on the server." },
    history: { met: true, how: "Thinkering's ChatGPT transcript." },
    fork: { met: false, platformLimit: "ChatGPT conversations cannot be branched from outside.", instead: "Start a new session." },
  } },
};

export function guaranteeMet(provider: string, guarantee: ProviderGuarantee): boolean {
  return (PROVIDER_CONTRACT as Record<string, ProviderContract | undefined>)[provider]?.guarantees[guarantee].met === true;
}

/** What a session of this provider does differently, in words for the app; null when nothing. */
export function contractGaps(provider: ProviderId): string | null {
  const gaps = PROVIDER_GUARANTEES.map(guarantee => PROVIDER_CONTRACT[provider].guarantees[guarantee])
    .flatMap(answer => answer.met ? [] : [answer.instead]);
  return gaps.length ? gaps.join(" ") : null;
}

/** Providers whose runs live in Concierge's execution host (systemd on Linux, launchd on the Mac). */
export function executionHostProviders(): ProviderId[] {
  return (Object.keys(PROVIDER_CONTRACT) as ProviderId[]).filter(provider => PROVIDER_CONTRACT[provider].runsIn === "execution-host");
}
