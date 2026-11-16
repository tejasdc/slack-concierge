/** Keep the first retained result at its historical identity; every later attempt owns
 * a separate immutable result identity for the same accepted turn. */
export function nativeResultEventId(turnId:number,dispatchAttempt:number):string {
  if(!Number.isSafeInteger(turnId)||turnId<1||!Number.isSafeInteger(dispatchAttempt)||dispatchAttempt<1)
    throw new Error('A native result needs its exact turn and positive dispatch attempt.');
  return dispatchAttempt===1?`result:${turnId}`:`result:${turnId}:attempt:${dispatchAttempt}`;
}

/** Native acknowledgement and reconnect resolve to this same owner execution attempt. */
export function nativeInputClientMessageId(turnId:number,dispatchAttempt:number):string {
  if(!Number.isSafeInteger(turnId)||turnId<1||!Number.isSafeInteger(dispatchAttempt)||dispatchAttempt<1)
    throw new Error('A native input needs its exact turn and positive dispatch attempt.');
  return `slack-concierge:turn:${turnId}:attempt:${dispatchAttempt}`;
}
