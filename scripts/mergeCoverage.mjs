import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import MCR from 'monocart-coverage-reports';
import { applicationSourcePath, isApplicationSource, projectRoot } from './coveragePaths.mjs';

const coverageRoot = path.join(projectRoot, 'coverage');
const outputDir = path.join(coverageRoot, 'combined');
// Where a multi-source browser aggregate is written (see browserSummary below).
const browserAggregateDir = path.join(coverageRoot, 'browser');

const UNIT_SOURCE = 'unit';
const RESERVED_SOURCES = new Set(['combined', 'browser']);

// Monocart only reads raw records ending in .json, so a `coverage-placeholder`
// with no extension would satisfy a looser check and contribute nothing.
const RAW_COVERAGE = /^coverage-.+\.json$/;
const RAW_SOURCE = /^source-.+\.json$/;

/**
 * Coverage inputs are discovered by convention rather than hardcoded, because
 * CI produces a different set than a local run: one Playwright job locally
 * (`e2e`), but one per project in CI (`e2e-chromium`, `e2e-visual`). A source
 * is any coverage/<name>/ carrying both a raw/ directory and a V8 summary.
 * Dot-directories are skipped — `coverage/.tmp` is a real local artifact.
 */
function discoverSources() {
  return fs
    .readdirSync(coverageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => !RESERVED_SOURCES.has(name))
    .filter((name) => {
      const raw = path.join(coverageRoot, name, 'raw');
      const summary = path.join(coverageRoot, name, 'coverage-report.json');
      if (!fs.existsSync(raw) || !fs.existsSync(summary)) return false;
      // A present-but-empty raw/ would satisfy the expected-source check while
      // contributing nothing — the same silent under-count that check exists to
      // prevent. Demand both record kinds Monocart needs: the V8 coverage
      // entries and the source snapshots they map through.
      if (!fs.statSync(raw).isDirectory()) return false;
      const files = fs
        .readdirSync(raw, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
      return (
        files.some((file) => RAW_COVERAGE.test(file)) && files.some((file) => RAW_SOURCE.test(file))
      );
    })
    .sort();
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing at ${path.relative(projectRoot, filePath)}`);
  }
}

function readJson(filePath, label) {
  requireFile(filePath, label);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const sources = discoverSources();
if (!sources.includes(UNIT_SOURCE)) {
  throw new Error(
    `Vitest coverage is missing: no coverage/${UNIT_SOURCE}/ with raw/ and ` +
      `coverage-report.json. Found: ${sources.join(', ') || '(none)'}`,
  );
}
const browserSources = sources.filter((name) => name !== UNIT_SOURCE);
if (browserSources.length === 0) {
  throw new Error('Playwright coverage is missing: no browser coverage source found');
}

/**
 * Discovery alone cannot tell a complete merge from a partial one: if a CI job's
 * artifact fails to arrive, every "combined >= each source" check still passes
 * while the combined numbers are quietly lower — measured at 58 lost lines when
 * the visual source went missing. The regression gate would then be graded
 * against weaker evidence without anything failing. CI therefore declares the
 * sources it expects, and a mismatch is a hard error. Unset locally, where a
 * developer's ad-hoc combination is legitimate.
 */
const expected = process.env.COVERAGE_EXPECTED_SOURCES?.split(',')
  .map((name) => name.trim())
  .filter(Boolean)
  .sort();
if (expected?.length) {
  const found = [...sources].sort();
  if (found.join(',') !== expected.join(',')) {
    throw new Error(
      `Coverage sources do not match COVERAGE_EXPECTED_SOURCES.\n` +
        `  expected: ${expected.join(', ')}\n` +
        `  found:    ${found.join(', ') || '(none)'}`,
    );
  }
}

process.stdout.write(`Merging coverage sources: ${sources.join(', ')}\n`);

const sourceDir = (name) => path.join(coverageRoot, name);
// Vitest first. Where the same function is seen by both runners, Monocart keeps
// the metadata from whichever input it read first, so loading a browser source
// ahead of unit changes function names in coverage-final.json — identical
// counters, different bytes. Ordering it explicitly keeps the artifact stable.
const orderedSources = [UNIT_SOURCE, ...browserSources];
const rawDirs = orderedSources.map((name) => path.join(sourceDir(name), 'raw'));

/**
 * The same V8 record must never be ingested from two directories. Monocart
 * unions overlapping *source files* correctly, but re-reading an identical
 * `coverage-<id>.json` sums its execution counts instead — which perturbs
 * thousands of Istanbul counters while covered/uncovered totals stay put, so
 * nothing else here would notice. Source snapshots repeat legitimately (both
 * projects load the same modules); coverage records must not.
 *
 * This also catches the topology check being satisfied dishonestly: if the same
 * artifact were downloaded into two of the expected directories, the source set
 * would look complete while one project's evidence was missing entirely.
 */
const seenRecords = new Map();
for (const name of orderedSources) {
  for (const file of fs.readdirSync(path.join(sourceDir(name), 'raw'))) {
    if (!RAW_COVERAGE.test(file)) continue;
    const owner = seenRecords.get(file);
    if (owner) {
      throw new Error(
        `Duplicate coverage record ${file} in both coverage/${owner}/raw and ` +
          `coverage/${name}/raw; execution counts would be double-counted`,
      );
    }
    seenRecords.set(file, name);
  }
}

const unit = readJson(
  path.join(sourceDir(UNIT_SOURCE), 'coverage-report.json'),
  'Vitest V8 summary',
);

/**
 * One Playwright summary covering every browser source, for the reporting
 * column and the shell-file guard below. With several browser jobs their
 * summaries cannot simply be combined — the projects overlap on files like
 * App.tsx, so any arithmetic on the numbers would double-count. Re-merging
 * their raw V8 data is the only way to get a true union. A single source needs
 * no aggregation, which keeps local runs on exactly the old path.
 */
async function browserSummary() {
  if (browserSources.length === 1) {
    const only = browserSources[0];
    return readJson(path.join(sourceDir(only), 'coverage-report.json'), 'Playwright V8 summary');
  }
  return new MCR.CoverageReport({
    name: 'Quill Playwright coverage (all projects)',
    inputDir: browserSources.map((name) => path.join(sourceDir(name), 'raw')),
    outputDir: browserAggregateDir,
    sourceFilter: isApplicationSource,
    sourcePath: applicationSourcePath,
    all: { dir: ['src'], filter: isApplicationSource },
    reports: [['v8-json', { outputFile: 'coverage-report.json' }]],
  }).generate();
}

const e2e = await browserSummary();
const combined = await new MCR.CoverageReport({
  name: 'Combined Vitest + Playwright coverage',
  inputDir: rawDirs,
  outputDir,
  sourceFilter: isApplicationSource,
  sourcePath: applicationSourcePath,
  all: {
    dir: ['src'],
    filter: isApplicationSource,
  },
  reports: [
    ['v8'],
    ['v8-json', { outputFile: 'coverage-report.json' }],
    ['json', { file: 'coverage-final.json' }],
    ['lcovonly', { file: 'lcov.info' }],
    ['html', { subdir: 'html' }],
    ['console-summary'],
  ],
}).generate();

const metrics = ['bytes', 'lines', 'statements', 'functions', 'branches'];

// Check the combined result against EVERY input's own summary, not just the
// unit and browser-aggregate pair. Each browser source's report would otherwise
// be nothing but a discovery marker, letting one partial source hide behind a
// healthy sibling in the aggregate.
const inputSummaries = [
  [UNIT_SOURCE, unit],
  ...browserSources.map((name) => [
    name,
    readJson(path.join(sourceDir(name), 'coverage-report.json'), `${name} V8 summary`),
  ]),
];

for (const metric of metrics) {
  const combinedCovered = combined.summary[metric]?.covered ?? 0;
  for (const [name, summary] of inputSummaries) {
    const covered = summary.summary[metric]?.covered ?? 0;
    if (combinedCovered < covered) {
      throw new Error(
        `Combined ${metric} coverage lost executed code: ${combinedCovered} < ` +
          `${covered} from coverage/${name}`,
      );
    }
  }
}

for (const metric of ['bytes', 'lines']) {
  const totals = [
    unit.summary[metric].total,
    e2e.summary[metric].total,
    combined.summary[metric].total,
  ];
  if (new Set(totals).size !== 1) {
    throw new Error(`${metric} denominators disagree across runners: ${totals.join(', ')}`);
  }
}

const sourcePaths = combined.files.map((file) => file.sourcePath);
if (new Set(sourcePaths).size !== sourcePaths.length) {
  throw new Error(
    'Combined coverage contains duplicate source paths; CI path normalization failed',
  );
}

const shellFiles = ['src/App.tsx', 'src/components/Topbar.tsx'];
const shellRows = shellFiles.map((relativePath) => {
  const browserFile = e2e.files.find((file) =>
    file.sourcePath.replaceAll('\\', '/').endsWith(relativePath),
  );
  const combinedMatches = combined.files.filter((file) =>
    file.sourcePath.replaceAll('\\', '/').endsWith(relativePath),
  );
  const combinedFile = combinedMatches[0];
  const browserLines = browserFile?.summary.lines;
  const combinedLines = combinedFile?.summary.lines;
  if (
    !browserLines ||
    browserLines.covered === 0 ||
    !combinedLines ||
    combinedMatches.length !== 1
  ) {
    throw new Error(`${relativePath} has no Playwright line coverage; browser collection failed`);
  }
  return `| ${relativePath} | ${browserLines.pct}% (${browserLines.covered}/${browserLines.total}) | ${combinedLines.pct}% (${combinedLines.covered}/${combinedLines.total}) |`;
});

const metricRows = metrics.map((metric) => {
  return `| ${metric} | ${unit.summary[metric].pct}% | ${e2e.summary[metric].pct}% | ${combined.summary[metric].pct}% |`;
});
const markdown = [
  '# Combined Vitest + Playwright coverage',
  '',
  '| Metric | Vitest | Playwright | Combined |',
  '| --- | ---: | ---: | ---: |',
  ...metricRows,
  '',
  '## Browser-covered shell files',
  '',
  '| File | Playwright lines | Combined lines |',
  '| --- | ---: | ---: |',
  ...shellRows,
  '',
].join('\n');
fs.writeFileSync(path.join(outputDir, 'coverage-summary.md'), markdown);
process.stdout.write(`${markdown}\n`);
