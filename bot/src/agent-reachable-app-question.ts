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
  // One hand gesture on a device he names as his, such as dragging a macOS screenshot
  // thumbnail or tapping a control on his iPhone, is physical work when the agent's
  // route cannot make it (Mac agents may not take Accessibility control of his apps).
  // The device must be named, so "click the button in the app" still stays with the agent.
  // Any thing he owns counts as his device unless its name is a software or online surface:
  // on 2026-11-20 "Please turn on Tailscale on your Fire tablet." was refused four times
  // because the device had to come from a fixed list of product names.
  const gesture=/^(?:tap|double[- ]tap|long[- ]press|press(?:\s+and\s+hold)?|hold\s+down|click|double[- ]click|right[- ]click|drag|swipe|pinch|scroll|plug\s+in|unplug|insert|eject|turn\s+(?:on|off)|restart|reboot|charge|wake)\b/i;
  if(gesture.test(action)&&namesHisDevice(action))return true;
  // A named instrument or controller is physical when the requested connection
  // names both the host device and the cable transport. The noun itself need not
  // belong to a product allowlist.
  const connection=/^(?:connect|plug(?: in)?)\s+(?:(?:the|a|your|my)\s+)?([\p{L}\p{N}][\p{L}\p{N} +'’.-]*?)\s+(?:to|into)\s+(?:(?:the|your|my)\s+)?(?:Mac|laptop|computer|iPhone|iPad|phone|device)\s+(?:(?:over|via)\s+USB(?:-C)?|with\s+(?:(?:a|the|your)\s+)?USB(?:-C)?\s+cable)$/iu.exec(action);
  if(connection&&!/\b(?:account|website|app|service|network)\b/i.test(connection[1]!))return true;
  // Starting an app on an e-reader, watch or TV can be the physical prerequisite
  // that exposes its agent connection. Ordinary computers and phones have agent routes.
  return /^(?:open|start|launch)\s+[^?.!,;]+?\s+(?:once\s+)?on\s+(?:(?:your|the|my)\s+)?(?:Kindle|Kobo|e-?reader|smartwatch|watch|TV|television)(?:\s+[\p{L}\p{N}.'-]+)*$/iu.test(action);
}

/** Words that end the noun after "your": the next phrase of the sentence, not the device's name. */
const PHRASE_BREAK=/^(?:on|in|from|to|into|onto|of|at|with|so|and|then|the|a|an|for|until|while|when|if|once|again|now|please)$/i;
/** What an agent reaches without his hands: software, accounts and places inside a computer. */
const NOT_A_DEVICE=/^(?:apps?|application|account|website|site|web|page|browser|tab|window|inbox|e-?mail|mail|chat|settings|dashboard|profile|server|service|session|repo|repository|network|terminal|folder|file|files|document|doc|calendar|cloud|drive|chrome|safari|gmail|slack|thread|thinkering|behalf|password|code|link|feed|library|downloads|finder)$/i;

/**
 * Whether the action names a thing of his ("on your Fire tablet", "of your Mac’s screen") whose
 * name is not a software or online surface. The noun phrase is the words after "your"/"my" up to
 * the next preposition or connective; every word in it must be a physical name.
 */
function namesHisDevice(action:string):boolean {
  for(const match of action.matchAll(/\b(?:on|in|from|to|into|onto|of|at)\s+(?:the\s+)?(?:your|my)\s+(?:physical\s+)?([^?.!,;]+)/giu)){
    const words:string[]=[];
    for(const word of match[1]!.trim().split(/\s+/)){
      if(PHRASE_BREAK.test(word)||words.length===3)break;
      words.push(word.replace(/['’]s$/u,''));
      if(/['’]s$/u.test(word))break;
    }
    if(words.length&&words.every(word=>/^[\p{L}\p{N}][\p{L}\p{N}+.-]*$/u.test(word)&&!NOT_A_DEVICE.test(word)))return true;
  }
  return false;
}

/**
 * Context after the ask: a statement by the agent about itself or the device, never a second ask
 * of him. The sentence's own subject keeps "Then open the app." out, so "then" inside the agent's
 * plan is allowed: on 2026-11-20 "I will have a Mac agent write it …, then point the server's
 * printer straight at the printer once the Pi is online." was refused for that word alone.
 */
function isAgentStatement(sentence:string):boolean {
  return !/\?\s*$/.test(sentence)
    &&!/\b(?:you|please)\b/i.test(sentence)
    &&/^(?:I|I'm|I'll|I've|I\s+will|We|An?|The|This|That|It|It's|Its|My|Our|Nothing|No|Everything|Other|Every|All)\b/i.test(sentence);
}
