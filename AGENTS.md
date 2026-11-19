# AGENTS.md — Screenshot Scan

You are an AI agent. The owner of this repo **does not read or write code**:
everything you need to understand, install, test and change the project is in
this file and the repo. Keep this file true: update it in the same commit as
any change it describes. `CLAUDE.md` is a symlink to this file.

## Purpose

A GNOME Shell extension that adds a **Scan** mode to GNOME's *native*
screenshot UI (the one Print Screen opens). With Scan selected, capturing an
area, a window or the screen:

1. decodes QR codes and 1D barcodes with `zbarimg`,
2. reads text with `tesseract`,
3. copies the result to the clipboard as plain text and shows a notification
   ("Copied 3 lines" / "No text found"),
4. saves **no** screenshot file. The only temp PNG is a mode-0600 file in
   `$XDG_RUNTIME_DIR`, deleted right after the scan.

Everything runs locally, with no network access.

What is on screen is untrusted input (anyone can show you a QR code). Tool
output is stripped of control characters, keeping tab and newline
(`stripControlChars` in `lib/pipeline.js`), so a pasted result cannot send
escape sequences to a terminal.

Default result (`result-mode = auto`): code payloads one per line if any were
found, otherwise the OCR text. Other modes: `codes`, `text`, `both` (codes,
blank line, text). OCR languages: `ocr-languages`, default `eng` (the owner
chose English only, 2026-11-19).

- UUID: `screenshot-scan@awikman-bot.github.io`
- Repo: https://github.com/awikman-bot/screenshot-scan (**public** since
  2026-11-19, after the owner's desktop test)
- License: GPL-2.0-or-later. See `CREDITS.md` for copied code.
- Supported: GNOME Shell **50** (tested at runtime) and **51** (source-reviewed
  only, see "Version status"). ESM format, so GNOME 45+ only.

## Rules for agents

- **No sudo, ever.** If something needs root (system packages), stop and ask
  the owner. Give the exact commands in one copy-pasteable block, say why
  each is needed, and batch requests so you ask rarely. Do not work around
  this (no extracting RPMs, no containers to dodge it).
- Ask the owner only about: sudo commands, manual desktop tests, OCR
  languages. The repo is public: never commit internal or personal data.
  Decide implementation details yourself and document them (here or in `docs/research.md`).
- Run `make check` before every commit. Commit small, push often.
- Never copy code without checking its license and crediting it (header
  comment + `CREDITS.md`). Nothing GPL-3.0-only, nothing unlicensed.
- Commits/PRs as `awikman-bot` (gh and git are authenticated; git uses SSH).

## File map

```
extension/                      ← exactly what gets installed / packed
  metadata.json                 uuid, shell-version list, settings schema
  extension.js                  enable()/disable(); temp file → pipeline → clipboard → notification
  prefs.js                      Adw preferences window (separate GTK process)
  lib/screenshotUiPatch.js      ★ ALL private gnome-shell access lives here
  lib/pipeline.js               image file → text; Gio/GLib only, no Shell imports
  lib/tempfile.js               private temp PNGs in $XDG_RUNTIME_DIR
  schemas/*.gschema.xml         settings: result-mode, ocr-languages, show-notifications
  icons/screenshot-scan-symbolic.svg
tests/
  pipeline.test.js              headless gjs tests of lib/pipeline.js (make test)
  fixtures/*.png                text, dark text, QR, EAN-13, Code128, blank, mixed
  fixtures/generate.py          regenerates the PNGs (make fixtures)
  e2e/run.sh                    starts a throwaway headless GNOME Shell (make e2e)
  e2e/harness/                  test-only extension that drives the real screenshot UI
  e2e/show-image.js             GTK window showing a fixture (for Window-mode test)
docs/research.md                how other extensions hook the UI; why this design
docs/screenshot.png             README image (crop of the e2e snapshot; refresh it after UI changes)
install.sh / uninstall.sh       user install, no sudo
.github/workflows/release.yml   tag v* → builds the zip, publishes a GitHub Release
.github/dependabot.yml          weekly npm (lint tooling) + GitHub Actions updates
Makefile                        make help
eslint.config.js, package.json  lint tooling only (node_modules/ is gitignored)
```

Flow: user clicks Scan → `ScanModePatch` marks Scan active → user presses
capture → the overridden `_onCaptureButtonClicked` calls
`captureSelectionPng()` → UI closes → `extension.js#_onCapture(bytes)` →
`findMissingPackages` → `writeTempPng` → `pipeline.scanImage` →
`St.Clipboard.set_text` + notification → temp file deleted.

## Private gnome-shell internals (what breaks on GNOME upgrades)

All of these are in `extension/lib/screenshotUiPatch.js`. The source of truth
is gnome-shell's `js/ui/screenshot.js`, class `ScreenshotUI`, reached at
runtime as `Main.screenshotUI`.

