#!/usr/bin/env bun
/**
 * Refuse a build script in which one step swallows the next.
 *
 * The release build is one `&&` chain. On 2026-11-17 a missing `&&` turned
 * `bun run scripts/codex-custody-successor-fixture.ts` into extra arguments of the
 * edit-gate fixture before it, which ignores its arguments, so the default custody
 * successor scenario never ran while the build still passed. Every step must start
 * exactly one program; a second launcher word inside a step means a separator is missing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LAUNCHER = /(?:^|\s)(?:bun\s+(?:run|build|test)|python3|node|bash|sh)\s/g;

export function swallowedSteps(build: string): string[] {
  return build.split(/&&|\|\||;/).map((step) => step.trim())
    .filter((step) => (` ${step} `.match(LAUNCHER) ?? []).length !== 1);
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const build = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.build;
  if (typeof build !== 'string') throw new Error('package.json has no build script.');
  const sample = 'bun run a.ts && bun run b.ts bun run c.ts && python3 d.py --x';
  const caught = swallowedSteps(sample);
  if (caught.length !== 1 || caught[0] !== 'bun run b.ts bun run c.ts') {
    throw new Error(`build-chain-check self-test did not catch a joined step: ${JSON.stringify(caught)}`);
  }
  const bad = swallowedSteps(build);
  if (bad.length) {
    console.error(`build-chain-check: ${bad.length} build step(s) do not start exactly one program; a separator is missing:`);
    for (const step of bad) console.error(`  ${step}`);
    process.exit(1);
  }
  console.log(`build-chain-check: ${build.split('&&').length} build steps each start one program.`);
}
