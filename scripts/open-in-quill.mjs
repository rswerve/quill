#!/usr/bin/env node
/**
 * Open a Markdown file in Quill from a Claude Code session, pre-bound to that
 * session.
 *
 * Quill's `quill://open?file=…` deep link only carries a path, so the binding
 * cannot ride in the URL. A document's linked session lives in its
 * `<name>.comments.json` sidecar instead, and Quill reads that on open. So we
 * write the binding first, then fire the plain deep link.
 *
 * FIRST open of a given document: Quill does NOT bind silently. A sidecar is
 * portable metadata, not a portable grant, so `authorizeSidecarAccess` blocks a
 * session it has no local grant for and shows a notice with a Relink action.
 * Approve it once. Quill records the grant against that document path
 * (localStorage `quill-sidecar-permissions-v1`), and every later open from a
 * Claude session binds silently with no prompt.
 *
 * Do NOT try to dodge that by claiming `createdByQuill: true`. It would bind
 * without a grant, but it also rewrites the session cwd to the document's
 * directory and tells Quill that Claude did not author the text — both wrong
 * here, and it launders a consent the user never gave.
 *
 * Usage:  node scripts/open-in-quill.mjs <file.md> [--relink] [--session=<id>]
 *
 *   --relink          rebind a document that already names a different session
 *   --session=<id>    use this session id instead of auto-detecting
 *   --print-only      do everything except actually opening Quill
 */

import console from 'node:console';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const { values, positionals: positional } = parseArgs({
  options: {
    relink: { type: 'boolean' },
    session: { type: 'string' },
    'print-only': { type: 'boolean' },
  },
  allowPositionals: true,
});

if (positional.length !== 1) {
  die(
    'expected exactly one path to a .md file\n' + 'usage: open-in-quill.mjs <file.md> [--relink]',
  );
}

/* ---------- 1. Resolve and validate the target ---------- */

// A quoted "~/Documents/x.md" is never expanded by the shell, so accept the
// tilde ourselves rather than failing with a baffling "no such file".
const requested = positional[0].startsWith('~/')
  ? join(homedir(), positional[0].slice(2))
  : positional[0];

const target = isAbsolute(requested) ? requested : resolve(process.cwd(), requested);

if (!existsSync(target)) die(`no such file: ${target}`);
if (!statSync(target).isFile()) die(`not a regular file: ${target}`);
if (!/\.(md|markdown)$/i.test(target)) {
  die(`Quill's deep link only opens .md/.markdown files, got: ${target}`);
}

/* ---------- 2. Work out which session we are ---------- */

/**
 * Claude Code stores one JSONL transcript per session under a project
 * directory named for the cwd with `/` replaced by `-`. The live session is
 * appending to its transcript continuously, so it is the most recently
 * modified file in that directory.
 */
function detectSessionId() {
  if (values.session !== undefined) return values.session;
  if (process.env.QUILL_SESSION_ID) return process.env.QUILL_SESSION_ID;

  const projectDir = join(homedir(), '.claude', 'projects', process.cwd().replaceAll('/', '-'));
  if (!existsSync(projectDir)) {
    die(
      `no Claude Code transcripts for this directory (${projectDir}).\n` +
        'Run this from the project directory your Claude session is working in, ' +
        'or pass --session=<id>.',
    );
  }
  const transcripts = readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ''), mtime: statSync(join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (transcripts.length === 0) die(`no session transcripts found in ${projectDir}`);
  return transcripts[0].id;
}

const sessionId = detectSessionId();

/* ---------- 3. Write the binding into the sidecar ---------- */

const sidecarPath = target.replace(/\.(md|markdown)$/i, '.comments.json');

let sidecar = { version: 2, comments: [], suggestions: [] };
let existed = false;

if (existsSync(sidecarPath)) {
  existed = true;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  } catch (e) {
    // Never clobber a sidecar we cannot understand — it holds the user's
    // comments, suggestions, and chat history.
    die(
      `existing sidecar is not valid JSON, refusing to overwrite: ${sidecarPath}\n  ${e.message}`,
    );
  }
  if (typeof sidecar !== 'object' || sidecar === null || Array.isArray(sidecar)) {
    die(`existing sidecar is not a JSON object, refusing to overwrite: ${sidecarPath}`);
  }
}

const already = sidecar.aiSession?.sessionId;
if (already && already !== sessionId && !values.relink) {
  die(
    `${target}\n  is already linked to a different session (${already}).\n` +
      '  Re-run with --relink to rebind it to this one.',
  );
}

const unchanged = already === sessionId;

if (!unchanged) {
  sidecar.aiSession = {
    provider: 'claude-code',
    sessionId,
    cwd: process.cwd(),
    linkedAt: new Date().toISOString(),
  };
  // Quill's schema: version 2 with comments/suggestions always present.
  sidecar.version = 2;
  sidecar.comments ??= [];
  sidecar.suggestions ??= [];

  // Temp-file + rename, so Quill can never observe a half-written sidecar.
  const tmp = join(dirname(sidecarPath), `.${Date.now()}.open-in-quill.tmp`);
  writeFileSync(tmp, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  renameSync(tmp, sidecarPath);
}

/* ---------- 4. Warn if Quill already has this document open ---------- */

// Writing the sidecar under a document Quill is already showing changes the
// file behind its recorded baseline, which surfaces as a conflict banner.
const workspace = join(
  homedir(),
  'Library',
  'Application Support',
  'com.trussworks.quill',
  'workspace.json',
);
if (!unchanged && existsSync(workspace)) {
  try {
    const open = JSON.parse(readFileSync(workspace, 'utf8'));
    if (open.tabs?.some((t) => t.filePath === target)) {
      console.warn(
        `warning: Quill appears to already have this document open. It may show a\n` +
          `         conflict banner for the sidecar; choose Reload to pick up the link.`,
      );
    }
  } catch {
    // A missing or unreadable snapshot just means we skip the warning.
  }
}

/* ---------- 5. Fire the deep link ---------- */

const url = `quill://open?file=${encodeURIComponent(target)}`;

if (!values['print-only']) {
  try {
    execFileSync('open', [url], { stdio: 'ignore' });
  } catch {
    die(
      `could not hand the link to Quill. If Quill has never been launched, macOS has\n` +
        'not registered the quill:// scheme yet — open Quill once, then retry.\n' +
        `  url: ${url}`,
    );
  }
}

const state = unchanged
  ? 'already linked to this session'
  : existed
    ? 'linked this session into the existing sidecar'
    : 'created a sidecar linking this session';

console.log(`Opened in Quill: ${target}`);
console.log(`  session: ${sessionId}`);
console.log(`  sidecar: ${sidecarPath} (${state})`);
