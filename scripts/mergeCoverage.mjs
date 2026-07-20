import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import MCR from 'monocart-coverage-reports';
import { applicationSourcePath, isApplicationSource, projectRoot } from './coveragePaths.mjs';

const unitDir = path.join(projectRoot, 'coverage/unit');
const e2eDir = path.join(projectRoot, 'coverage/e2e');
const outputDir = path.join(projectRoot, 'coverage/combined');

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing at ${path.relative(projectRoot, filePath)}`);
  }
}

function readJson(filePath, label) {
  requireFile(filePath, label);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const unitReportPath = path.join(unitDir, 'coverage-report.json');
const e2eReportPath = path.join(e2eDir, 'coverage-report.json');
const rawDirs = [path.join(unitDir, 'raw'), path.join(e2eDir, 'raw')];
requireFile(unitReportPath, 'Vitest V8 summary');
requireFile(e2eReportPath, 'Playwright V8 summary');
for (const [index, rawDir] of rawDirs.entries()) {
  requireFile(rawDir, `${index === 0 ? 'Vitest' : 'Playwright'} raw coverage`);
}

const unit = readJson(unitReportPath, 'Vitest V8 summary');
const e2e = readJson(e2eReportPath, 'Playwright V8 summary');
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
for (const metric of metrics) {
  const combinedCovered = combined.summary[metric]?.covered ?? 0;
  const unitCovered = unit.summary[metric]?.covered ?? 0;
  const e2eCovered = e2e.summary[metric]?.covered ?? 0;
  if (combinedCovered < unitCovered || combinedCovered < e2eCovered) {
    throw new Error(
      `Combined ${metric} coverage lost executed code: ${combinedCovered} < ` +
        `max(${unitCovered}, ${e2eCovered})`,
    );
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
