import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Node version is pinned in four places that must agree. They exist because
 * a lockfile regenerated under the wrong Node once dropped a dependency and
 * failed five CI checks at the install step — see docs/solutions and
 * docs/deployment.md.
 *
 * `.nvmrc` is the single source of truth: CI reads it via `node-version-file`,
 * nvm/fnm users read it directly, mise reads `mise.toml`, and npm enforces
 * `engines` with `engine-strict`. This test fails the moment they drift.
 */

const root = path.resolve(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const MAJOR = read('.nvmrc').trim();

describe('Node toolchain pins', () => {
  it('pins .nvmrc to a bare major, so it resolves to the latest patch', () => {
    expect(MAJOR).toMatch(/^\d+$/);
  });

  it('pins mise to the same major as .nvmrc', () => {
    expect(read('mise.toml')).toContain(`node = "${MAJOR}"`);
  });

  it('constrains package.json engines to that major and nothing above it', () => {
    const engines = JSON.parse(read('package.json')).engines?.node;
    expect(engines).toBeDefined();
    // Lower bound inside the pinned major, upper bound excluding the next one.
    expect(engines).toMatch(new RegExp(`>=${MAJOR}\\.\\d+\\.\\d+ <${Number(MAJOR) + 1}$`));
  });

  it('mirrors engines into the lockfile, or npm ci desyncs', () => {
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.packages[''].engines).toEqual(JSON.parse(read('package.json')).engines);
  });

  it('enables engine-strict, without which engines is only a warning', () => {
    expect(read('.npmrc')).toMatch(/^engine-strict\s*=\s*true$/m);
  });

  it('makes every workflow read .nvmrc rather than hardcoding a version', () => {
    const dir = path.join(root, '.github/workflows');
    const workflows = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'));
    expect(workflows.length).toBeGreaterThan(0);
    for (const file of workflows) {
      const yaml = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!yaml.includes('setup-node')) continue;
      expect(yaml, `${file} hardcodes a Node version`).not.toMatch(/node-version:\s*['"]?\d/);
      expect(yaml, `${file} does not read .nvmrc`).toContain("node-version-file: '.nvmrc'");
    }
  });
});