| Internal | How we use it | Where in our code |
|---|---|---|
| `_onCaptureButtonClicked()` | **Replaced on the instance** (not the prototype) by a pass-through wrapper; with Scan on it captures itself instead | `_installCaptureOverride()`, `_restoreCaptureOverride()` |
| `_saveScreenshot()` | Not called; its texture/geometry logic is **copied** | `captureSelectionPng()` |
| `_stageScreenshot.get_content().get_texture()`, `_getSelectedGeometry(true)`, `_scale` | Area/Screen capture | `captureSelectionPng()` |
| `_windowSelectors[].windows()`, window `.checked`, `.windowContent`, `.bufferScale` | Window capture | `captureSelectionPng()` |
| `_selectionButton`, `_screenButton`, `_windowButton` `.checked` | Which area type is chosen | `captureSelectionPng()` |
| `_shotCastContainer` | Our button is appended here | `enable()` |
| `_shotButton` (`clicked`, `notify::checked`, `:checked` pseudo-class), `_castButton` | Radio behaviour between Screenshot / Record / Scan | `_setScanActive()` |
| `_currentMode` with value `2` (= `UIMode.SCREENSHOT_ONLY`, not exported) | Hide Scan when a portal asks for a screenshot | `_syncVisibility()` |
| signal `closed`, `close()`, `visible` | Reset Scan; close after capture | `enable()`, `_captureForScan()` |
| exported `Tooltip` class | Native-looking tooltip | `enable()` |
| `Shell.Screenshot.composite_to_stream` as a **promise** | gnome-shell's screenshot.js calls `Gio._promisify` on it at import time; we import that module, so the promise form is available | `captureSelectionPng()` |
| CSS class `screenshot-ui-shot-cast-button` | Native button look | `enable()` |
| `_bottomRowContainer` (BinLayout), `_captureButton` | Optional: its layout manager is swapped for `CenterSafeBinLayout` so the 3-button pill does not run under the centred capture button; restored in `disable()`. Skipped with a warning if missing | `_installBottomRowLayout()` |

`REQUIRED_MEMBERS` in that file lists the members checked at `enable()`. If
one is missing, the extension does not patch anything. It logs and notifies
"Screenshot Scan does not support this GNOME version" with the missing names.

The e2e harness (`tests/e2e/harness/extension.js`) also uses private members to
simulate the user: `_areaSelector._startX/_startY/_lastX/_lastY` +
`_updateSelectionRect()`, `open(2)`.

## Porting to a new GNOME version (step by step)

1. Find the installed version: `gnome-shell --version`.
2. Get the matching source and diff the screenshot UI against the last
   supported version, e.g.
   ```
   git clone --depth 1 --branch 51.1 https://gitlab.gnome.org/GNOME/gnome-shell.git /tmp/gs
   git -C /tmp/gs fetch --depth 1 origin tag 50.6
   git -C /tmp/gs diff 50.6 51.1 -- js/ui/screenshot.js js/ui/messageTray.js js/extensions/extension.js
   ```
   (use a scratch dir, not the repo). Check every row of the table above:
   names, signatures, and especially the body of `_saveScreenshot()` versus
   our `captureSelectionPng()`.
3. Add the major version to `"shell-version"` in `extension/metadata.json`
   (and in `tests/e2e/harness/metadata.json`).
4. Fix `lib/screenshotUiPatch.js` (and the harness, if its private pokes
   moved). Update the table above and `docs/research.md` ("GNOME 50 vs 51"
   section; add one for the new version).
5. `make check`. `make e2e` runs the *installed* gnome-shell, so it tests
   exactly the version on this machine. Look at
   `tests/e2e/out/main/screenshot-ui-scan-mode.png` and `prefs.png` to check
   the button and prefs look right.
6. Ask the owner to run the manual desktop checklist (below), then commit.
7. Drop versions you can no longer test only if the code had to change in an
   incompatible way. Otherwise keep them.

## Install / test / debug commands

```
./install.sh            # checks deps (prints the sudo dnf line if missing), installs, enables
./uninstall.sh [--purge]
make help               # all targets
make test               # pipeline tests under gjs, ~1 s
make e2e                # real headless GNOME Shell, ~30 s; results + snapshots in tests/e2e/out/main/
make e2e-missing        # same, with zbarimg/tesseract hidden: checks the missing-software notices
make lint               # eslint with GNOME's config (npm, no sudo)
make check              # lint + test + e2e + e2e-missing
make pack               # build/screenshot-scan@awikman-bot.github.io.shell-extension.zip (EGO upload)
make fixtures           # regenerate test images (Python venv in .venv/)
gnome-extensions prefs screenshot-scan@awikman-bot.github.io   # open prefs (on a desktop)
```

System packages (Fedora): `sudo dnf install zbar tesseract tesseract-langpack-eng`
(+ `tesseract-langpack-<code>` per extra OCR language). Already installed on
the dev machine as of 2026-11-19.

Debugging:

- Logs from the real desktop Shell: `journalctl --user -f -o cat /usr/bin/gnome-shell`
  (our lines contain `screenshot-scan`).
