import '@testing-library/jest-dom';

// Vitest 4's default workers expose an undefined localStorage in this Node 22
// suite. Use jsdom's instance directly without breaking future Node-only files.
const testDom = (
  globalThis as typeof globalThis & { jsdom?: { window: { localStorage: Storage } } }
).jsdom;
if (testDom) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: testDom.window.localStorage,
    writable: true,
  });
}
