# Releasing Quill

How a Quill build reaches Truss: build a universal macOS app locally, ad-hoc sign it, and publish
it to the shared Google Drive folder `Shared drives/Truss/Engineering/Tools`. Teammates install
from their synced Finder copy of that folder, either by hand or through Quill's local Drive
updater (see [Updating](../README.md#updating) and
[The local Drive updater](SECURITY.md#the-local-drive-updater)).

Every step has a verification. Run it and read its output; do not assume.

## Release gate

A build may be published only if green runs of both workflows below tested its exact source tree.
Every job in both runs must have passed.

The `CI` workflow (`.github/workflows/ci.yml`) has five jobs:

- **`Frontend (Node.js)`**: type check, ESLint, Prettier check, Vitest with coverage.
- **`End-to-end (Playwright)`**: the Playwright `chromium` project on Linux, except the
  `@macos-shortcuts` tests.
- **`End-to-end (Visual)`**: the Playwright `visual` project and the `@macos-shortcuts` tests on
  macOS.
- **`Combined coverage`**: fails unless the three jobs above succeeded, then merges their coverage
  and checks it for regression against the last successful push run on `main`.
- **`Rust (Tauri backend)`**: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.

The separate `E2E production bundle` workflow (`.github/workflows/e2e-production.yml`) has one job,
**`End-to-end (Production bundle)`**: the Playwright `chromium` project, except the
`@macos-shortcuts` tests, against a built production bundle instead of the dev server. Its header
says it is not a required status check. That is a branch-protection setting for merging pull
requests; a release requires this job to pass as well.

Use the runs triggered by the push to `main`. A pull-request run tests GitHub's temporary merge of
the branch into `main`, not the branch head.

"Exact tree" means the tree hash, not the commit SHA. Two clones that merged the same change can
have different commit SHAs and identical trees. Never build from a dirty tree or from "basically
the same" local state.

Publishing is a manual copy, so nothing physically stops an ungated build from reaching Drive. The
gate defines what is allowed to ship.

## 1. Toolchain

### Node

Install dependencies and build under Node `>=22.23.4 <23`, the range in `package.json` `engines`.
Do not assume the machine's default `node`; it may be another major. `.nvmrc` and `mise.toml` pin
major 22, and `.npmrc` sets `engine-strict` so npm enforces `engines` when installing. `npm run`
does not check `engines`, so build in the same shell you checked:

```bash
node --version   # v22.x, at least v22.23.4
```

### Rust

Build with the same `rustc` version as the green run's `Rust (Tauri backend)` job. That job installs
the current stable release (`dtolnay/rust-toolchain@stable`), so the version changes over time.
Read it from the job's `Install Rust toolchain` step and record it as `RUST_VERSION`; step 4 uses
it again.

The universal build needs that version through rustup, with both macOS targets. Homebrew's Rust
carries only the host standard library, so a universal build using it compiles one half and then
fails:

```text
error[E0463]: can't find crate for `core`
= note: the `x86_64-apple-darwin` target may not be installed
```

Adding the target through rustup does not help if Tauri still invokes Homebrew's `cargo`. Step 4
therefore puts the selected rustup toolchain's own `bin` folder first on `PATH` and checks that
`cargo` and `rustc` come from it. Where rustup keeps its files does not matter: the default
`~/.cargo` and `~/.rustup`, or a task-local installation with `CARGO_HOME` and `RUSTUP_HOME`
exported, both work. Only `rustup` itself must be on `PATH`:

```bash
RUST_VERSION=1.N.N   # the green run's rustc version
command -v rustup    # must print a path
rustup toolchain install "$RUST_VERSION"
rustup target add --toolchain "$RUST_VERSION" aarch64-apple-darwin x86_64-apple-darwin
rustup target list --toolchain "$RUST_VERSION" --installed   # must list both targets
```

## 2. Prepare the release commit

Every Drive release gets a new version. The updater offers only a version higher than the running
app's, so a rebuild published under an existing version never reaches in-app updates, and two
different builds cannot be told apart.

The version lives in five places, and all must agree. Edit each by hand:

- `package.json`: `"version"`
- `src-tauri/Cargo.toml`: `version`
- `src-tauri/tauri.conf.json`: `"version"`
- `package-lock.json`: the top-level `"version"` and `packages[""].version`
- `src-tauri/Cargo.lock`: the `version` line under `name = "quill"`

Do not regenerate a lockfile to change the version: no `npm install --package-lock-only`, no
`cargo update`. A version bump needs no dependency resolution. A `package-lock.json` regenerated
under a different npm once rewrote dependency metadata, dropped a package, and failed `npm ci` in
every Node CI job. If a change genuinely needs a regenerated lockfile, regenerate it under the
Node range above, in its own change.

Check the bump under the Node and Rust toolchains from step 1:

```bash
VERSION=X.Y.Z
grep -m1 '"version"' package.json src-tauri/tauri.conf.json
grep -m1 '^version' src-tauri/Cargo.toml
grep -n "\"version\": \"$VERSION\"" package-lock.json   # exactly 2 hits, both yours
grep -A1 '^name = "quill"$' src-tauri/Cargo.lock
npm ci --dry-run                                        # must succeed; EUSAGE means a bad lockfile
(cd src-tauri && cargo metadata --locked --format-version 1 >/dev/null)   # must exit 0
```

Add a release note at `docs/release-notes/vX.Y.Z.md`, following the latest note's layout. Land
the bump and the note through a pull request, then wait for the gate.

## 3. Check out the tested tree

From the root of a checkout, check out the commit the green push runs tested, or a commit whose
tree is identical to it:

```bash
git fetch --all
git checkout --detach <commit>
git rev-parse 'HEAD^{tree}' '<tested-commit>^{tree}'   # the two hashes must match
git status --porcelain                                 # must print nothing
npm ci                                                 # under the Node checked in step 1
```

## 4. Build

Steps 4 to 9 share these variables and functions. Run them in one `bash` shell, started for this
release, from the checkout root. With `set -euo pipefail`, a failing command, a failure anywhere in
a pipeline, or an unset variable ends that shell, so nothing runs after a failed check. A failure
inside an `if` condition or a `&&` or `||` list does not end it, so each check below is its own
command. If your shell does not keep state between commands, put this block at the top of each
command, and replace the `mktemp` call with the `WORK` path it first printed:

```bash
set -euo pipefail
VERSION=X.Y.Z
RUST_VERSION=1.N.N   # from step 1
TOOLCHAIN_BIN="$(dirname "$(rustup which --toolchain "$RUST_VERSION" rustc)")"
export RUSTUP_TOOLCHAIN="$RUST_VERSION" RUSTC="$TOOLCHAIN_BIN/rustc" PATH="$TOOLCHAIN_BIN:$PATH"
TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/src-tauri/target}"
case "$TARGET_DIR" in /*) ;; *) echo 'CARGO_TARGET_DIR must be absolute' >&2; exit 1 ;; esac
APP="$TARGET_DIR/universal-apple-darwin/release/bundle/macos/Quill.app"
WORK="$(mktemp -d)"   # this release's manifests and copies
printf 'WORK=%s\n' "$WORK"
manifest() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256); }
bundle_facts() {
  local exe
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist")"
  file "$1/Contents/MacOS/$exe"
  lipo -info "$1/Contents/MacOS/$exe"
  for key in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion; do
    /usr/libexec/PlistBuddy -c "Print :$key" "$1/Contents/Info.plist"
  done
}
# Copies the Drive bundle $1 into a fresh folder under $WORK as Install and Restart stages it:
# plain ditto, then FinderInfo and ResourceFork removed from each item that has them, without
# following symlinks. Then strict-verifies that copy. Changes nothing outside the new folder.
updater_check() {
  local copy item names attr
  copy="$(mktemp -d "$WORK/updater-check.XXXXXX")/Quill.app"
  /usr/bin/ditto "$1" "$copy"
  find "$copy" -print0 | while IFS= read -r -d '' item; do
    names="$(/usr/bin/xattr -s "$item")"
    for attr in com.apple.FinderInfo com.apple.ResourceFork; do
      if printf '%s\n' "$names" | grep -Fqx "$attr"; then
        /usr/bin/xattr -d -s "$attr" "$item"
      fi
    done
  done
  /usr/bin/codesign --verify --deep --strict --verbose=4 "$copy"
}
```

The build goes to `CARGO_TARGET_DIR` when it is set, and to `src-tauri/target` otherwise. A
relative `CARGO_TARGET_DIR` stops the block, because which folder it names depends on the directory
`cargo` runs in.

Check and record the toolchain, then build only the app bundle:

```bash
test "$(command -v cargo)" = "$TOOLCHAIN_BIN/cargo"   # rustup's cargo for $RUST_VERSION
test "$(command -v rustc)" = "$TOOLCHAIN_BIN/rustc"
rustc --version --verbose > "$WORK/rustc.txt"
cargo --version --verbose > "$WORK/cargo.txt"
grep -Fx "release: $RUST_VERSION" "$WORK/rustc.txt"   # must match the green run's compiler
grep -Fx "release: $RUST_VERSION" "$WORK/cargo.txt"
npm run tauri build -- --target universal-apple-darwin --bundles app
test -d "$APP"
git status --porcelain   # must still print nothing
```

A successful build ends with:

```text
Bundling Quill.app (.../release/bundle/macos/Quill.app)
Finished 1 bundle at:
    .../release/bundle/macos/Quill.app
```

Without `--bundles app`, Tauri also tries every other bundle target in `tauri.conf.json`, and the
DMG step fails locally after the app is built. Truss ships `Quill.app`, not a DMG, and a build that
exits non-zero hides whether the app step also had problems.

## 5. Sign the bundle (ad-hoc)

A fresh build carries only a linker signature on the executable, which strict verification
rejects with `code object is not signed at all`. Apply a bundle-level ad-hoc signature to the
local candidate:

```bash
xattr -cr "$APP"
codesign --force --deep --sign - --identifier com.trussworks.quill "$APP"
codesign --verify --deep --strict --verbose=4 "$APP"
codesign -dvvv "$APP" 2>&1
```

`--sign -` means ad-hoc: not Developer ID, not notarized. Run `xattr -cr` only on this local
candidate. Never change attributes on anything in Drive; the only `xattr` commands for Drive items
are the read-only ones in step 8.

Strict verification must exit zero and print:

```text
Quill.app: valid on disk
Quill.app: satisfies its Designated Requirement
```

The detail output must include:

```text
Identifier=com.trussworks.quill
Format=app bundle with Mach-O universal (x86_64 arm64)
flags=0x2(adhoc)
Signature=adhoc
TeamIdentifier=not set
Sealed Resources version=2
```

## 6. Verify the candidate

```bash
bundle_facts "$APP"
```

The output must show a `Mach-O universal binary with 2 architectures` and
`Architectures in the fat file: ... are: x86_64 arm64`, then `com.trussworks.quill`, then
`$VERSION` twice (`CFBundleShortVersionString` and `CFBundleVersion`). An arm64-only build strands
every Intel Mac.

Optional diagnostics: `shasum -a 256` of the executable and `du -sh "$APP"`.

## 7. Publish to Google Drive

```bash
TOOLS="$HOME/Library/CloudStorage/GoogleDrive-<your-account>@truss.works/Shared drives/Truss/Engineering/Tools"
DEST="$TOOLS/Quill.app"
STAMP="$(date +%Y%m%d-%H%M%S)"   # reuse this value in later shells
printf 'STAMP=%s\n' "$STAMP"
STAGE="$TOOLS/.Quill.staging-$STAMP.app"
BACKUP="$TOOLS/.Quill.previous-$STAMP.app"
```

The only visible items in `Tools` are `Quill.app` and `Quill.version`. Never copy repository
directories there. The Drive website shows `Quill.app` as a folder; a `.app` is a directory bundle.

**Stage:**

```bash
test ! -e "$STAGE"
test ! -e "$BACKUP"
ditto "$APP" "$STAGE"
```

**Byte-compare the candidate against the staged copy.** `diff` must exit zero with no output. The
manifests cover file bytes only; DriveFS adds its own extended attributes.

```bash
manifest "$APP" > "$WORK/candidate.sha256"
manifest "$STAGE" > "$WORK/stage.sha256"
diff -u "$WORK/candidate.sha256" "$WORK/stage.sha256"
bundle_facts "$STAGE"   # same expectations as step 6
```

**Check the updater's copy.** Install and Restart copies the Drive bundle with plain `ditto` and
refuses the copy unless `codesign --verify --deep --strict` passes. `ditto` carries extended
attributes into the copy. Tests on macOS 27.0.1 with constructed bundles found two that make strict
verification fail on an intact, signed bundle, with "resource fork, Finder information, or similar
detritus not allowed":

- a non-zero `com.apple.FinderInfo` on the bundle's top directory, the main executable, or a sealed
  resource;
- `com.apple.ResourceFork` on the main executable or a sealed resource.

Drive's item-ID attribute, quarantine and provenance did not cause failures. Where Drive for
desktop puts FinderInfo on a published bundle is not known. From Quill 1.1.23, the updater removes
only those two attributes from its local copy, then runs the strict check; if a removal fails, it
stops before Quill quits. Published releases up to 1.1.22 do not check the copy's signature, so
these attributes do not affect their updates.

`updater_check` copies `$STAGE` the same way into a fresh folder under `$WORK` and strict-verifies
that copy. It only reads Drive:

```bash
updater_check "$STAGE"
```

If it fails, do not promote. Leave `$STAGE` in place and report the full output. Never change the
Drive copy to make the check pass.

**Promote**, only after every check above passes. `Quill.version` is written after the swap, from
the promoted bundle, so a failure never advertises a version that is not published:

```bash
mv "$DEST" "$BACKUP"
mv "$STAGE" "$DEST"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" \
  > "$TOOLS/Quill.version"
printf 'DEST=%s\nBACKUP=%s\nVERSION=%s\n' "$DEST" "$BACKUP" "$(cat "$TOOLS/Quill.version")"
```

`Quill.version` is not optional. Quill's update check reads it first and falls back to the
bundle's `Info.plist` only when it is missing, which is slow when Drive keeps the bundle
online-only. The updater also refuses an install whose copied bundle version differs from the
version offered.

The previous release stays beside it as `.Quill.previous-YYYYMMDD-HHMMSS.app`. Preserve every
backup; never delete old ones automatically. If promotion fails after the first `mv`, that backup
is the only rollback source.

## 8. Verify the published copy

```bash
manifest "$DEST" > "$WORK/published.sha256"
diff -u "$WORK/candidate.sha256" "$WORK/published.sha256"   # must print nothing
bundle_facts "$DEST"                                        # same expectations as step 6
cat "$TOOLS/Quill.version"                                  # must print $VERSION
updater_check "$DEST"
```

Drive may add attributes after the move, so `updater_check` runs again on the published copy.
If it fails here, roll back as in step 9 and report the full output.

Do not run strict `codesign` on the Drive item itself. Its attributes can fail that check even when
the updater, which removes FinderInfo and ResourceFork from its copy, would accept the bundle. The
authoritative strict check of the signature is the one on the clean local candidate in step 5; the
manifests prove the signed files arrived unchanged; `updater_check` shows whether Install and
Restart accepts the published copy.

### Confirm Drive received it server-side

The local sync cache is not proof of upload. Read the Drive item ID:

```bash
xattr -p 'com.google.drivefs.item-id#S' "$DEST"
```

If there is no ID yet, Drive has not created the server object; wait for sync and retry. Then
query that ID through the Google Drive API, not the mounted filesystem, with
`supportsAllDrives: true` and the fields
`id,name,mimeType,modifiedTime,parents,driveId,size,trashed,capabilities(canDownload)`.

Confirm the item ID, `name: Quill.app`, the shared drive ID, the expected parent, and
`trashed: false`. Expect `mimeType: application/vnd.google-apps.folder`. `ditto` preserves the
build's timestamps, so `modifiedTime` should be plausible for this build, not "now". Drive exposes
no whole-folder checksum, so this server read and the byte manifests are both required.

### Check quarantine

Users must install from the synced Finder folder, never through the Drive website's Download
button. A copy that arrives through Drive for desktop sync has no `com.apple.quarantine`, so the
ad-hoc-signed app opens without a prompt; a browser download is quarantined and Gatekeeper blocks
it. Check every published build:

```bash
xattr "$DEST"
```

For this check, other attributes such as `com.apple.FinderInfo`, `com.apple.provenance`,
`com.google.drivefs.item-id#S` and `com.apple.lastuseddate#PS` are fine.
`com.apple.quarantine` must not appear.

## 9. Rollback

Every promotion leaves `.Quill.previous-YYYYMMDD-HHMMSS.app` beside the live app. Do not re-run
step 8's comparison after a rollback: it compares against the new, bad build. Rollback captures
its own manifest before moving anything. Run the step 4 block and set `TOOLS` and `DEST` as in
step 7 first:

```bash
ROLLBACK="$TOOLS/.Quill.previous-<STAMP>.app"   # the backup to restore
BAD="$TOOLS/.Quill.bad-$(date +%Y%m%d-%H%M%S).app"
RBWORK="$(mktemp -d)"
printf 'RBWORK=%s\n' "$RBWORK"

manifest "$ROLLBACK" > "$RBWORK/rollback-source.sha256"
test ! -e "$BAD"
mv "$DEST" "$BAD"
mv "$ROLLBACK" "$DEST"
manifest "$DEST" > "$RBWORK/rollback-dest.sha256"
diff -u "$RBWORK/rollback-source.sha256" "$RBWORK/rollback-dest.sha256"
```

`diff` must print nothing. Then rewrite `Quill.version` from the restored bundle:

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" \
  > "$TOOLS/Quill.version"
cat "$TOOLS/Quill.version"
```

Left at the bad version, `Quill.version` offers a version the restored bundle does not carry, and
the updater refuses every install it offers. Then verify the restored app on its own terms, against
its own (older) version: `bundle_facts "$DEST"`, `codesign -dvvv "$DEST"`, and the server-side and
quarantine checks from step 8.

Keep the parked `.Quill.bad-*` bundle until the cause is understood. The updater offers only newer
versions, so anyone who already installed the bad build must reinstall by hand from the synced
folder, as the README describes.

## Known gaps

- **No Developer ID signing or notarization.** The ad-hoc signature proves the bundle is intact,
  not who published it, and the app opens without a prompt only when it arrives through Drive for
  desktop sync.
- **`spctl` and `syspolicy_check` reject ad-hoc apps** that launch fine without quarantine. Do not
  use them as an install or launch gate.
- **`.github/workflows/release.yml` is dormant.** Its unsigned, per-architecture GitHub Release
  artifacts are not what Quill ships. Do not use it.
- **Publishing is manual.** The gate governs which builds may ship; nothing automated stops a
  hand-copied build.