- E2E log: `tests/e2e/out/<scenario>/shell.log` (`grep '^.*E2E '` for results).
- Nested/visual session on the owner's desktop (needs `mutter-devkit`, which is
  *not* installed; the headless e2e made it unnecessary):
  `dbus-run-session gnome-shell --devkit`.
- On Wayland a changed extension only reloads after **log out / log in**.
  `make e2e` is the fast loop; use the desktop only for final checks.
- Settings by hand: `gsettings --schemadir extension/schemas list-recursively org.gnome.shell.extensions.screenshot-scan`
  (after `make schemas`).

### Agent sandbox notes (the `ai` user on the dev box)

- The agent shell has no `$WAYLAND_DISPLAY`/`$XDG_RUNTIME_DIR` and is not the
  desktop user, so it cannot see or touch the owner's real session.
  `make e2e` sets up its own HOME/runtime dir under `tests/e2e/out/`.
- `install.sh` run by the agent installs into the *agent's* home, not the
  owner's. The owner installs on their desktop themselves.

## Releasing

1. Bump `"version-name"` in `extension/metadata.json` (semver, e.g. `0.2.0`)
   and commit after `make check`.
2. `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow checks the
   tag matches `version-name`, runs `make pack` in a Fedora container and
   attaches the zip to a GitHub Release. Users install it with
   `gnome-extensions install --force <zip>`, then log out and in.
3. extensions.gnome.org (EGO): the owner uploads the same zip by hand at
   https://extensions.gnome.org/upload/ under their own account (created
   2026-11-19). EGO has no token upload API, so this is not automated; do not
   store the owner's EGO password anywhere.

EGO review notes (rules: https://gjs.guide/extensions/review-guidelines/review-guidelines.html):

- Since Dec 2025 EGO rejects AI-generated extensions; this one is, and the
  owner knows. Expect rejection or questions; never hide the origin.
- Spawning tesseract/zbarimg is allowed only as "unavoidable": OCR and
  barcode decoding have no GJS-only option. Processes must exit cleanly:
  `runCommand` kills the child on cancel and after a 60 s timeout (both
  tested), and `disable()` cancels.
- Clipboard use must stay mentioned in the metadata description.
- `shell-version` must list only released versions (no future ones). 51 is
  listed but only source-reviewed; see "Version status".

## Manual desktop test checklist (for the owner)

1. `git clone git@github.com:awikman-bot/screenshot-scan.git && cd screenshot-scan && ./install.sh`
2. Log out and back in.
3. Open the Extensions app (or `gnome-extensions list --enabled`): Screenshot
   Scan is on.
4. Press **Print Screen**. A third button (frame with lines) appears after the
   camera and video buttons. Click it: it highlights, the camera doesn't.
5. **Text:** select an area of text (e.g. this file in a browser) → capture →
   notification "Copied N lines" → paste in a text editor.
6. **QR:** open a QR code on screen (e.g. search "QR code example") → Scan
   with **Selection** → the URL is pasted.
7. **Barcode:** an EAN/UPC/Code128 image → Scan → the number is pasted.
8. **Window** and **Screen** modes: Scan a whole window and a whole screen.
9. **No file:** `ls ~/Pictures/Screenshots` shows no new file after the
   scans. A normal screenshot (camera button) still saves one.
10. Disable and re-enable in the Extensions app (no logout needed); repeat
    step 4–5. Open the prefs (gear) and try "Codes only"/"Text only".

## Known limitations

- Private-API hook: any GNOME release can break it (see table). The extension
  then refuses to patch and shows a notification instead of misbehaving.
- Scan resets to Screenshot every time the UI closes (same as Record).
  There is no keyboard shortcut for Scan inside the UI.
- With `--raw`, a QR code whose payload contains newlines spans several
  lines, and the "Copied N lines" count counts those lines.
- OCR quality is tesseract's: small (< ~10 px) or stylised text, and text on
  photos, can come out wrong. There is no upscaling or preprocessing.
- Each extra OCR language makes OCR slower.
- A tool run (`zbarimg` or `tesseract`) is killed after 60 s
  (`COMMAND_TIMEOUT_MS` in `lib/pipeline.js`) and the scan fails with a
  notification. It is also killed when a new capture replaces the scan or
  the extension is disabled (screen lock).
- Hidden in portal / D-Bus "interactive screenshot" mode on purpose (the
  calling app expects a file).
- Only Fedora package names are given in messages (`dnf`).

## Version status

| GNOME Shell | Status |
|---|---|
| 50.6 (Fedora 44) | `make check` passes (24 pipeline tests, 17 e2e checks, 2 missing-tool checks), 2026-11-19. Desktop test by owner: **passed** 2026-11-19 (one fix: Scan button overlapped the capture button, now `CenterSafeBinLayout`) |
| 51.1 (Fedora 45) | Source diff reviewed (hooked code unchanged). **Run `make check` after upgrading.** |
