import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MACHINE_RESOURCE_DECISION = 'machine-wide-resource-changes-need-his-approval';
const MACHINE_RESOURCES = ['processor', 'memory', 'disk'] as const;
const MACHINE_RESOURCE_CHANGES = {
  priority: 'priority',
  throttling: 'throttling',
  slots: 'slots',
  limit: 'limits',
  quota: 'quotas',
} as const;

export function decisionSection(record: string, heading: string): string {
  return record.split(new RegExp(`^## ${heading}\\s*$`, 'm'))[1]?.split(/^## /m)[0]?.trim() ?? '';
}

export function decisionRecord(decisionId: string): string {
  return readFileSync(join(homedir(), 'workspace/decision-record/decisions', `${decisionId}.md`), 'utf8');
}

/** A citation is an ID, not an agent assertion of scope. The owner checks the installed record. */
export function approvalDecision(decisionId: unknown, action: unknown): string {
  const [resource, change, extra] = typeof action === 'string' ? action.split('-') : [];
  if (decisionId !== MACHINE_RESOURCE_DECISION || extra !== undefined
      || !MACHINE_RESOURCES.includes(resource as typeof MACHINE_RESOURCES[number])
      || !Object.hasOwn(MACHINE_RESOURCE_CHANGES, change ?? ''))
    throw new Error('Approval questions require a supported permanent decision and a covered --approval-action: <processor|memory|disk>-<priority|throttling|slots|limit|quota>.');
  const record = decisionRecord(decisionId);
  const status = record.match(/^Status: (.+)$/m)?.[1]?.trim();
  const id = record.match(/^ID: (.+)$/m)?.[1]?.trim();
  const scope = decisionSection(record, 'Scope').toLowerCase();
  const decision = decisionSection(record, 'Decision').toLowerCase();
  const words = decisionSection(record, 'Words').toLowerCase();
  const superseded = decisionSection(record, 'Superseded by');
  const changeTerm = MACHINE_RESOURCE_CHANGES[change as keyof typeof MACHINE_RESOURCE_CHANGES];
  if (id !== decisionId || status !== 'permanent' || superseded !== '—'
      || (!scope.includes('approval') && !words.includes('explicit'))
      || !scope.includes(resource!) || !(scope.includes(changeTerm) || decision.includes(changeTerm)))
    throw new Error(`Decision ${decisionId} is not an active permanent approval rule covering ${action}.`);
  return decisionId;
}
