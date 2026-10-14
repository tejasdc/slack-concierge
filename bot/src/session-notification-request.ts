/** An explicit request to interrupt him when this work has an answer. Derived only from his
 * retained words, so an agent's wording or outcome cannot opt a routine turn into a push. */
export function notificationRequest(text:string):'result'|'scheduled'|null {
  // A bug report may carry diagnostic JSON after Tejas's description. That machine text is
  // custody, not his instruction to make a new phone promise.
  const words=text.split('\nComplete diagnostics JSON')[0]??text;
  const reminder=/\bremind me\b/i.exec(words);
  if(reminder&&!negated(words,reminder.index))return 'scheduled';
  // A temporal clause is a request for a later interruption. "Let me know how" and
  // "tell me when is the best time" ask for an ordinary answer in this conversation.
  const temporal=/\b(?:let me know (?:when|once|after)|tell me (?:when|once)\s+(?!is\b|was\b|would\b|should\b|can\b)|give me (?:a |an )?(?:update|notification) when|(?:want|need|like) (?:a |an )?notification (?:when|once|if|after))\b/gi;
  for(const match of words.matchAll(temporal))if(!negated(words,match.index!))return 'result';
  // A bare "let me know if" often asks for the answer to the present question.
  // An account/action dependency names a later condition the system can observe.
  const dependency=/\blet me know if\s+(?:you|i|we|there(?:'s| is))\s+(?:need|needs|will need)\b[^.!?\n]{0,100}\b(?:sign[ -]?in|account|action|access|permission|usage|approval)\b/gi;
  for(const match of words.matchAll(dependency))if(!negated(words,match.index!))return 'result';
  const trailing=/\b(?:when|once|after)\b[^.!?\n]{0,120}\blet me know\b/gi;
  for(const match of words.matchAll(trailing)){
    const askAt=match.index!+match[0].toLowerCase().lastIndexOf('let me know');
    if(!negated(words,askAt))return 'result';
  }
  const explicit=/\b(?:notify me|send (?:me )?(?:a |an )?(?:push )?notification|send (?:me )?a push|ping me|alert me|notify (?:when|once|if|after|about|on|here))\b/gi;
  for(const match of words.matchAll(explicit)){
    if(negated(words,match.index!))continue;
    const before=words.slice(Math.max(0,match.index!-80),match.index!);
    if(/\b(?:trying to|was|were|did not|didn't|will|would|already|asked (?:me|you|them) to)\s*$/i.test(before))continue;
    if(/(?:^|[.!?]\s*|\b(?:please|can you|could you|would you|i want|i need|so|by the way)\s+)$/i.test(before))return 'result';
  }
  const bare=/\b(?:please|just|then|can you|could you|would you) notify\b|^\s*notify[.!?\s]*$/im.exec(words);
  return bare&&!negated(words,bare.index)?'result':null;
}

function negated(words:string,index:number){
  return /\b(?:do not|don't|dont|never|stop|no need to)\s+(?:\w+\s+){0,2}$/i.test(words.slice(Math.max(0,index-40),index));
}

/** Historical rows without an admission mark retain the classifier that admitted them. */
export function legacyNotificationRequest(text:string):'result'|'scheduled'|null {
  if(/\bremind me\b/i.test(text))return 'scheduled';
  return /\b(?:notify me|send me (?:a |an )?notification|let me know|tell me when|tell me once|give me (?:a |an )?(?:update|notification) when)\b/i.test(text)?'result':null;
}
