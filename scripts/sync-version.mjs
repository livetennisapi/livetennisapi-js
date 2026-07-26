#!/usr/bin/env node
/**
 * Generate src/version.ts from package.json.
 *
 * package.json is the single source of truth for the version; this file makes
 * src/version.ts a DERIVED artifact instead of a hand-maintained copy. Release
 * 1.1.0 bumped package.json and forgot version.ts, the CI version-sync guard
 * went red, and the release had to be patched by hand — that class of failure is
 * what this removes.
 *
 * Wired into the `version` npm lifecycle (runs on `npm version <x>`, before the
 * release commit) and into `prepublishOnly`, so the two cannot diverge. The CI
 * check stays as a backstop for anyone who edits version.ts directly.
 *
 * Idempotent: rewrites only when the content actually changes, so it never makes
 * a spurious dirty file in CI or a no-op commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`sync-version: refusing to write a non-semver version: ${version}`);
  process.exit(1);
}

const target = join(root, 'src', 'version.ts');
const contents = `/**
 * Single source of the package version.
 *
 * GENERATED from package.json by scripts/sync-version.mjs — do not edit by hand.
 * Runs on \`npm version\` and \`prepublishOnly\`; CI asserts the two still match.
 */
export const VERSION = '${version}';
`;

const current = (() => {
  try { return readFileSync(target, 'utf8'); } catch { return null; }
})();

if (current === contents) {
  console.log(`sync-version: src/version.ts already at ${version}`);
} else {
  writeFileSync(target, contents);
  console.log(`sync-version: wrote src/version.ts = ${version}`);
}
