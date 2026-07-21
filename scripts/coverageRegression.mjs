const OVERALL_METRICS = ['lines', 'statements', 'branches', 'functions'];

// Chromium coverage can vary by one executed range when an animation/timer
// callback wins or loses a race at test teardown. Two CI runs of the identical
// tree demonstrated that behavior for lines, statements, and branches. Permit
// that one-count jitter only when the denominator is identical; source changes
// (and function coverage) receive no allowance.
const SAME_DENOMINATOR_JITTER = {
  lines: 1,
  statements: 1,
  branches: 1,
  functions: 0,
};

const CRITICAL_LINE_FILES = ['src/App.tsx', 'src/components/Topbar.tsx'];

function normalizedSourcePath(sourcePath) {
  return sourcePath.replaceAll('\\', '/');
}

function requireMetric(summary, metric, scope) {
  const value = summary?.[metric];
  if (
    !value ||
    !Number.isInteger(value.covered) ||
    !Number.isInteger(value.total) ||
    value.covered < 0 ||
    value.total <= 0 ||
    value.covered > value.total
  ) {
    throw new Error(`${scope} has no valid ${metric} coverage counts`);
  }
  return { covered: value.covered, total: value.total };
}

function findFile(report, relativePath, reportName) {
  const matches = (report.files ?? []).filter((file) =>
    normalizedSourcePath(file.sourcePath ?? '').endsWith(relativePath),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${reportName} must contain exactly one ${relativePath} entry; found ${matches.length}`,
    );
  }
  return matches[0];
}

function ratio({ covered, total }) {
  return covered / total;
}

function rowFor(scope, metric, baseline, current, allowedCoveredLoss) {
  const baselineRatio = ratio(baseline);
  const currentRatio = ratio(current);
  return {
    scope,
    metric,
    baseline,
    current,
    allowedCoveredLoss,
    changePercentagePoints: (currentRatio - baselineRatio) * 100,
    ok: (current.covered + allowedCoveredLoss) * baseline.total >= baseline.covered * current.total,
  };
}

export function checkCoverageRegression(baselineReport, currentReport) {
  const rows = OVERALL_METRICS.map((metric) => {
    const baseline = requireMetric(baselineReport.summary, metric, 'Baseline overall coverage');
    const current = requireMetric(currentReport.summary, metric, 'Current overall coverage');
    const allowedCoveredLoss =
      baseline.total === current.total ? SAME_DENOMINATOR_JITTER[metric] : 0;
    return rowFor('Overall', metric, baseline, current, allowedCoveredLoss);
  });

  for (const relativePath of CRITICAL_LINE_FILES) {
    const baselineFile = findFile(baselineReport, relativePath, 'Baseline report');
    const currentFile = findFile(currentReport, relativePath, 'Current report');
    rows.push(
      rowFor(
        relativePath,
        'lines',
        requireMetric(baselineFile.summary, 'lines', `Baseline ${relativePath}`),
        requireMetric(currentFile.summary, 'lines', `Current ${relativePath}`),
        0,
      ),
    );
  }

  return { ok: rows.every((row) => row.ok), rows };
}

function percentage({ covered, total }) {
  return `${((covered / total) * 100).toFixed(4)}% (${covered}/${total})`;
}

export function formatCoverageRegressionMarkdown(result, baselineSha = 'unknown') {
  const rows = result.rows.map((row) => {
    const jitter = row.allowedCoveredLoss === 0 ? 'none' : `${row.allowedCoveredLoss} count`;
    const change = `${row.changePercentagePoints >= 0 ? '+' : ''}${row.changePercentagePoints.toFixed(4)} pp`;
    return `| ${row.scope} | ${row.metric} | ${percentage(row.baseline)} | ${percentage(row.current)} | ${change} | ${jitter} | ${row.ok ? 'PASS' : 'FAIL'} |`;
  });

  return [
    '# Coverage regression gate',
    '',
    `Baseline commit: \`${baselineSha}\``,
    '',
    '| Scope | Metric | Baseline | Current | Change | Same-tree jitter | Result |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    result.ok
      ? 'Coverage did not materially decrease.'
      : 'Coverage regressed beyond the permitted same-tree jitter.',
    '',
  ].join('\n');
}
