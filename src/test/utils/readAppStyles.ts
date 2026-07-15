import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The GLOBAL stylesheet layer composed in cascade order for style-contract
 * tests: design tokens (App.css @imports tokens.css), then App.css. Component
 * styles that migrate to co-located CSS Modules are NOT part of this composite —
 * their rules are asserted from the module source (see readComponentModules) or
 * as computed styles, per docs/css-modules.md. fs-based assertions against this
 * composite therefore cover the global layer only.
 *
 * Order is not load-bearing for current contracts (tokens live only in
 * tokens.css; no cross-file declaration competition) — revisit only if an
 * order-sensitive cross-file contract ever appears.
 */
const STYLESHEETS = ['src/styles/tokens.css', 'src/App.css'];

export function readAppStyles(): string {
  return STYLESHEETS.map((rel) => readFileSync(join(process.cwd(), rel), 'utf8')).join('\n');
}

/**
 * Every co-located component CSS Module, concatenated. Used by global-invariant
 * contracts (e.g. the type scale) that must hold across module sources as well
 * as the global layer, so new modules are covered automatically.
 */
export function readComponentModules(): string {
  const dir = join(process.cwd(), 'src/components');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.module.css'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}
