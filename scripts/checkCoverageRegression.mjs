import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import {
  checkCoverageRegression,
  formatCoverageRegressionMarkdown,
} from './coverageRegression.mjs';

function readReport(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing at ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const { values } = parseArgs({
  options: {
    baseline: { type: 'string', default: 'coverage/baseline/coverage-report.json' },
    current: { type: 'string', default: 'coverage/combined/coverage-report.json' },
    output: { type: 'string', default: 'coverage/combined/coverage-regression.md' },
    'baseline-sha': { type: 'string', default: process.env.BASELINE_SHA ?? 'unknown' },
  },
});
const baselinePath = values.baseline;
const currentPath = values.current;
const outputPath = values.output;
const baselineSha = values['baseline-sha'];

try {
  const result = checkCoverageRegression(
    readReport(baselinePath, 'Baseline coverage report'),
    readReport(currentPath, 'Current coverage report'),
  );
  const markdown = formatCoverageRegressionMarkdown(result, baselineSha);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown);
  process.stdout.write(`${markdown}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
