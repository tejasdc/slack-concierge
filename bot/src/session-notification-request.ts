/** An explicit request to interrupt him when this work has an answer. Derived only from his
 * retained words, so an agent's wording or outcome cannot opt a routine turn into a push. */
export function notificationRequest(text:string):'result'|'scheduled'|null {
  if(/\bremind me\b/i.test(text))return 'scheduled';
  return /\b(?:notify me|send me (?:a |an )?notification|let me know|tell me when|tell me once|give me (?:a |an )?(?:update|notification) when)\b/i.test(text)?'result':null;
}
