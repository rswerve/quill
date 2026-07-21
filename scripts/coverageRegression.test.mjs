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
  commentLines = [180, 200],
  commentStatements = [170, 200],
  commentBranches = [140, 200],
  commentFunctions = [35, 40],
  otherLines = [70, 80],
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
      {
        sourcePath: '/checkout/src/components/CommentLayer.tsx',
        summary: {
          lines: metric(...commentLines),
          statements: metric(...commentStatements),
          branches: metric(...commentBranches),
          functions: metric(...commentFunctions),
        },
      },
      {
        sourcePath: '/checkout/src/components/Other.tsx',
        summary: { lines: metric(...otherLines) },
      },
    ],
  };
}

function addAllMetricsToCriticalFiles(value) {
  for (const file of [value.files[0], value.files[1], value.files[3]]) {
    file.summary.statements = metric(80, 100);
    file.summary.branches = metric(70, 100);
    file.summary.functions = metric(18, 20);
  }
  return value;
}

function completeReport(options) {
  return addAllMetricsToCriticalFiles(report(options));
}

test('accepts unchanged and improved coverage', () => {
  assert.equal(checkCoverageRegression(completeReport(), completeReport()).ok, true);
  assert.equal(
    checkCoverageRegression(
      completeReport(),
      completeReport({ lines: [910, 1000], appLines: [91, 100] }),
    ).ok,
    true,
  );
});

test('allows only the observed CommentLayer same-tree V8 jitter', () => {
  const current = completeReport({
    lines: [898, 1000],
    statements: [849, 1000],
    branches: [699, 1000],
    commentLines: [178, 200],
    commentStatements: [169, 200],
    commentBranches: [139, 200],
  });
  assert.equal(checkCoverageRegression(completeReport(), current).ok, true);
});

test('rejects a material same-denominator decrease', () => {
  const result = checkCoverageRegression(
    completeReport(),
    completeReport({ lines: [897, 1000], commentLines: [177, 200] }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.metric === 'lines')?.ok, false);
});

test('rejects an equal-sized loss outside CommentLayer', () => {
  const current = completeReport({ lines: [899, 1000], otherLines: [69, 80] });
  const result = checkCoverageRegression(completeReport(), current);
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.metric === 'lines')?.allowedCoveredLoss, 0);
});

test('rejects any function coverage decrease', () => {
  const result = checkCoverageRegression(
    completeReport(),
    completeReport({ functions: [179, 200], commentFunctions: [34, 40] }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.metric === 'functions')?.ok, false);
});

test('does not apply jitter when source changes the denominator', () => {
  const result = checkCoverageRegression(completeReport(), completeReport({ lines: [900, 1001] }));
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.metric === 'lines')?.allowedCoveredLoss, 0);
});

test('rejects line regressions in App and Topbar even when overall coverage is unchanged', () => {
  const appResult = checkCoverageRegression(
    completeReport(),
    completeReport({ appLines: [89, 100] }),
  );
  const topbarResult = checkCoverageRegression(
    completeReport(),
    completeReport({ topbarLines: [44, 50] }),
  );
  assert.equal(appResult.ok, false);
  assert.equal(topbarResult.ok, false);
  assert.equal(appResult.rows.find((row) => row.scope === 'src/App.tsx')?.ok, false);
  assert.equal(
    topbarResult.rows.find((row) => row.scope === 'src/components/Topbar.tsx')?.ok,
    false,
  );
});

test('fails closed when a critical file or metric is missing', () => {
  const missingFile = completeReport();
  missingFile.files.splice(1, 1);
  assert.throws(
    () => checkCoverageRegression(completeReport(), missingFile),
    /exactly one src\/components\/Topbar/,
  );

  const missingMetric = completeReport();
  delete missingMetric.summary.branches;
  assert.throws(() => checkCoverageRegression(completeReport(), missingMetric), /valid branches/);
});
