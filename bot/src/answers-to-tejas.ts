import { db } from './state';
import { getAcceptedSessionInput, humanAuthored, sessionInputProvenance, type AcceptedSessionInput } from './session-inputs';

/**
 * What an agent must attach before something reaches Tejas as a question or as "done".
 * A required field is the system here: on 2026-09-29 three questions in one thread asked him
 * what his own words had already answered, and "done" reports kept reaching him before anyone
 * had used the change. His words that day: "adding a check for agents now is … a good idea
 * because agents are, like, making too many dumb mistakes for me to keep catching."
 */

const QUESTION_FIELDS_REQUIRED =
  'A question reaches Tejas only with the words of his that started this work and why they do not already answer it. '
  + 'Add --his-words "<his exact words, copied from his message>" --why-not-answered "<what his words leave open that only he can decide>". '
  + 'If his words already answer it, act on them instead of asking.';

const CHECK_REQUIRED =
  'Completed work says what was checked on the real system. Add --checked "<what you ran on the live system, through your own '
  + 'marked entrance where it is his surface, and what you saw>", or --not-checked "<why no live check was possible>" when none was. '
  + 'Do not write unit tests to fill this.';

/** Letters and digits only, so a quote survives punctuation, casing and line breaks. */
function normalized(text: string) {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function wordsOf(input: AcceptedSessionInput): string {
  let payload: any = {};
  try { payload = JSON.parse(input.payload_json); } catch {}
  const parts = [typeof payload.text === 'string' ? payload.text : '', typeof payload.content === 'string' ? payload.content : ''];
  const attachments: string[] = Array.isArray(payload.attachments) ? payload.attachments.filter((id: unknown) => typeof id === 'string') : [];
  for (const id of attachments) {
    const row = db.query('SELECT transcript_text FROM session_attachments WHERE id=?').get(id) as { transcript_text: string | null } | null;
    if (row?.transcript_text) parts.push(row.transcript_text);
  }
  return parts.join('\n');
}

type Verdict = 'his' | 'not-his' | 'unverifiable';

/**
 * Whether a quote is really his: first the message that started this work, then anything he sent
 * in the last thirty days (a thread's question can rest on an earlier message of his). Work whose
 * originating message lives on the other machine cannot be checked here and is taken as given.
 */
function quoteVerdict(actorInputId: string, quote: string): Verdict {
  const wanted = normalized(quote);
  const actor = getAcceptedSessionInput(actorInputId);
  if (!actor) return 'unverifiable';
  const origin = humanAuthored(actor) ? actor : (() => {
    const human = sessionInputProvenance(actor)?.originatingHuman;
    return human ? getAcceptedSessionInput(human.inputId) : null;
  })();
  if (origin && normalized(wordsOf(origin)).includes(wanted)) return 'his';
  const provenance = humanAuthored(actor) ? null : sessionInputProvenance(actor);
  if (provenance?.peer || (provenance?.originatingHuman && !origin)) return 'unverifiable';
  const recent = db.query(`SELECT * FROM session_inputs WHERE origin='human' AND created_at >= datetime('now','-30 days') ORDER BY rowid DESC`).all() as AcceptedSessionInput[];
  return recent.some(input => humanAuthored(input) && normalized(wordsOf(input)).includes(wanted)) ? 'his' : 'not-his';
}

/**
 * The question as he will read it: the agent's question, then his words and why they leave it
 * open. Refuses when either field is missing or the quoted words are not his.
 */
export function questionForTejas(input: { actorInputId: string; question: string; hisWords?: string; whyNotAnswered?: string }): string {
  const { hisWords, why } = requireHisWords(input);
  return `${input.question.trim()}\n\n${hisWordsLine(hisWords, why)}`;
}

/** The two fields every question to him carries, checked; throws what is missing or wrong. */
export function requireHisWords(input: { actorInputId: string; hisWords?: string; whyNotAnswered?: string }, fieldNames = QUESTION_FIELDS_REQUIRED) {
  const hisWords = input.hisWords?.trim() ?? '', why = input.whyNotAnswered?.trim() ?? '';
  if (!hisWords || !why) throw new Error(fieldNames);
  if (normalized(hisWords).split(' ').length < 2) throw new Error('His words must quote at least a phrase of his, not a single word.');
  if (quoteVerdict(input.actorInputId, hisWords) === 'not-his')
    throw new Error('His words must be copied exactly from a message Tejas sent (the one that started this work, or another of his from the last thirty days); these words are not in any of them.');
  return { hisWords, why };
}

export const hisWordsLine = (hisWords: string, why: string) => `Your words: “${hisWords}”\nWhy they don't settle it: ${why}`;

export const THREAD_QUESTION_FIELDS_REQUIRED =
  'A decision question reaches Tejas only with the words of his that started this work and why they do not already answer it: '
  + 'add "hisWords" (copied exactly from his message) and "whyNotSettled" (what his words leave open that only he can decide) to the declaration, '
  + 'or declare it agent_checking while you work it out. If his words already answer it, act on them instead of asking.';

/** Completed work as it will be read: the answer, then what was checked live (or why nothing was). */
export function completionWithCheck(input: { text: string; checked?: string; notChecked?: string }): string {
  const checked = input.checked?.trim() ?? '', notChecked = input.notChecked?.trim() ?? '';
  if (checked && notChecked) throw new Error('Give either --checked or --not-checked, not both.');
  if (!checked && !notChecked) throw new Error(CHECK_REQUIRED);
  return `${input.text.trim()}\n\n${checked ? `Checked on the real system: ${checked}` : `Not checked live: ${notChecked}`}`;
}
