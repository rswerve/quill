/**
 * Join truthy class names into one className string. Used to compose a
 * module-local class with a global primitive (or a module base with a module
 * modifier) — see docs/css-modules.md. Keeps conditional classes readable
 * without pulling in a dependency.
 */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
