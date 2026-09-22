import { db, finishDeliveredTurn, getSessionById, markTurnDelivering, markTurnResponseDelivered, type ProviderId } from "./state";
import { bindSessionProvider, createNativeSession, getAcceptedSessionInput, recordSessionEvent, sessionMetadata, type AcceptedSessionInput, type NativeSessionMetadata } from "./session-inputs";
import type { RunResult } from "./codex";

export interface NativeForkPin {
  provider: ProviderId;
  parentSessionUUID: string;
  bindingGeneration: number;
  boundary: string;
  cwd?: string;
  additionalDirs?: string[];
  metadata?: NativeSessionMetadata;
  threadSource?: string;
}

export function readNativeForkPin(operation: AcceptedSessionInput): NativeForkPin {
  const saved = operation.receipt_json ? JSON.parse(operation.receipt_json) : {};
  const pin = saved.fork as NativeForkPin | undefined;
  const request = JSON.parse(operation.payload_json);
  if (operation.kind !== "fork" || !pin || !pin.parentSessionUUID || !Number.isSafeInteger(pin.bindingGeneration)
    || pin.bindingGeneration < 1 || pin.boundary !== request.boundary || (request.provider && request.provider !== pin.provider)) {
    throw new Error("The native fork lost its exact retained parent and boundary.");
  }
  return pin;
}

/**
 * A fork inherits how the parent runs — where, with which provider settings — and never what
 * the parent is or owes. Copying the parent's whole metadata handed the child its open
 * questions, stamped with the parent's generation numbers that the child's own reset counter
 * could never clear, so the child asked him to answer a question nobody had asked it and
 * Clear all attention could not take it off his list (his report 558e885e). The same copy
 * would have given a fork of the Inbox the Inbox's own role, and a fork of a bound or
 * imported session someone else's binding and source.
 */
export function forkedSessionMetadata(pin: NativeForkPin): NativeSessionMetadata {
  const parent = pin.metadata ?? {};
  return { title: `Fork: ${parent.title ?? "Agent session"}`, summary: parent.summary, purpose: parent.purpose,
    cwd: parent.cwd, additionalDirs: parent.additionalDirs, project: parent.project,
    model: parent.model, reasoningEffort: parent.reasoningEffort, workflowId: parent.workflowId,
    origin: "native", suspended: false, pinned: false, saved: false, outcome: "open",
    generation: 0, readGeneration: 0, dismissedGeneration: 0, needs: [],
    lineage: { boundary: pin.boundary, sourceVersion: null } };
}

/** Records a proven provider copy and terminal control event in the existing turn transaction. */
export function completeNativeFork(operationId: string, ownerInstanceId: string, result: RunResult): string {
  return db.transaction(() => {
    const operation = getAcceptedSessionInput(operationId);
    if (!operation || operation.turn_id === null) throw new Error("The native fork has no owned control turn.");
    const pin = readNativeForkPin(operation);
    const saved = JSON.parse(operation.receipt_json!);
    if (saved.childSessionId) return saved.childSessionId;
    const parent = getSessionById(operation.session_id);
    const turn = db.query("SELECT status FROM turns WHERE id=? AND session_id=? AND owner_instance_id=? AND status IN ('running','delivering')")
      .get(operation.turn_id, operation.session_id, ownerInstanceId) as { status: string } | null;
    if (!parent || !turn || parent.provider_id !== pin.provider || parent.agent_session_uuid !== pin.parentSessionUUID
      || parent.binding_generation !== pin.bindingGeneration || sessionMetadata(parent).interactionPolicy === "consultation-only") {
      throw new Error("The fork's parent binding or control ownership changed.");
    }
    if (typeof result.sessionUUID !== "string" || !result.sessionUUID || result.sessionUUID === pin.parentSessionUUID) {
      throw new Error("Native fork did not prove a distinct child conversation.");
    }
    if (db.query("SELECT 1 FROM sessions WHERE provider_id=? AND agent_session_uuid=?").get(pin.provider, result.sessionUUID)) {
      throw new Error("The forked provider conversation already has a canonical owner.");
    }
    const metadata = forkedSessionMetadata(pin);
    const child = createNativeSession(pin.provider, metadata);
    bindSessionProvider(child.id, pin.provider, result.sessionUUID);
    db.query("UPDATE sessions SET parent_session_id=? WHERE id=?").run(parent.id, child.id);
    const childSessionId = `concierge:${child.id}`;
    const envelope = JSON.stringify({ version: 1, kind: "fork", result });
    if (turn.status === "running" && !markTurnDelivering(operation.turn_id, "", envelope, 0)) {
      throw new Error("The fork's control turn no longer accepts its result.");
    }
    db.query("UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify({ ...saved, state: "completed", childSessionId, forkResult: result, error: null }), operation.id);
    recordSessionEvent({ eventId: `fork:${operation.id}`, sessionId: parent.id, inputId: operation.id, turnId: operation.turn_id,
      kind: "forked", payload: { childSessionId, boundary: pin.boundary, provider: pin.provider, providerSessionUUID: result.sessionUUID } });
    markTurnResponseDelivered(operation.turn_id);
    if (!finishDeliveredTurn(operation.turn_id)) throw new Error("The completed native fork could not settle its control turn.");
    return childSessionId;
  })();
}
