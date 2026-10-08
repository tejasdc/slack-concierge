/** The canonical owner and its read-only presentation worker share these state rules.
 * Fact gathering is separate: a worker may never import the mutable owner ledger. */
export type ReceiptTurnFacts={status:string;provider_input_acknowledged_at:string|null}|null;
export type ReceiptSteeringFacts={status:string;provider_sent_at:string|null}|null;

export function inputExecutionFacts(turn:ReceiptTurnFacts,steering:ReceiptSteeringFacts){
  const acknowledgedAt=steering?.provider_sent_at??(!steering?turn?.provider_input_acknowledged_at:null)??null;
  const turnState=({done:'completed',error:'failed',cancelled:'canceled',interrupted:'uncertain',
    delivery_parked:'uncertain',parked:'uncertain',delivering:'running'} as Record<string,string>)[turn?.status??'']
    ??turn?.status??'waiting';
  const terminalSteeringTurn=steering?.status==='ambiguous'&&['done','error','cancelled'].includes(turn?.status??'');
  const state=steering?steering.status==='sent'||terminalSteeringTurn?turnState:
    steering.status==='ambiguous'?'uncertain':steering.status==='failed'?'failed':'queued':turnState;
  return {acknowledgedAt,state};
}

export function requestOutcomeState(outcome:string|null|undefined):string {
  return outcome?outcome==='answered'?'completed':outcome==='canceled'?'canceled':
    ['unanswered','decision_needed','undetermined'].includes(outcome)?'uncertain':'failed':'waiting';
}

export function receiptOperationState(input:{kind:string;savedState?:string|null;executionState:string;
  requestKnown:boolean;requestOutcome?:string|null;stopTurnStatus?:string|null}):string {
  if(input.kind==='stop')return input.stopTurnStatus==='cancelled'?'completed':
    input.savedState==='uncertain'||!input.stopTurnStatus||!['running','delivering'].includes(input.stopTurnStatus)
      ?'uncertain':'running';
  if(input.kind==='request'&&input.requestKnown)return requestOutcomeState(input.requestOutcome);
  return input.savedState??input.executionState;
}
