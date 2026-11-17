/** Explicit interruption requests qualify wherever they occur in his own words. Context
 * can exclude a mention; there is deliberately no list of approved imperative lead-ins. */
export function notificationRequest(text:string):'result'|'scheduled'|null {
  // A bug report may carry diagnostic JSON after Tejas's description. That machine text is
  // custody, not his instruction to make a new phone promise.
  // Help-needed alerts already belong to the blocking-question path. Do not turn
  // that conditional request into a promise to push the next routine answer.
  const words=unquoted(text.split('\nComplete diagnostics JSON')[0]??text).replace(/[’]/g,"'").replace(
    /\bif (?:you|we) (?:still )?need (?:my|any) help[.!?,]?\s*(?:then\s+)?(?:please\s+)?(?:send me (?:a |an )?notification|notify me|ping me|alert me)\b/gi,
    '',
  );
  for(const reminder of words.matchAll(/\bremind me\b/gi))
    if(!excludedMention(words,reminder.index!))return 'scheduled';
  // A temporal clause is a request for a later interruption. "Let me know how" and
  // "tell me when is the best time" ask for an ordinary answer in this conversation.
  const temporal=/\b(?:let me know (?:when|once|after)|tell me (?:when|once)\s+(?!is\b|was\b|would\b|should\b|can\b)|give me (?:a |an )?(?:update|notification) when|(?:want|need|like) (?:a |an )?notification (?:when|once|if|after))\b/gi;
  for(const match of words.matchAll(temporal))if(!excludedMention(words,match.index!))return 'result';
  // A bare "let me know if" often asks for the answer to the present question.
  // An account/action dependency names a later condition the system can observe.
  const dependency=/\blet me know if\s+(?:you|i|we|there(?:'s| is))\s+(?:need|needs|will need)\b[^.!?\n]{0,100}\b(?:sign[ -]?in|account|action|access|permission|usage|approval)\b/gi;
  for(const match of words.matchAll(dependency))if(!excludedMention(words,match.index!))return 'result';
  const trailing=/\b(?:when|once|after)\b[^.!?\n]*\blet me know\b/gi;
  for(const match of words.matchAll(trailing)){
    const askAt=match.index!+match[0].toLowerCase().lastIndexOf('let me know');
    if(!excludedMention(words,askAt))return 'result';
  }
  const explicit=/\b(?:notify me|send (?:me )?(?:a |an )?(?:push )?notification|send (?:me )?a push|ping me|alert me|notify (?:when|once|if|after|about|on|here))\b/gi;
  for(const match of words.matchAll(explicit)){
    if(!excludedMention(words,match.index!))return 'result';
  }
  for(const bare of words.matchAll(/\bnotify(?=[.!?\s]*$)/gi))
    if(!excludedMention(words,bare.index!))return 'result';
  return null;
}

function unquoted(words:string):string {
  // Keep offsets and sentence boundaries while excluding another speaker's quoted words.
  return words.replace(/```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)|‘[^’\n]*’|^\s*>[^\n]*/gm,
    quote=>quote.replace(/[^\n]/g,' '));
}

function excludedMention(words:string,index:number):boolean {
  const sentence=words.slice(0,index).split(/[.!?;\n]/).at(-1)??'';
  const contrasted=sentence.split(/\bbut\b/i).at(-1)??sentence;
  const comma=contrasted.lastIndexOf(',');
  // A completed clause before a comma cannot govern a new imperative. A comma
  // introducing reported speech ("he said, notify me") retains its reporting root.
  const reportingIntroduction=comma>=0&&/\b(?:said|says|say|told|asked|wrote|writes|quoted|mentioned|heard)\s*$/i.test(contrasted.slice(0,comma));
  const before=comma>=0&&!reportingIntroduction?contrasted.slice(comma+1):contrasted;
  // A separate affirmative clause is not governed by an earlier unrelated negation.
  const clause=before.split(/\b(?:but|and|then)\b|,/i).at(-1)??before;
  // Negating an omission asks for the embedded action; it does not prohibit it.
  const negationScope=clause.replace(/\b(?:do not|don't|never)\s+(?:forget|fail|neglect|omit)\s+to\s*$/i,'');
  if(/\b(?:\w+n't|dont|never|stop|no need to|not to|without)\b[^,]*$/i.test(negationScope))return true;
  if(/\b(?:do|did|will|would|should|have|has|had|is|are|was|were|can|could)\s+not\b/i.test(negationScope)
    || /\bnot\s+(?:\w+ly\s+|fucking\s+)*$/i.test(negationScope))return true;
  // Questions ABOUT an interruption are not instructions to send another one.
  const polite=/\b(?:can|could|would)\s+you\s*(?:please\s*)?$/i.test(before);
  if(/\b(?:did|do|does|will|have|has|had|is|are|was|were)(?:n't)?\s+(?:you|we|they|he|she|it)\b[^.!?;]*$/i.test(before))return true;
  if(/\b(?:why|how|when|where|who|what)\b[^,]*\b(?:can|could|would|should)\s+(?:you|we|they|he|she|it|i)\b[^,]*$/i.test(before))return true;
  // Reported speech, a past attempt, or another speaker's action is evidence, not a new ask.
  if(/\b(?:said|says|say|told|asked|wrote|writes|quoted|mentioned|heard)\b[^.!?]*$/i.test(clause))return true;
  if(/^\s*(?:i|we|you|they|he|she|it)\s+(?:(?:have|had|already|previously|just)\s+)*(?:said|says|told|asked|wrote|writes|quoted|mentioned|heard)\b/i.test(before))return true;
  // Dictated command names need not carry quotation marks. A description of the
  // system's configuration also does not issue the described interruption anew.
  if(/\b(?:about|use|using|type|typing)\s+(?:(?:the|only|just)\s+)*$/i.test(clause))return true;
  if(/^(?:notify me|ping me|alert me)\s+(?:design|command|wording|phrase)\b/i.test(words.slice(index)))return true;
  if(/^\s*(?:i|we|you|they|he|she|it)\s+(?:(?:have|had|already|previously)\s+)*(?:change[ds]?|configure[ds]?|design(?:ed|s)?|set|built|made|uses?)\b/i.test(before))return true;
  if(!polite&&/\b(?:was|were|already|trying to)\s+(?:\w+\s+){0,2}$/i.test(clause))return true;
  if(/\b(?:forgot|failed|neglected|tried|attempted|planned|intended|meant)\s+to\s*$/i.test(clause))return true;
  if(/\b(?:maybe|perhaps)\s*$/i.test(clause))return true;
  if(/^(?:notify me|ping me|alert me)\s+(?:is|was|means|as (?:a|the) command)\b/i.test(words.slice(index)))return true;
  if(/^\s*(?:he|she|they|it|we|you)\s+(?:always\s+|still\s+|also\s+|usually\s+)?$/i.test(clause))return true;
  if(/^\s*(?:he|she|they|it|we)\s+(?:will|would|should|must|can|could)\s*$/i.test(clause))return true;
  return false;
}

/** Historical rows without an admission mark retain the classifier that admitted them. */
export function legacyNotificationRequest(text:string):'result'|'scheduled'|null {
  if(/\bremind me\b/i.test(text))return 'scheduled';
  return /\b(?:notify me|send me (?:a |an )?notification|let me know|tell me when|tell me once|give me (?:a |an )?(?:update|notification) when)\b/i.test(text)?'result':null;
}
