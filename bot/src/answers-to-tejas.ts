import { db } from './state';
import { approvalDecision, decisionRecord, decisionSection } from './decision-approval';
import { getAcceptedSessionInput, humanAuthored, sessionInputProvenance, type AcceptedSessionInput } from './session-inputs';
import { deviceQuestionNamesPhysicalPrerequisite } from './agent-reachable-app-question';

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
  device: 'unlock his device or do a physical action an agent cannot perform',
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
  + 'When the reply is only an answer and you changed nothing (no code, setting, data or message sent), give '
  + '--nothing-changed "<what the answer rests on>" instead. Do not write unit tests to fill this.';

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

function completeMessageWordsOf(input: AcceptedSessionInput): string[] {
  let payload: any = {};
  try { payload = JSON.parse(input.payload_json); } catch {}
  return [payload.text, payload.content].filter((part): part is string => typeof part === 'string');
}

type Verdict = 'his' | 'not-his' | 'unverifiable';

/**
 * Whether a quote is really his: first the message that started this work, then anything he sent
 * in the last thirty days (a thread's question can rest on an earlier message of his). Work whose
 * originating message lives on the other machine cannot be checked here and is taken as given.
 */
function quoteVerdict(actorInputId: string, quote: string, wholeMessageOnly = false): Verdict {
  const wanted = normalized(quote);
  const matches = (input: AcceptedSessionInput) => {
    if (wholeMessageOnly) return completeMessageWordsOf(input).some(words => normalized(words) === wanted)
      || normalized(wordsOf(input)) === wanted;
    return normalized(wordsOf(input)).includes(wanted);
  };
  const actor = getAcceptedSessionInput(actorInputId);
  if (!actor) return 'unverifiable';
  const origin = humanAuthored(actor) ? actor : (() => {
    const human = sessionInputProvenance(actor)?.originatingHuman;
    return human ? getAcceptedSessionInput(human.inputId) : null;
  })();
  if (origin && humanAuthored(origin) && matches(origin)) return 'his';
  const provenance = humanAuthored(actor) ? null : sessionInputProvenance(actor);
  if (provenance?.peer || (provenance?.originatingHuman && !origin)) return 'unverifiable';
  const recent = db.query(`SELECT * FROM session_inputs WHERE origin='human' AND created_at >= datetime('now','-30 days') ORDER BY rowid DESC`).all() as AcceptedSessionInput[];
  return recent.some(input => humanAuthored(input) && matches(input)) ? 'his' : 'not-his';
}

/**
 * The question as he will read it: the agent's question, then his words and why they leave it
 * open. Refuses when either field is missing or the quoted words are not his.
 */
export function questionForTejas(input: { actorInputId: string; question: string; lead?: string; hisWords?: string; whyNotAnswered?: string; onlyHeCan?: string; decisionId?: string; approvalAction?: string }): string {
  const kind = requireOnlyHeCan(input.onlyHeCan);
  if(kind==='device'&&!deviceQuestionNamesPhysicalPrerequisite(input.question))
    throw new Error('Only-he-can device questions ask for one action on a physical device in their first sentence, such as "Please unlock your iPhone.", "Can you unlock your Mac so I can continue?" or one tap, press, click, drag or plug-in that names his device ("Please drag the screenshot thumbnail onto the Desktop on your Mac."); later sentences may only state what you saw or will do, never ask him for more. Try the available agent route first, then explain in --why-not-answered why only Tejas can take this step.');
  if (kind !== 'approval' && (input.decisionId !== undefined || input.approvalAction !== undefined))
    throw new Error('--decision-id and --approval-action belong to --only-he-can approval.');
  const decision = kind === 'approval' ? approvalDecision(input.decisionId, input.approvalAction) : undefined;
  const { hisWords, why } = requireHisWords(input, QUESTION_FIELDS_REQUIRED, decision);
  const citation = decision ? `\nRequired by permanent decision: ${decision} (${input.approvalAction})` : '';
  return `${leadFirst(input.lead, input.question)}\n\n${hisWordsLine(hisWords, why)}\nOnly you can: ${ONLY_HE_CAN[kind]}${citation}`;
}

