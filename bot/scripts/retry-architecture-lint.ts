#!/usr/bin/env bun
/** Refuse new unbounded retry patterns at the release build boundary. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RETRY_POLICIES } from '../src/retry-policies';

const root = join(import.meta.dir, '..');
// These are queue notifications after a durable state change, rather than a new attempt
// at an operation. Keep exceptions scoped to the specific pattern, never the whole file.
const allowedMicrotaskWake: Readonly<Record<string, string>> = {
  'src/session-peers.ts': 'Schedules the peer coordinator after retained work changes',
  'src/session-communication.ts': 'Schedules the local coordinator after retained work changes',
};
const files: string[] = [];
function catchesWithRawTimer(source: string): boolean {
  for (const match of source.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    for (let i = start; i < source.length && depth; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      if (depth && /\bsetTimeout\s*\(/.test(source.slice(i, i + 25))) return true;
    }
  }
  return false;
}
function hasRetryWithoutNamedPolicy(source: string, name: string): boolean {
  for (const match of source.matchAll(/\b(?:withRetry|nextRetry)\s*\(\s*\{/g)) {
    const start = match.index! + match[0].length;
    let depth = 1, end = start;
    for (; end < source.length && depth; end++) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
    }
    const call = source.slice(start, end);
    const named = /\bpolicy\s*:\s*(?:RETRY_POLICIES\.[A-Za-z]+\b|RETRY_POLICY_FOR_SITE\[)/.test(call);
    // A wrapper may derive its typed policy from the canonical site map before calling
    // nextRetry. Recognize that data flow instead of coupling the exception to a filename.
    const derived = /\bpolicy\s*,/.test(call)
      && /\bconst\s+policy\s*=\s*RETRY_POLICY_FOR_SITE\s*\[[^\]]+\]\s*;/.test(source.slice(0, match.index));
    if (!named && !derived) return true;
  }
  return false;
}
function walk(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
}
walk(join(root, 'src'));

// Not a retry rule, but the same release boundary: a release must be able to take back every host
// an earlier release could have started, so the adoptable host protocols run from 1 to the newest
// without a gap and include the one new hosts speak (docs/architecture/EXECUTION-HOST.md).
{
  const protocols = JSON.parse(readFileSync(join(root, 'src/host-protocols.json'), 'utf8')) as { current: number; adoptable: number[] };
  const newest = Math.max(protocols.current, ...protocols.adoptable);
  const missing = Array.from({ length: newest }, (_, index) => index + 1).filter(version => !protocols.adoptable.includes(version));
  if (missing.length) { console.error(`retry-architecture: src/host-protocols.json: adoptable must keep every host protocol up to ${newest}; missing ${missing.join(', ')}`); process.exitCode = 1; }
}
const errors: string[] = [];
for (const path of files) {
  const name = relative(root, path);
  if (name === 'src/retry.ts') continue;
  const source = readFileSync(path, 'utf8');
  // A retry with an omitted policy is the exact gap this architecture must refuse.
  if (hasRetryWithoutNamedPolicy(source, name))
    errors.push(`${name}: withRetry must receive an explicit named policy`);
  const rawCatchTimer = catchesWithRawTimer(source);
  if (rawCatchTimer) errors.push(`${name}: raw setTimeout inside catch; use withRetry`);
  const pendingReset = /\bUPDATE\s+[\w]+\s+SET\s+[^;]{0,300}\bstatus\s*=\s*['"]pending['"]/is.test(source)
    && /\bwake\s*\(/.test(source);
  if (pendingReset) errors.push(`${name}: pending reset feeding a wake loop; use a named retry policy`);
  const microtaskRetry = /queueMicrotask\s*\([^;]{0,240}\bretry\b/is.test(source);
  if (microtaskRetry && !allowedMicrotaskWake[name]) errors.push(`${name}: queueMicrotask retry; use withRetry`);
  // Not a retry rule, but the same release boundary: a loop that leaves iterate() early pins
  // the ledger connection, and the next commit by another process fails every later write
  // (two service crashes, 2026-10-07). ledger-rows.ts is the one place allowed to iterate.
  if (name !== 'src/ledger-rows.ts' && /\.iterate\s*\(/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
    errors.push(`${name}: statement.iterate(); use ledgerRows() so an early exit closes the statement`);
}
for (const [name, policy] of Object.entries(RETRY_POLICIES)) {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1
    || !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0
    || !Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs <= 0
    || !Number.isFinite(policy.capDelayMs) || policy.capDelayMs < policy.baseDelayMs
    || !Number.isFinite(policy.jitterFraction) || policy.jitterFraction < 0 || policy.jitterFraction > 1)
    errors.push(`retry-policies.ts: ${name} must have finite attempt, age, delay, and jitter bounds`);
}
if (errors.length) {
  for (const error of errors) console.error(`retry-architecture: ${error}`);
  process.exit(1);
}
console.log(`retry-architecture: checked ${files.length} source files and ${Object.keys(RETRY_POLICIES).length} policies`);
