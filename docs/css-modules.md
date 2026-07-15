# CSS conventions (hybrid Modules)

How styling is organized in Quill as we migrate `App.css` toward co-located,
scoped stylesheets. The stance is **aggressive-clean**: module-scoped by
default, a small deliberate global layer, and role-based tests. These
conventions are load-bearing — every component migration copies them, so change
them here (with review) rather than diverging per component.

## The global layer

A few things genuinely cascade across the whole app and stay global, loaded
once at the root in this fixed order:

1. **Design tokens** — `src/styles/tokens.css` (imported first via `@import` in
   `App.css`).
2. **Reset + base element styling** — `App.css` top.
3. **Shared primitives** — buttons (`.btn-primary` / `.btn-danger` /
   `.btn-ghost`) and other true design-system elements reused across components.
4. **Editor / generated DOM** — ProseMirror / Tiptap selectors, which are
   generated and cannot be scoped.
5. **Print** — the `@media print` policy block.

Cross-component load order beyond this layer is **a defect, not something to
order around** — module scoping is what removes the ordering problem.

Everything else is component-scoped.

## Modules

- One `*.module.css` co-located with its component; `import styles from
'./X.module.css'`.
- **Hashed by default.** Class names are private to the component. Do not keep a
  global class name for a component's own structure.
- **Component state/modifiers are module-local** (`styles.active`, not a global
  `.active` / `.on`) — those generic names are exactly what scoping exists to
  contain.
- Global hooks (`:global(...)`) are allowed only for **genuine cross-boundary
  styling** — not for tests, and not to preserve a name out of habit.

## Composition

- **True primitives stay global**; a component uses them by their global class:
  `className={cx(styles.actions, 'btn-primary')}`.
- Prefer an explicit `className` (a small `cx` helper) over CSS Modules
  `composes:` — `composes` is obscure, couples the module to global names
  anyway, and varies across bundlers.

## Print

Transient chrome that must never appear in printed output opts in with the
**`data-print-hidden`** attribute. The central print block hides it once:

```css
@media print {
  [data-print-hidden] {
    display: none !important;
  }
}
```

This expresses a global rendering policy instead of preserving a component
class name for an external stylesheet, and it's reusable by every overlay
(modal, session picker, notices, …). Keep `data-print-hidden` narrowly a
print-policy attribute — never a generic styling or test hook.

## Tests

- **Behavior (Playwright / RTL): role-first.** `getByRole('dialog', { name })`,
  `getByRole('button', { name })`. Narrow `data-*` only for genuinely
  non-semantic targets. Never a stable class kept solely for testing.
- **Style contracts: assert outcomes, not hashed names.** Inspect the authored
  rule in the component's `*.module.css` **source** (readable pre-hash names),
  or assert a computed style on the rendered element. `readAppStyles()` and
  fs-based CSS assertions cover only the **global layer**.
- When a component's CSS migrates to a Module, migrate its tests in the **same
  change** — a half-migrated suite (some role-based, some class-based) is the
  worst state.

## Reference: the AppModal pilot

`AppModal` is the first component migrated under these conventions and is the
worked example:

- `src/components/AppModal.module.css` — scoped `overlay`/`modal`/`title`/
  `message`/`actions`; no global class names.
- `src/components/AppModal.tsx` — `role="dialog"`, `aria-modal`,
  `aria-labelledby`/`aria-describedby` wired to `useId()` heading/message ids;
  `data-print-hidden` on the overlay; buttons use the global `.btn-*`
  primitives.
- `App.css` print block hides `[data-print-hidden]`; the modal is no longer
  named there.
- Tests: `getByRole('dialog', { name })` for behavior; the modal's type scale is
  asserted against `AppModal.module.css` source; a print-contract test pins that
  the global layer hides `[data-print-hidden]` and that `AppModal` emits it.
