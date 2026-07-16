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
 * Every co-located component CSS Module under src/, concatenated. Used by
 * global-invariant contracts (e.g. the type scale) that must hold across module
 * sources as well as the global layer. Discovery recurses so a module in a
 * nested component folder (e.g. src/components/comments/X.module.css) can't
 * silently escape the invariant as the tree grows.
 */
export function readComponentModules(): string {
  const root = join(process.cwd(), 'src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.module.css'))
    .map((rel) => readFileSync(join(root, rel), 'utf8'))
    .join('\n');
}

/**
 * One component module's source, for COMPONENT-SPECIFIC rule assertions (e.g.
 * "AppModal's .title is 15px"). Read the owning module directly so a generic
 * selector like .title/.banner can't false-match another module — the recursive
 * aggregate (readComponentModules) is only for the global allowed-scale set.
 */
export function readModuleSource(componentModule: string): string {
  return readFileSync(join(process.cwd(), 'src/components', componentModule), 'utf8');
}
