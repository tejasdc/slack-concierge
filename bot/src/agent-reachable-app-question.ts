/**
 * The device category is for actions on a physical device, including starting an app there.
 * The first sentence asks for exactly one physical step ("Can you unlock your iPhone?" or
 * "Please unlock your iPhone."); later sentences may only report what the agent saw or will
 * do. On 2026-11-04 an agent whose phone check reported "locked" was refused for writing
 * "Please unlock your iPhone. The device check reached it and reported that it is locked."
 */
export function deviceQuestionNamesPhysicalPrerequisite(question:string):boolean {
  const [ask='',...context]=question.trim().split(/(?<=[?.!])\s+/);
  if(!context.every(isAgentStatement))return false;
  const consequence=/\bso\s+(?:(?:the|an)\s+)?(?:agent|I)\s+can\b/i.exec(ask);
  const tail=consequence?ask.slice(consequence.index+consequence[0].length):'';
  if(tail&&/\b(?:you|please)\b/i.test(tail))return false;
  const askedOfTejas=(consequence?ask.slice(0,consequence.index):ask).trim();
  const request=/^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)(.+?)\s*[?.!]?$/i.exec(askedOfTejas);
  if(!request)return false;
  const action=request[1]!.replace(/[?.!]$/,'').trim();
  // A spoken launch on an Echo is a physical check of Alexa's routing. The agent can
  // exercise the server and simulator, but neither proves what that Echo heard.
  const echoLaunch=/^(?:say|speak)\s+[“"']?Alexa,?\s+open\s+([\p{L}\p{N}][\p{L}\p{N} -]*?)[”"']?\s+to\s+(?:(?:your|the|my)\s+)?Echo(?:\s+(?:speaker|device))?$/iu.exec(action);
  if(echoLaunch&&!/\b(?:and|then)\b/i.test(echoLaunch[1]!))return true;
  if(/[,;]|\b(?:and|then|after that)\b/i.test(action))return false;
  const device='(?:Mac|iPhone|iPad|phone|screen|laptop|device)';
  const physicalAction=new RegExp(`^(?:unlock\\s+(?:(?:the|your|my)\\s+)?(?:physical\\s+)?${device}|take\\s+(?:a\\s+)?photo(?:\\s+of\\s+[^?.!]+)?|photograph\\s+[^?.!]+|plug\\s+in\\s+(?:(?:the|a|your)\\s+)?(?:cable|device|phone|iPhone|iPad)|connect\\s+(?:(?:the|a|your)\\s+)?(?:cable|device|phone|iPhone|iPad)|press\\s+(?:(?:the|a)\\s+)?(?:physical|hardware)\\s+button|(?:bring|move|hold|hand\\s+over)\\s+(?:(?:the|your|my)\\s+)?${device})$`,'i');
  if(physicalAction.test(action))return true;
  // Starting an app on an e-reader, watch or TV can be the physical prerequisite
  // that exposes its agent connection. Ordinary computers and phones have agent routes.
  return /^(?:open|start|launch)\s+[^?.!,;]+?\s+(?:once\s+)?on\s+(?:(?:your|the|my)\s+)?(?:Kindle|Kobo|e-?reader|smartwatch|watch|TV|television)(?:\s+[\p{L}\p{N}.'-]+)*$/iu.test(action);
}

/** Context after the ask: a statement by the agent about itself or the device, never a second ask of him. */
function isAgentStatement(sentence:string):boolean {
  return !/\?\s*$/.test(sentence)
    &&!/\b(?:you|please|then)\b/i.test(sentence)
    &&/^(?:I|I'm|I'll|I've|I\s+will|We|The|This|That|It|It's|Its|My|Our|Nothing|No|Everything|Other|Every|All)\b/i.test(sentence);
}
