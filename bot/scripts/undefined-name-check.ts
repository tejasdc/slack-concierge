#!/usr/bin/env bun
/**
 * Refuse a release whose bundles use a name no module defines or imports.
 *
 * `bun build` resolves imports but never checks free identifiers, so a call to a function
 * that was never imported ships and throws ReferenceError on the first request that reaches
 * it (2026-11-06 ProviderDispatchError in the turn executor; 2026-11-07
 * getAcceptedSessionInput in the read worker's history projection, which returned 500 for
 * every event-stream page). The TypeScript compiler reports exactly that class as TS2304 and
 * TS2552; the rest of its diagnostics stay advisory until the whole codebase typechecks.
 *
 * Application entry points come from the canonical release check command inventory so this
 * check and the bundler never disagree about what ships; controller entry points come from
 * the sealed artifact declaration. Both kinds ship and must reject unresolved identifiers.
 */
import { spawnSync } from 'node:child_process';
import CHECKS from './release-checks.json';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const bundleStep=CHECKS.build.find(step=>step[0]==='bun'&&step[1]==='build');
if(!bundleStep)throw new Error('The release check inventory has no bundle step.');
const applicationEntries=bundleStep.filter(part=>part.startsWith('src/')&&part.endsWith('.ts'));
if (!applicationEntries.length) throw new Error('The `bun build` step names no src/*.ts entry points.');
const declaration = JSON.parse(readFileSync(join(root,'src/deployment-artifact-files.json'),'utf8'));
const controlEntries = Object.values(declaration.controlBundles as Record<string,string>)
  .filter(path=>path.endsWith('.ts')).map(path=>path.startsWith('bot/')?path.slice(4):join('..',path));
const entries = [...new Set([...applicationEntries,...controlEntries])];

const tsc = join(root, 'node_modules', '.bin', 'tsc');
if (!existsSync(tsc)) throw new Error(`${tsc} is missing; run bun install --frozen-lockfile first.`);
const result = spawnSync(tsc, [
  '--noEmit', '--skipLibCheck', '--pretty', 'false',
  '--target', 'esnext', '--module', 'esnext', '--moduleResolution', 'bundler', '--allowImportingTsExtensions',
  ...entries,
], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (result.error) throw result.error;

const undefinedNames = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => /\berror TS(2304|2552):/.test(line));
if (undefinedNames.length) {
  console.error(`undefined-name-check: ${undefinedNames.length} use(s) of a name nothing defines or imports; the bundle would throw ReferenceError at runtime.`);
  for (const line of undefinedNames) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`undefined-name-check: ${entries.length} bundle entry points use only defined names.`);
