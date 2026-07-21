import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCoverageRegression } from './coverageRegression.mjs';

const appPath = '/checkout/src/App.tsx';
const topbarPath = '/checkout/src/components/Topbar.tsx';

function metric(covered, total) {
  return { covered, total };
}

function report({
  lines = [900, 1000],
  statements = [850, 1000],
  branches = [700, 1000],
  functions = [180, 200],
  appLines = [90, 100],
  topbarLines = [45, 50],
} = {}) {
  return {
    summary: {
      lines: metric(...lines),
      statements: metric(...statements),
      branches: metric(...branches),
      functions: metric(...functions),
    },
    files: [
      { sourcePath: appPath, summary: { lines: metric(...appLines) } },
      { sourcePath: topbarPath, summary: { lines: metric(...topbarLines) } },
    ],
  };
}

test('accepts unchanged and improved coverage', () => {
  assert.equal(checkCoverageRegression(report(), report()).ok, true);
  assert.equal(
    checkCoverageRegression(report(), report({ lines: [910, 1000], appLines: [91, 100] })).ok,
    true,
  );
});

test('allows the observed one-count same-tree V8 jitter', () => {
  const current = report({
    lines: [899, 1000],
    statements: [849, 1000],
    branches: [699, 1000],
  });
  assert.equal(checkCoverageRegression(report(), current).ok, true);
});

test('rejects a material same-denominator decrease', () => {
  const result = checkCoverageRegression(report(), report({ lines: [898, 1000] }));
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.metric === 'lines')?.ok, false);
});

test('rejects any function coverage decrease', () => {
  const result = checkCoverageRegression(report(), report({ functions: [179, 200] }));
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.metric === 'functions')?.ok, false);
});

test('does not apply jitter when source changes the denominator', () => {
  const result = checkCoverageRegression(report(), report({ lines: [900, 1001] }));
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.metric === 'lines')?.allowedCoveredLoss, 0);
});

test('rejects line regressions in App and Topbar even when overall coverage is unchanged', () => {
  const appResult = checkCoverageRegression(report(), report({ appLines: [89, 100] }));
  const topbarResult = checkCoverageRegression(report(), report({ topbarLines: [44, 50] }));
  assert.equal(appResult.ok, false);
  assert.equal(topbarResult.ok, false);
  assert.equal(appResult.rows.find((row) => row.scope === 'src/App.tsx')?.ok, false);
  assert.equal(
    topbarResult.rows.find((row) => row.scope === 'src/components/Topbar.tsx')?.ok,
    false,
  );
});

test('fails closed when a critical file or metric is missing', () => {
  const missingFile = report();
  missingFile.files.pop();
  assert.throws(
    () => checkCoverageRegression(report(), missingFile),
    /exactly one src\/components\/Topbar/,
  );

  const missingMetric = report();
  delete missingMetric.summary.branches;
  assert.throws(() => checkCoverageRegression(report(), missingMetric), /valid branches/);
});
