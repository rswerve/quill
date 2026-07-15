import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app's stylesheets composed in cascade order for style-contract tests.
 * As component blocks are extracted out of App.css into co-located stylesheets,
 * add them here — a single edit keeps every style suite reading the full
 * composite, so an assertion resolves a token/rule wherever it physically lives.
 *
 * Order approximates the shipped cascade: tokens first (App.css @imports
 * tokens.css), then App.css, then co-located component sheets. There is no
 * cross-file declaration competition today (tokens live only in tokens.css;
 * each extracted component rule has no rival elsewhere), so this order is not
 * load-bearing for current contracts — revisit only if an order-sensitive
 * cross-file contract ever appears.
 */
const STYLESHEETS = ['src/styles/tokens.css', 'src/App.css'];

export function readAppStyles(): string {
  return STYLESHEETS.map((rel) => readFileSync(join(process.cwd(), rel), 'utf8')).join('\n');
}