/**
 * The agent's one-line summary first, then its text: his phone notice shows the start of a question,
 * and on 2026-11-02 a decision whose text opened with an unrelated email paragraph never showed him
 * the class result. Replies already require that line; a needs_you outcome requires it too.
 */
export function leadFirst(lead: string | undefined, text: string): string {
  const line = lead?.trim() ?? '', body = text.trim();
  if (!line) return body;
  return !body || normalized(body).startsWith(normalized(line)) ? (body || line) : `${line}\n\n${body}`;
}

export const NEEDS_YOU_SUMMARY_REQUIRED =
  'needs_you leads with --summary "<one line, at most 200 characters: what he must decide and the result it depends on>"; it opens his phone notice, so background and other news go in the text after it.';

/** The kind of thing only he can do; anything else is refused with the list. */
export function requireOnlyHeCan(kind: unknown, message = ONLY_HE_CAN_REQUIRED): OnlyHeCan {
  if (typeof kind === 'string' && Object.hasOwn(ONLY_HE_CAN, kind.trim())) return kind.trim() as OnlyHeCan;
  throw new Error(message);
}

/** The two fields every question to him carries, checked; throws what is missing or wrong. */
export function requireHisWords(input: { actorInputId: string; hisWords?: string; whyNotAnswered?: string }, fieldNames = QUESTION_FIELDS_REQUIRED, decisionId?: string) {
  const hisWords = input.hisWords?.trim() ?? '', why = input.whyNotAnswered?.trim() ?? '';
  if (!hisWords || !why) throw new Error(fieldNames);
  const singleWord = !normalized(hisWords).includes(' ');
  const verdict=quoteVerdict(input.actorInputId, hisWords, singleWord);
  if (singleWord && verdict !== 'his')
    throw new Error('A one-word quote must be the complete text of a retained message Tejas sent, not a fragment or an unverifiable message.');
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

/**
 * How a completed reply was verified: a live check, an honest reason none was possible, or the
 * replier's claim that the reply is only an answer and nothing was changed. The third exists
 * because an answer to his question has nothing to see working, and an honest not-checked reason
 * on it held his question open for a verification nobody could do (2026-11-05, req:forward:c3148684).
 * Not-checked keeps meaning "a change exists that nobody has seen working".
 */
export type CompletionCheck = { checked?: string; notChecked?: string; nothingChanged?: string };

function onlyCheck(input: CompletionCheck): string {
  const given = ([['Checked on the real system: ', input.checked], [NOT_CHECKED_LIVE, input.notChecked], [NOTHING_CHANGED, input.nothingChanged]] as const)
    .map(([label, value]) => [label, value?.trim() ?? ''] as const).filter(([, value]) => value);
  if (given.length > 1) throw new Error('Give one of --checked, --not-checked or --nothing-changed, not several.');
  if (!given.length) throw new Error(CHECK_REQUIRED);
  return `${given[0][0]}${given[0][1]}`;
}

/** Completed work as it will be read: the answer, then what was checked live (or why nothing was). */
export function completionWithCheck(input: CompletionCheck & { text: string; allDone?: boolean }): string {
  if (input.allDone !== true) throw new Error(NOT_ALL_DONE);
  return `${input.text.trim()}\n\n${onlyCheck(input)}`;
}

const NOT_CHECKED_LIVE = 'Not checked live: ';
const NOTHING_CHANGED = 'Answered; nothing was changed: ';
const COMPLETED_CLOSING = 'Completed · ';
/** The line that closes a final reply, kept on its stored result so later readers know how it ended. */
export function finalClosingLine(disposition: string, check: CompletionCheck = {}): string {
  return disposition === 'completed'
    ? `${COMPLETED_CLOSING}${onlyCheck(check)}`
    : disposition === 'failed' ? 'Failed' : 'Needs your decision';
}
/**
 * Why completed work has not been seen working, or null when it was checked live. Read from the
 * closing line this file wrote, on local and peer results alike.
 */
export function notSeenWorking(closingLine: unknown): string | null {
  const prefix = `${COMPLETED_CLOSING}${NOT_CHECKED_LIVE}`;
  return typeof closingLine === 'string' && closingLine.startsWith(prefix) ? closingLine.slice(prefix.length).trim() || null : null;
}
