// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { sidecarPath } from '../../utils/sidecarPath';

const helper = resolve(__dirname, '../../../scripts/open-in-quill.mjs');

function fixture(extension: string, siblingExtension: string, existingMode: number | null = 0o600) {
  const directory = mkdtempSync(join(tmpdir(), 'quill-open-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const bin = join(directory, 'bin');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  const opened = join(directory, 'opened-url');
  writeFileSync(join(bin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$1" > "$QUILL_TEST_OPEN_LOG"\n', {
    mode: 0o700,
  });
  const target = join(directory, `report.${extension}`);
  const sibling = join(directory, `report.${siblingExtension}`);
  writeFileSync(target, '# Target\n', { mode: 0o600 });
  writeFileSync(sibling, '# Sibling\n', { mode: 0o600 });
  const annotations = (sessionId: string) => ({
    version: 2,
    comments: [{ id: sessionId, text: 'Preserve this annotation' }],
    suggestions: [],
    aiSession: { provider: 'claude-code', sessionId, cwd: directory, linkedAt: 'constructed' },
  });
  const targetSidecar = sidecarPath(target);
  const siblingSidecar = sidecarPath(sibling);
  const originalTarget = annotations('constructed-target');
  const originalSibling = `${JSON.stringify(annotations('constructed-sibling'), null, 2)}\n`;
  if (existingMode !== null) {
    writeFileSync(targetSidecar, `${JSON.stringify(originalTarget)}\n`, { mode: 0o600 });
    chmodSync(targetSidecar, existingMode);
  }
  writeFileSync(siblingSidecar, originalSibling, { mode: 0o600 });
  const invoke = (args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(
      '/bin/sh',
      [
        '-c',
        'umask 022; exec "$@"',
        'open-in-quill-test',
        process.execPath,
        helper,
        target,
        ...args,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: { HOME: home, PATH: bin, QUILL_TEST_OPEN_LOG: opened, ...env },
        timeout: 10_000,
      },
    );
  const run = (sessionId: string, relink = false) =>
    invoke([`--session=${sessionId}`, ...(relink ? ['--relink'] : [])]);
  const transcript = (configRoot: string, sessionId: string) => {
    const project = join(configRoot, 'projects', directory.replace(/\//g, '-'));
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(join(project, `${sessionId}.jsonl`), '{}\n', { mode: 0o600 });
  };
  return {
    directory,
    home,
    target,
    targetSidecar,
    siblingSidecar,
    originalTarget,
    originalSibling,
    opened,
    run,
    invoke,
    transcript,
  };
}

describe('open-in-quill session discovery', () => {
  it('uses an absolute configured transcript root', () => {
    const files = fixture('md', 'markdown', null);
    const alternate = join(files.directory, 'alternate-config');
    files.transcript(join(files.home, '.claude'), 'constructed-default');
    files.transcript(alternate, 'constructed-alternate');
    const result = files.invoke([], {
      CLAUDE_CONFIG_DIR: alternate,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(files.targetSidecar, 'utf8')).aiSession.sessionId).toBe(
      'constructed-alternate',
    );
    expect(readFileSync(files.opened, 'utf8').trim()).toBe(
      `quill://open?file=${encodeURIComponent(files.target)}`,
    );
    expect(readFileSync(files.siblingSidecar, 'utf8')).toBe(files.originalSibling);
  });

  it('uses the default root when CLAUDE_CONFIG_DIR is unset', () => {
    const files = fixture('md', 'markdown', null);
    files.transcript(join(files.home, '.claude'), 'constructed-default');
    const result = files.invoke();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(files.targetSidecar, 'utf8')).aiSession.sessionId).toBe(
      'constructed-default',
    );
  });

  it.each<{
    configDir: string;
    route: string;
    args: string[];
    env: Record<string, string>;
  }>([
    { configDir: '', route: 'automatic', args: ['--relink'], env: {} },
    { configDir: 'alternate-config', route: 'automatic', args: ['--relink'], env: {} },
    {
      configDir: '',
      route: 'CLI session',
      args: ['--relink', '--session=constructed-cli'],
      env: {},
    },
    {
      configDir: 'alternate-config',
      route: 'CLI session',
      args: ['--relink', '--session=constructed-cli'],
      env: {},
    },
    {
      configDir: '',
      route: 'environment session',
      args: ['--relink'],
      env: { QUILL_SESSION_ID: 'constructed-env' },
    },
    {
      configDir: 'alternate-config',
      route: 'environment session',
      args: ['--relink'],
      env: { QUILL_SESSION_ID: 'constructed-env' },
    },
  ])(
    'refuses config "$configDir" before writing or opening via $route',
    ({ configDir, args, env }) => {
      const files = fixture('md', 'markdown', 0o640);
      files.transcript(join(files.home, '.claude'), 'constructed-default');
      files.transcript(join(files.directory, 'alternate-config'), 'constructed-alternate');
      const originalBytes = readFileSync(files.targetSidecar, 'utf8');
      const result = files.invoke(args, { ...env, CLAUDE_CONFIG_DIR: configDir });
      expect({
        status: result.status,
        actionableError: /CLAUDE_CONFIG_DIR.*unset.*absolute/.test(result.stderr),
        targetUnchanged: readFileSync(files.targetSidecar, 'utf8') === originalBytes,
        targetMode: statSync(files.targetSidecar).mode & 0o7777,
        siblingUnchanged: readFileSync(files.siblingSidecar, 'utf8') === files.originalSibling,
        siblingMode: statSync(files.siblingSidecar).mode & 0o7777,
        opened: existsSync(files.opened),
      }).toEqual({
        status: 1,
        actionableError: true,
        targetUnchanged: true,
        targetMode: 0o640,
        siblingUnchanged: true,
        siblingMode: 0o600,
        opened: false,
      });
    },
  );

  it.each([
    { args: ['--session=constructed-cli'], expected: 'constructed-cli' },
    { args: [], expected: 'constructed-env' },
  ])('keeps explicit session precedence for $expected', ({ args, expected }) => {
    const files = fixture('md', 'markdown', null);
    const alternate = join(files.directory, 'alternate-config');
    files.transcript(alternate, 'constructed-alternate');
    const result = files.invoke(args, {
      CLAUDE_CONFIG_DIR: alternate,
      QUILL_SESSION_ID: 'constructed-env',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(files.targetSidecar, 'utf8')).aiSession.sessionId).toBe(
      expected,
    );
  });
});

describe('open-in-quill sidecar contract', () => {
  const extensions = [
    ['md', 'markdown'],
    ['markdown', 'md'],
    ['MD', 'MARKDOWN'],
    ['MARKDOWN', 'MD'],
  ];

  it.each(extensions)(
    'opens .%s using its own binding beside .%s',
    (extension, siblingExtension) => {
      const files = fixture(extension, siblingExtension);
      const result = files.run('constructed-target');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`sidecar: ${files.targetSidecar}`);
      expect(readFileSync(files.opened, 'utf8').trim()).toBe(
        `quill://open?file=${encodeURIComponent(files.target)}`,
      );
      expect(JSON.parse(readFileSync(files.targetSidecar, 'utf8'))).toEqual(files.originalTarget);
      expect(readFileSync(files.siblingSidecar, 'utf8')).toBe(files.originalSibling);
    },
  );

  it.each(extensions)(
    'relinks .%s without changing the .%s sidecar',
    (extension, siblingExtension) => {
      const files = fixture(extension, siblingExtension);
      const result = files.run('constructed-new', true);
      expect(result.status, result.stderr).toBe(0);
      const updated = JSON.parse(readFileSync(files.targetSidecar, 'utf8'));
      expect(updated.aiSession.sessionId).toBe('constructed-new');
      expect(updated.comments).toEqual(files.originalTarget.comments);
      expect(readFileSync(files.siblingSidecar, 'utf8')).toBe(files.originalSibling);
    },
  );

  it.each([0o600, 0o640, 0o644])('preserves sidecar mode %i when relinking', (mode) => {
    const files = fixture('md', 'markdown', mode);
    const result = files.run('constructed-new', true);
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(files.targetSidecar).mode & 0o7777).toBe(mode);
    const updated = JSON.parse(readFileSync(files.targetSidecar, 'utf8'));
    expect(updated.aiSession.sessionId).toBe('constructed-new');
    expect(updated.comments).toEqual(files.originalTarget.comments);
    expect(readFileSync(files.siblingSidecar, 'utf8')).toBe(files.originalSibling);
    expect(statSync(files.siblingSidecar).mode & 0o7777).toBe(0o600);
  });

  it('creates a new sidecar privately', () => {
    const files = fixture('md', 'markdown', null);
    const result = files.run('constructed-new');
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(files.targetSidecar).mode & 0o7777).toBe(0o600);
    const created = JSON.parse(readFileSync(files.targetSidecar, 'utf8'));
    expect(created.version).toBe(2);
    expect(created.aiSession.sessionId).toBe('constructed-new');
    expect(created.comments).toEqual([]);
    expect(created.suggestions).toEqual([]);
    expect(readFileSync(files.siblingSidecar, 'utf8')).toBe(files.originalSibling);
  });
});
