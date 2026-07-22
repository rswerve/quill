import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  applicationSourcePath,
  isApplicationSource,
  isCollectableCoverageUrl,
} from './coveragePaths.mjs';

const checkout = path.resolve('/checkout/quill');

test('normalizes unit and browser sourcemaps from different CI machines to one source path', () => {
  const expected = path.join(checkout, 'src/App.tsx');
  assert.equal(
    applicationSourcePath('/home/runner/work/quill/quill/src/App.tsx', {}, checkout),
    expected,
  );
  assert.equal(
    applicationSourcePath('App.tsx', { distFile: 'http://localhost:1420/src/App.tsx' }, checkout),
    expected,
  );
  assert.equal(applicationSourcePath('C:\\work\\quill\\src\\App.tsx', {}, checkout), expected);
});

test('keeps application TypeScript and excludes test-only or bootstrap sources', () => {
  assert.equal(isApplicationSource('App.tsx'), true);
  assert.equal(isApplicationSource('/src/components/Topbar.tsx'), true);
  assert.equal(isApplicationSource('/src/main.tsx'), false);
  assert.equal(isApplicationSource('/src/vite-env.d.ts'), false);
  assert.equal(isApplicationSource('/src/test/App.test.tsx'), false);
  assert.equal(isApplicationSource('/src/types/index.ts'), false);
  assert.equal(isApplicationSource('/node_modules/example.ts'), false);
});

test('isCollectableCoverageUrl accepts only dev-server application modules', () => {
  // Consumed at both collection seams (the Playwright fixture and the reporter's
  // entryFilter). They previously held separate copies of this rule, and
  // widening one silently did nothing because the other had already discarded
  // the entries — a production run recorded zero coverage while appearing to
  // succeed. Pinned here so the shared definition cannot drift unnoticed.
  assert.equal(isCollectableCoverageUrl('/src/App.tsx'), true);
  assert.equal(isCollectableCoverageUrl('/src/components/Editor.tsx'), true);
  assert.equal(isCollectableCoverageUrl('/src/utils/linkEditing.ts'), true);

  assert.equal(isCollectableCoverageUrl('/src/main.tsx'), false);
  assert.equal(isCollectableCoverageUrl('/src/test/helpers.ts'), false);
  assert.equal(isCollectableCoverageUrl('/src/types/index.ts'), false);
  assert.equal(isCollectableCoverageUrl('/src/App.css'), false);

  // Built-bundle chunks are excluded on purpose: bundling coarsens the
  // sourcemap and credits lines that never ran.
  assert.equal(isCollectableCoverageUrl('/assets/index-abc123.js'), false);
  assert.equal(isCollectableCoverageUrl('/assets/index-abc123.js.map'), false);
  assert.equal(isCollectableCoverageUrl('/node_modules/react/index.js'), false);
});
