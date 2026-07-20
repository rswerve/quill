import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { applicationSourcePath, isApplicationSource } from './coveragePaths.mjs';

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
