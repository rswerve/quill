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
    const [major, minor, patch] = engines.match(/\d+/g).map(Number);
    expect([major, minor, patch]).toEqual([22, expect.any(Number), expect.any(Number)]);
    expect(minor > 23 || (minor === 23 && patch >= 4)).toBe(true);
  });

  it('mirrors engines into the lockfile, or npm ci desyncs', () => {
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.packages[''].engines).toEqual(JSON.parse(read('package.json')).engines);
  });

  it('enables engine-strict, without which engines is only a warning', () => {
    expect(read('.npmrc')).toMatch(/^engine-strict\s*=\s*true$/m);
  });

  const workflows = fs
    .readdirSync(path.join(root, '.github/workflows'))
    .filter((f) => f.endsWith('.yml'));
  const nodeSteps = workflows.flatMap((file) =>
    read(`.github/workflows/${file}`)
      .split(/(?=^[ \t]*- )/m)
      .filter((step) => /uses:\s*actions\/setup-node@/.test(step))
      .map((step, index) => ({ file, step, index: index + 1 })),
  );

  it('finds the workflow Node selections', () => {
    expect(nodeSteps.length).toBeGreaterThan(0);
  });

  it.each(nodeSteps)(
    '$file setup-node step $index selects the latest .nvmrc version',
    ({ step }) => {
      expect(step).not.toMatch(/node-version:\s*['"]?\d/);
      expect(step).toMatch(/^[ \t]+node-version-file:\s*['"]?\.nvmrc['"]?\s*$/m);
      expect(step).toMatch(/^[ \t]+check-latest:\s*true\s*$/m);
    },
  );
});
