import {runLedgerSteps} from './ledger-admission';
import { requestAgentStopForSession } from "./state";
import type { ActiveTurnDispatchRegistry } from "./turn-dispatch-seams";

export async function handleAgentSessionStop(input: {
  event: { channel?: string; thread_ts?: string; event_ts?: string; streaming_message_ts?: string[] };
  teamId?: string;
  expectedTeamId: string | null;
  registry: ActiveTurnDispatchRegistry;
}): Promise<"cancelled" | "ignored"> {return runLedgerSteps((function* (this: any): Generator<unknown, any, any> {
  const { event, registry } = input;
  if (!input.expectedTeamId || input.teamId !== input.expectedTeamId
    || !event.channel || !event.thread_ts || !event.event_ts) return "ignored";
  const matched = registry.dispatchSteering(event.channel, event.thread_ts, (target) => {
    if (!requestAgentStopForSession({
      turnId: target.turnId, channel: event.channel!, threadTs: event.thread_ts!, eventTs: event.event_ts!,
    })) return null;
    return target.cancellation.request();
  });
  if (!matched.matched || !matched.value) return "ignored";
  (yield matched.value);
  // The turn coordinator owns terminal message/status delivery. A delayed
  // event handler must never set a successor's Agent session back to active.
  return "cancelled";
}).call(this));}
