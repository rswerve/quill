import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  checkCoverageRegression,
  formatCoverageRegressionMarkdown,
} from './coverageRegression.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function readReport(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing at ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const baselinePath = option('--baseline', 'coverage/baseline/coverage-report.json');
const currentPath = option('--current', 'coverage/combined/coverage-report.json');
const outputPath = option('--output', 'coverage/combined/coverage-regression.md');
const baselineSha = option('--baseline-sha', process.env.BASELINE_SHA ?? 'unknown');

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
