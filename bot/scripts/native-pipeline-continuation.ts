#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This command carries the operator's request to the owner. Only that owner
// opens the live ledger and decides whether the continuation may be queued.
const [operation, id, file] = process.argv.slice(2);
if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('An exact continuation ID is required.');
if (operation !== 'enroll' && operation !== 'tick') throw new Error('Use enroll <id> <json-file> or tick <id>.');
const stateDir = process.env.CONCIERGE_STATE_DIR;
if (!stateDir) throw new Error('CONCIERGE_STATE_DIR is required.');
const payload = operation === 'enroll' ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
const response = await fetch('http://localhost/internal/native-pipeline-continuation', {
  unix: join(stateDir, 'request-owner.sock'), method: 'POST',
  headers: {'content-type':'application/json'}, body: JSON.stringify({operation,id,payload}),
} as RequestInit);
const result = await response.json() as any;
if (!response.ok) throw new Error(result?.error || `Owner refused continuation: ${response.status}`);
console.log(JSON.stringify(result));
