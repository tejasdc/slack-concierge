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
    // The durable breaker resolves its typed site through RETRY_POLICY_FOR_SITE before
    // calling nextRetry; the variable is derived from that map in the same module.
    const derived = name === 'src/retry-breaker.ts' && /\bpolicy\s*,/.test(call);
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
