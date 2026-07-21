const OVERALL_METRICS = ['lines', 'statements', 'branches', 'functions'];

// Chromium coverage can vary when CommentLayer animation/measurement effects
// win or lose a race at test teardown. Three CI runs of the identical tree
// demonstrated a maximum two-line and one-statement/branch swing, always in
// that file. The allowance below applies only when every denominator is
// unchanged and no other file loses coverage; source changes and unrelated
// regressions receive no allowance.
const COMMENT_LAYER_JITTER = {
  lines: 2,
  statements: 1,
  branches: 1,
  functions: 0,
};

const COMMENT_LAYER_PATH = 'src/components/CommentLayer.tsx';

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

function filesByPath(report, reportName) {
  const entries = (report.files ?? []).map((file) => [
    normalizedSourcePath(file.sourcePath ?? '').replace(/^.*(?=src\/)/, ''),
    file,
  ]);
  const result = new Map(entries);
  if (result.size !== entries.length) {
    throw new Error(`${reportName} contains duplicate normalized source paths`);
  }
  return result;
}

function commentLayerJitterAllowance(baselineReport, currentReport, metric) {
  const maximum = COMMENT_LAYER_JITTER[metric];
  if (maximum === 0) return 0;

  const baselineOverall = requireMetric(
    baselineReport.summary,
    metric,
    'Baseline overall coverage',
  );
  const currentOverall = requireMetric(currentReport.summary, metric, 'Current overall coverage');
  if (baselineOverall.total !== currentOverall.total) return 0;

  const baselineFiles = filesByPath(baselineReport, 'Baseline report');
  const currentFiles = filesByPath(currentReport, 'Current report');
  if (
    baselineFiles.size !== currentFiles.size ||
    [...baselineFiles.keys()].some((sourcePath) => !currentFiles.has(sourcePath))
  ) {
    return 0;
  }

  for (const [sourcePath, baselineFile] of baselineFiles) {
    const currentFile = currentFiles.get(sourcePath);
    const baseline = requireMetric(baselineFile.summary, metric, `Baseline ${sourcePath}`, true);
    const current = requireMetric(currentFile.summary, metric, `Current ${sourcePath}`, true);
    if (baseline.total !== current.total) return 0;
    const loss = baseline.covered - current.covered;
    if (sourcePath === COMMENT_LAYER_PATH) {
      if (loss > maximum) return 0;
    } else if (loss > 0) {
      return 0;
    }
  }

  return maximum;
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
    const allowedCoveredLoss = commentLayerJitterAllowance(baselineReport, currentReport, metric);
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
    const jitter =
      row.allowedCoveredLoss === 0
        ? 'none'
        : `${row.allowedCoveredLoss} count${row.allowedCoveredLoss === 1 ? '' : 's'}`;
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
