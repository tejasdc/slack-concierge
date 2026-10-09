import { db } from './state';
import { getAcceptedSessionInput, humanAuthored, sessionInputProvenance, type AcceptedSessionInput } from './session-inputs';

/**
 * What an agent must attach before something reaches Tejas as a question or as "done".
 * A required field is the system here: on 2026-09-29 three questions in one thread asked him
 * what his own words had already answered, and "done" reports kept reaching him before anyone
 * had used the change. His words that day: "adding a check for agents now is … a good idea
 * because agents are, like, making too many dumb mistakes for me to keep catching."
 */

/**
 * What only he can do, the only grounds for a question to him. Permission and approval are not
 * on the list: on 2026-10-04 he said "i don't want anymore permission requests or
 * notifications, just do as I say and fix or build things if it's not possible. Ask for
 * forgiveness not permission" [decision: act-then-tell].
 */
export const ONLY_HE_CAN = {
  'sign-in': 'sign in or approve something on one of his own accounts',
  secret: 'give a password, key or code only he has',
  device: 'do something on his own phone or Mac, or in person',
  ambiguous: 'choose between readings of his words that lead to different things that cannot be undone (which person, which account)',
} as const;
export type OnlyHeCan = keyof typeof ONLY_HE_CAN;
const ONLY_HE_CAN_REQUIRED = 'A question reaches Tejas only for something no agent can do. Add --only-he-can with one of: '
  + Object.entries(ONLY_HE_CAN).map(([kind, meaning]) => `${kind} (${meaning})`).join('; ')
  + '. Permission, approval and design choices are not among them: he said "just do as I say and fix or build things if it\'s not possible. Ask for forgiveness not permission". Do the work, build what is missing, and tell him afterwards.';

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
export function questionForTejas(input: { actorInputId: string; question: string; hisWords?: string; whyNotAnswered?: string; onlyHeCan?: string }): string {
  const kind = requireOnlyHeCan(input.onlyHeCan);
  const { hisWords, why } = requireHisWords(input);
  return `${input.question.trim()}\n\n${hisWordsLine(hisWords, why)}\nOnly you can: ${ONLY_HE_CAN[kind]}`;
}

/** The kind of thing only he can do; anything else is refused with the list. */
export function requireOnlyHeCan(kind: unknown, message = ONLY_HE_CAN_REQUIRED): OnlyHeCan {
  if (typeof kind === 'string' && Object.hasOwn(ONLY_HE_CAN, kind.trim())) return kind.trim() as OnlyHeCan;
  throw new Error(message);
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
  'A decision question reaches Tejas only for something no agent can do, with the words of his that started this work and why they do not settle it: '
  + 'add "onlyHeCan" (' + Object.keys(ONLY_HE_CAN).join(', ') + '), "hisWords" (copied exactly from his message) and "whyNotSettled" to the declaration. '
  + 'Permission, approval and design choices are not questions: do the work and tell him afterwards.';

const NOT_ALL_DONE =
  'Completed means everything he asked for was done. Add --all-done when it was. When part of it was not, it is not completed: '
  + 'do that part, or get the missing ability built (a writing session replies --work-disposition failed naming what is missing, and the Inbox '
  + 'routes the building), or reply --work-disposition failed saying what was not done. Ask him (needs_decision) only for something no agent can '
  + 'do: ' + Object.keys(ONLY_HE_CAN).join(', ') + '. A "done" that left out part of his request reached him twice in one week (2026-09-29, 2026-10-02).';

/**
 * An answer he reads gives the reason for each choice it reports, because choices kept reaching
 * him without one. His words, 2026-10-09: "a lot of different choices, choices don't even have a
 * rational when you, when you give this response to me ... Tell me why this was chosen"; and on
 * 2026-09-25: "I don't know why and who is coming up with this design, and what it's based on".
 */
const WHY_REQUIRED =
  'An answer Tejas reads gives the reason for each choice it reports. Add --why "<each choice this answer reports or made on his behalf: '
  + 'what was chosen, why, and what it was chosen over>", or --no-choices "<why this answer reports no design or approach choice>" '
  + '(a fact lookup, a send that went exactly as he asked). His words: "a lot of different choices, choices don\'t even have a rational '
  + 'when you, when you give this response to me ... Tell me why this was chosen". Before choosing a design on his behalf, load the '
  + 'interface-decisions skill; its taste profile says what he wants and why.';

/**
 * The reasons line under an answer he reads: `--why` is shown as "Why this way:"; `--no-choices`
 * is kept on the record but shows nothing, because he does not want words about nothing.
 */
export function reasonsFor(input: { why?: string; noChoices?: string }): { line: string | null; noChoices: string | null } {
  const why = input.why?.trim() ?? '', noChoices = input.noChoices?.trim() ?? '';
  if (why && noChoices) throw new Error('Give either --why or --no-choices, not both.');
  if (!why && !noChoices) throw new Error(WHY_REQUIRED);
  return { line: why ? `Why this way: ${why}` : null, noChoices: noChoices ? noChoices.slice(0, 2000) : null };
}

/**
 * Completed work as it will be read: the answer, why each choice was made, then what was checked
 * live (or why nothing was). A quiet completion is not read by him, so it owes no reasons.
 */
export function completionWithCheck(input: { text: string; checked?: string; notChecked?: string; allDone?: boolean; why?: string; noChoices?: string; quiet?: boolean }): string {
  if (input.allDone !== true) throw new Error(NOT_ALL_DONE);
  const checked = input.checked?.trim() ?? '', notChecked = input.notChecked?.trim() ?? '';
  if (checked && notChecked) throw new Error('Give either --checked or --not-checked, not both.');
  if (!checked && !notChecked) throw new Error(CHECK_REQUIRED);
  const reasons = input.quiet && !input.why?.trim() && !input.noChoices?.trim() ? null : reasonsFor(input).line;
  return `${input.text.trim()}\n\n${reasons ? `${reasons}\n` : ''}${checked ? `Checked on the real system: ${checked}` : `Not checked live: ${notChecked}`}`;
}
