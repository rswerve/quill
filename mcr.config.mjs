import { applicationSourcePath, isApplicationSource } from './scripts/coveragePaths.mjs';

export default {
  name: 'Quill Vitest coverage',
  provider: 'v8',
  outputDir: 'coverage/unit',
  reports: [
    ['raw', { outputDir: 'raw' }],
    ['v8-json', { outputFile: 'coverage-report.json' }],
    ['json', { file: 'coverage-final.json' }],
    ['lcovonly', { file: 'lcov.info' }],
    ['html', { subdir: 'html' }],
    ['console-summary'],
  ],
  sourceFilter: isApplicationSource,
  sourcePath: applicationSourcePath,
  all: {
    dir: ['src'],
    filter: isApplicationSource,
  },
};
