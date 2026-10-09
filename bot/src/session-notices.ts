import { getSessionById } from './state';
import { sessionMetadata } from './session-inputs';

/**
 * The words Concierge writes into an agent's conversation when an answer or a cancellation
 * reaches it. They are plain sentences naming things by what they are (the request's own
 * one-line summary, the other session's title), never by request, event or session numbers:
 * the message's identity header already carries the exact request, its origin and its
 * authority, which is what keeps an agent from mistaking a notice for Tejas's instruction.
 * Repeating that in prose ("This is a system notice, not new authorization", "Session final
 * event <id> for request <id>") added nothing an agent acts on and leaked numbers into his
 * ChatGPT conversations (Tejas, 2026-10-09: "stop talking to it as … a robot … why is there
 * … request ID, the session ID?"). A number appears only where the agent must type it.
 */

/** A request named by its one-line summary, or the start of its words when it has none. */
export function requestLabel(payloadJson: string): string {
    let payload: any = {};
    try { payload = JSON.parse(payloadJson); } catch { /* an unreadable payload still gets a label */ }
    const words = String(payload.summary || payload.text || '').replace(/\s+/g, ' ').trim();
    if (!words) return 'your request';
    return `your request “${words.length > 100 ? `${words.slice(0, 99).trimEnd()}…` : words}”`;
}

/** A local session named by its title. */
export function sessionLabel(sessionId: number): string {
    const session = getSessionById(sessionId);
    const title = session ? sessionMetadata(session).title : null;
    return typeof title === 'string' && title.trim() ? `“${title.trim()}”` : 'the session you asked';
}

function joinLabels(labels: string[]): string {
    if (labels.length <= 1) return labels[0] ?? 'your request';
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} (one answer for all of them)`;
}

/** What an asker reads when an answer, a stall or the owner's own close of its request arrives. */
export function answerNotice(input: {
    responder: string; labels: string[]; kind: string; stalled: boolean; body: string;
    outcome?: string | null; workDisposition?: string | null; deliveryNote?: string | null;
    files: number; followUp?: string | null;
}): string {
    const requests = joinLabels(input.labels);
    const ending = input.workDisposition ?? input.outcome ?? null;
    const opening = input.stalled ? `${input.responder} has gone quiet on ${requests}.`
        : input.kind === 'overdue' ? `About ${requests}, still with ${input.responder}:`
        : ending === 'completed' || ending === 'answered' ? `${input.responder} answered ${requests}.`
        : ending === 'failed' ? `${input.responder} could not finish ${requests}.`
        : ending === 'needs_decision' || ending === 'decision_needed' ? `${input.responder} needs a decision before it can finish ${requests}.`
        : ending === 'canceled' ? `${requests[0]!.toUpperCase()}${requests.slice(1)} was stopped.`
        : `${input.responder} ended ${requests} without saying whether it is done.`;
    const notes = [
        input.files ? `${input.files === 1 ? 'A file comes' : `${input.files} files come`} with it.` : '',
        input.deliveryNote ?? '',
        input.followUp ? `To follow up, ask them at ${input.followUp}.` : '',
        'You do not need to reply to this.',
    ].filter(Boolean).join(' ');
    return `${opening}\n\n${input.body.trim()}\n\n${notes}`;
}

/** What a worker reads when the session that asked withdraws its request. */
export function canceledNotice(label: string, requester: string): string {
    const withdrawn = label.replace(/^your request/, 'the request');
    return `${requester[0]!.toUpperCase()}${requester.slice(1)} withdrew ${withdrawn}. Please stop working on it; there is nothing to reply, and a reply now would not be accepted.`;
}
