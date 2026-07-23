const OVERALL_METRICS = ['lines', 'statements', 'branches', 'functions'];

// A source-only deletion must not fail merely because removing covered code
// lowers the ratio: it passes when the number of uncovered items does not grow.
// Added uncovered code and newly uncovered existing code still fail.

const CRITICAL_LINE_FILES = ['src/App.tsx', 'src/components/Topbar.tsx'];

function normalizedSourcePath(sourcePath) {
  return sourcePath.replaceAll('\\', '/');
}

function requireMetric(summary, metric, scope, allowEmpty = false) {
  const value = summary?.[metric];
  if (
    !value ||
    !Number.isInteger(value.covered) ||
    !Number.isInteger(value.total) ||
    value.covered < 0 ||
    value.total < (allowEmpty ? 0 : 1) ||
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

function rowFor(scope, metric, baseline, current) {
  const baselineRatio = ratio(baseline);
  const currentRatio = ratio(current);
  const uncoveredIncrease = current.total - current.covered - (baseline.total - baseline.covered);
  return {
    scope,
    metric,
    baseline,
    current,
    changePercentagePoints: (currentRatio - baselineRatio) * 100,
    ok:
      current.covered * baseline.total >= baseline.covered * current.total ||
      uncoveredIncrease <= 0,
  };
}

export function checkCoverageRegression(baselineReport, currentReport) {
  const rows = OVERALL_METRICS.map((metric) => {
    const baseline = requireMetric(baselineReport.summary, metric, 'Baseline overall coverage');
    const current = requireMetric(currentReport.summary, metric, 'Current overall coverage');
    return rowFor('Overall', metric, baseline, current);
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
    const change = `${row.changePercentagePoints >= 0 ? '+' : ''}${row.changePercentagePoints.toFixed(4)} pp`;
    return `| ${row.scope} | ${row.metric} | ${percentage(row.baseline)} | ${percentage(row.current)} | ${change} | ${row.ok ? 'PASS' : 'FAIL'} |`;
  });

  return [
    '# Coverage regression gate',
    '',
    `Baseline commit: \`${baselineSha}\``,
    '',
    '| Scope | Metric | Baseline | Current | Change | Result |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    result.ok ? 'Coverage did not materially decrease.' : 'Coverage regressed.',
    '',
  ].join('\n');
}
