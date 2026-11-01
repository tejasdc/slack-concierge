import { db } from './state';
import { inboxSession } from './session-inbox';
import { recordSessionEvent } from './session-inputs';
import { ledgerDurable } from './ledger-durability-barrier';
import type { TerminalHumanCommandStatus } from './human-command-worker';

function eventSession(scope: string): number {
  const local = /^concierge:([1-9][0-9]*)$/.exec(scope);
  if (local) {
    const row = db.query('SELECT id FROM sessions WHERE id=?').get(Number(local[1])) as { id: number } | null;
    if (row) return row.id;
  }
  if (scope.startsWith('topic:')) {
    const topic = db.query('SELECT session_id FROM inbox_topics WHERE topic_id=?').get(scope) as { session_id: number } | null;
    if (topic) return topic.session_id;
  }
  // Creation and global commands have no existing target session. Their browser identity
  // remains in the payload; the Inbox is only the required stream anchor.
  const inbox = inboxSession();
  if (!inbox) throw new Error('No session anchors terminal human command events.');
  return inbox.id;
}

/** Publication is idempotent; the capture outbox is acknowledged only after ledger durability. */
export async function publishHumanCommandTerminalEvent(command: TerminalHumanCommandStatus): Promise<void> {
  const eventId = `human-command:${command.actionId}:terminal`;
  const prior = db.query('SELECT session_id FROM session_owner_events WHERE event_id=?').get(eventId) as { session_id: number } | null;
  recordSessionEvent({
    eventId,
    sessionId: prior?.session_id ?? eventSession(command.commandIdentity.sessionId),
    kind: 'human_command',
    payload: { command },
  });
  await ledgerDurable();
}
