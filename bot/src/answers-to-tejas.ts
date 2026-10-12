import { db } from './state';
import { approvalDecision, decisionRecord, decisionSection } from './decision-approval';
import { getAcceptedSessionInput, humanAuthored, sessionInputProvenance, type AcceptedSessionInput } from './session-inputs';

/**
 * What an agent must attach before something reaches Tejas as a question or as "done".
 * A required field is the system here: on 2026-09-29 three questions in one thread asked him
 * what his own words had already answered, and "done" reports kept reaching him before anyone
 * had used the change. His words that day: "adding a check for agents now is … a good idea
 * because agents are, like, making too many dumb mistakes for me to keep catching."
 */

/**
 * What only he can do, or a permanent decision reserves for him. Routine permission requests
 * are excluded: on 2026-10-04 he said "i don't want anymore permission requests or
 * notifications, just do as I say and fix or build things if it's not possible. Ask for
 * forgiveness not permission" [decision: act-then-tell].
 */
export const ONLY_HE_CAN = {
  'sign-in': 'sign in or approve something on one of his own accounts',
  secret: 'give a password, key or code only he has',
  device: 'do something on his own phone or Mac, or in person',
  ambiguous: 'choose between readings of his words that lead to different things that cannot be undone (which person, which account)',
  approval: 'approve an action that a permanent decision reserves for him',
} as const;
export type OnlyHeCan = keyof typeof ONLY_HE_CAN;
const ONLY_HE_CAN_REQUIRED = 'A question reaches Tejas only for something no agent can do. Add --only-he-can with one of: '
  + Object.entries(ONLY_HE_CAN).map(([kind, meaning]) => `${kind} (${meaning})`).join('; ')
  + '. Approval requires --decision-id and --approval-action, verified against a permanent decision record. Other permission and design questions are refused [decision: act-then-tell].';

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
export function questionForTejas(input: { actorInputId: string; question: string; hisWords?: string; whyNotAnswered?: string; onlyHeCan?: string; decisionId?: string; approvalAction?: string }): string {
  const kind = requireOnlyHeCan(input.onlyHeCan);
  if (kind !== 'approval' && (input.decisionId !== undefined || input.approvalAction !== undefined))
    throw new Error('--decision-id and --approval-action belong to --only-he-can approval.');
  const decision = kind === 'approval' ? approvalDecision(input.decisionId, input.approvalAction) : undefined;
  const { hisWords, why } = requireHisWords(input, QUESTION_FIELDS_REQUIRED, decision);
  const citation = decision ? `\nRequired by permanent decision: ${decision} (${input.approvalAction})` : '';
  return `${input.question.trim()}\n\n${hisWordsLine(hisWords, why)}\nOnly you can: ${ONLY_HE_CAN[kind]}${citation}`;
}

/** The kind of thing only he can do; anything else is refused with the list. */
export function requireOnlyHeCan(kind: unknown, message = ONLY_HE_CAN_REQUIRED): OnlyHeCan {
  if (typeof kind === 'string' && Object.hasOwn(ONLY_HE_CAN, kind.trim())) return kind.trim() as OnlyHeCan;
  throw new Error(message);
}

/** The two fields every question to him carries, checked; throws what is missing or wrong. */
export function requireHisWords(input: { actorInputId: string; hisWords?: string; whyNotAnswered?: string }, fieldNames = QUESTION_FIELDS_REQUIRED, decisionId?: string) {
  const hisWords = input.hisWords?.trim() ?? '', why = input.whyNotAnswered?.trim() ?? '';
  if (!hisWords || !why) throw new Error(fieldNames);
  if (normalized(hisWords).split(' ').length < 2) throw new Error('His words must quote at least a phrase of his, not a single word.');
  const verdict=quoteVerdict(input.actorInputId, hisWords);
  const decisionWords=decisionId?normalized(decisionSection(decisionRecord(decisionId),'Words')):'';
  if (decisionId ? verdict!=='his'&&!decisionWords.includes(normalized(hisWords)) : verdict==='not-his')
    throw new Error('His words must be copied exactly from a message Tejas sent (the one that started this work, or another of his from the last thirty days); these words are not in any of them.');
  return { hisWords, why };
}

export const hisWordsLine = (hisWords: string, why: string) => `Your words: “${hisWords}”\nWhy they don't settle it: ${why}`;

export const THREAD_QUESTION_FIELDS_REQUIRED =
  'A decision question reaches Tejas only for something no agent can do or a permanent decision reserves for him, with his words and why they do not settle it: '
  + 'add "onlyHeCan" (' + Object.keys(ONLY_HE_CAN).join(', ') + '), "hisWords" (copied exactly from his message) and "whyNotSettled" to the declaration. '
  + 'Approval also needs "decisionId" and "approvalAction", checked against the permanent record. Other permission and design questions are refused.';

const NOT_ALL_DONE =
  'Completed means everything he asked for was done. Add --all-done when it was. When part of it was not, it is not completed: '
  + 'do that part, or get the missing ability built (a writing session replies --work-disposition failed naming what is missing, and the Inbox '
  + 'routes the building), or reply --work-disposition failed saying what was not done. Ask him (needs_decision) only for something no agent can '
  + 'do, or a permanent approval rule reserves for him: ' + Object.keys(ONLY_HE_CAN).join(', ') + '. A "done" that left out part of his request reached him twice in one week (2026-09-29, 2026-10-02).';

/** Completed work as it will be read: the answer, then what was checked live (or why nothing was). */
export function completionWithCheck(input: { text: string; checked?: string; notChecked?: string; allDone?: boolean }): string {
  if (input.allDone !== true) throw new Error(NOT_ALL_DONE);
  const checked = input.checked?.trim() ?? '', notChecked = input.notChecked?.trim() ?? '';
  if (checked && notChecked) throw new Error('Give either --checked or --not-checked, not both.');
  if (!checked && !notChecked) throw new Error(CHECK_REQUIRED);
  return `${input.text.trim()}\n\n${checked ? `Checked on the real system: ${checked}` : `Not checked live: ${notChecked}`}`;
}
