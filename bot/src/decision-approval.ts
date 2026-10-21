import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The decision record's optional section naming each action a permanent entry reserves for his approval. */
const APPROVAL_SECTION = 'Needs his approval';

export function decisionSection(record: string, heading: string): string {
  return record.split(new RegExp(`^## ${heading}\\s*$`, 'm'))[1]?.split(/^## /m)[0]?.trim() ?? '';
}

export function decisionRecord(decisionId: string): string {
  return readFileSync(join(homedir(), 'workspace/decision-record/decisions', `${decisionId}.md`), 'utf8');
}

const normalAction = (action: string): string => action.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A citation is an ID, not an agent assertion of scope. The owner reads the installed record:
 * it must be permanent, not superseded, and list the exact action under "Needs his approval".
 * Which actions are reserved is the record's data, so a new approval rule needs a record entry,
 * never a code change (the machine-resource rule was hardcoded until 2026-10-21).
 */
export function approvalDecision(decisionId: unknown, action: unknown): string {
  if (typeof decisionId !== 'string' || !SLUG.test(decisionId) || typeof action !== 'string' || !action.trim())
    throw new Error('Approval questions require --decision-id <decision record id> and --approval-action <an action that record lists under "Needs his approval">.');
  let record: string;
  try { record = decisionRecord(decisionId); }
  catch { throw new Error(`Decision ${decisionId} is not in the installed decision record.`); }
  const status = record.match(/^Status: (.+)$/m)?.[1]?.trim();
  const id = record.match(/^ID: (.+)$/m)?.[1]?.trim();
  const superseded = decisionSection(record, 'Superseded by');
  if (id !== decisionId || status !== 'permanent' || superseded !== '—')
    throw new Error(`Decision ${decisionId} is not an active permanent decision.`);
  const reserved = decisionSection(record, APPROVAL_SECTION).split('\n')
    .map((line) => line.match(/^- (.+)$/)?.[1]).filter((line): line is string => !!line);
  if (!reserved.some((listed) => normalAction(listed) === normalAction(action)))
    throw new Error(reserved.length
      ? `Decision ${decisionId} reserves only these actions for his approval: ${reserved.join('; ')}. Use one as --approval-action.`
      : `Decision ${decisionId} reserves no action for his approval (no "${APPROVAL_SECTION}" section). If his words reserve one, add it to the record first.`);
  return decisionId;
}
