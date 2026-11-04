/** The device category is for physical prerequisites; app actions stay with the agent. */
export function deviceQuestionNamesPhysicalPrerequisite(question:string):boolean {
  const consequence=/\bso\s+(?:(?:the|an)\s+)?(?:agent|I)\s+can\b/i.exec(question);
  const tail=consequence?question.slice(consequence.index+consequence[0].length):'';
  if(tail&&(/[?!.]\s*\S/.test(tail)||/\b(?:you|please)\b/i.test(tail)))return false;
  const askedOfTejas=(consequence?question.slice(0,consequence.index):question).trim();
  const request=/^(?:can|could|would|will)\s+you\s+(?:please\s+)?(.+?)\s*\??$/i.exec(askedOfTejas);
  if(!request)return false;
  const action=request[1]!.replace(/[?.!]$/,'').trim();
  if(/[,;]|\b(?:and|then|after that)\b/i.test(action))return false;
  return /^(?:unlock\s+(?:(?:the|your|my)\s+)?(?:physical\s+)?(?:Mac|phone|screen|laptop|device)|take\s+(?:a\s+)?photo(?:\s+of\s+[^?.!]+)?|photograph\s+[^?.!]+|plug\s+in\s+(?:(?:the|a)\s+)?(?:cable|device|phone)|connect\s+(?:(?:the|a)\s+)?(?:cable|device|phone)|press\s+(?:(?:the|a)\s+)?(?:physical|hardware)\s+button|(?:bring|move|hold|hand\s+over)\s+(?:(?:the|your|my)\s+)?(?:device|phone|Mac|laptop))$/i.test(action);
}
