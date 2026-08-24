import { CoordinatorRuntimeManager } from "./coordinator-runtime";
import { DeploymentControlStore, type DeploymentCoordinatorHandoffRow } from "./state";

export interface CoordinatorWatchdogOptions {
  now?: Date;
  handshakeTimeoutSeconds?: number;
  heartbeatTimeoutSeconds?: number;
}

function sqliteTime(value: string) {
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

function recover(
  store: DeploymentControlStore,
  runtime: CoordinatorRuntimeManager,
  handoff: DeploymentCoordinatorHandoffRow,
) {
  try {
    const incumbent = runtime.recoverIncumbent({
      candidateUnit: handoff.candidate_unit,
      incumbentSlot: handoff.incumbent_slot,
      incumbentVersion: handoff.incumbent_version,
      incumbentUnit: handoff.incumbent_unit,
      incumbentWasActive: Boolean(handoff.incumbent_was_active),
    });
    return {
      action: "recovered" as const,
      generation_id: handoff.generation_id,
      handoff: store.recordCoordinatorRecovery({
        generationId: handoff.generation_id,
        recoveryInvocationId: incumbent?.invocationId || null,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action: "ambiguous" as const,
      generation_id: handoff.generation_id,
      handoff: store.markCoordinatorHandoffAmbiguous({
        generationId: handoff.generation_id,
        error: message,
      }),
    };
  }
}

export function runCoordinatorWatchdog(
  store: DeploymentControlStore,
  runtime: CoordinatorRuntimeManager,
  options: CoordinatorWatchdogOptions = {},
) {
  const now = options.now || new Date();
  const handshakeTimeout = (options.handshakeTimeoutSeconds ?? 10) * 1000;
  const heartbeatTimeout = (options.heartbeatTimeoutSeconds ?? 15) * 1000;
  const outcomes: Array<Record<string, unknown>> = [];
  for (const handoff of store.listCoordinatorWatchdogs()) {
    if (handoff.status === "revocation_requested" || handoff.status === "ambiguous") {
      outcomes.push(recover(store, runtime, handoff));
      continue;
    }
    const generation = store.getActivationGeneration(handoff.generation_id);
    if (!generation || generation.status !== "exposed") continue;
    const observed = runtime.observeUnit(handoff.candidate_unit);
    let fault: string | null = null;
    if (!observed.active || observed.mainPid <= 1 || !observed.invocationId) {
      fault = `candidate unit ${handoff.candidate_unit} is not active`;
    } else if (observed.invocationId !== handoff.candidate_invocation_id
      || observed.mainPid !== handoff.candidate_pid) {
      const promotedRebindGrace = handoff.status === "promoted"
        && handoff.heartbeat_at
        && now.getTime() - sqliteTime(handoff.heartbeat_at) <= heartbeatTimeout;
      if (!promotedRebindGrace) fault = `candidate unit ${handoff.candidate_unit} process identity changed`;
    } else if (!handoff.heartbeat_at || now.getTime() - sqliteTime(handoff.heartbeat_at) > heartbeatTimeout) {
      fault = `candidate unit ${handoff.candidate_unit} heartbeat expired`;
    } else if (handoff.status === "probation" && !handoff.handshake_at
      && handoff.probation_started_at
      && now.getTime() - sqliteTime(handoff.probation_started_at) > handshakeTimeout) {
      fault = `candidate unit ${handoff.candidate_unit} missed its probation handshake`;
    }
    if (!fault) {
      outcomes.push({ action: "healthy", generation_id: handoff.generation_id });
      continue;
    }
    store.revokeActivationByWatchdog({
      generationId: handoff.generation_id,
      reason: `Coordinator watchdog: ${fault}.`,
    });
    outcomes.push(recover(store, runtime, store.getCoordinatorHandoff(handoff.generation_id)!));
  }
  return outcomes;
}
