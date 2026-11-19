// SPDX-License-Identifier: GPL-2.0-or-later
//
// All access to private GNOME Shell code is kept in this file, so it is the
// part to check when GNOME Shell is upgraded.
//
// GNOME's screenshot UI (Print Screen) is `Main.screenshotUI`, an instance of
// `ScreenshotUI` from resource:///org/gnome/shell/ui/screenshot.js. It has no
// extension API, so this module:
//
//   1. adds a "Scan" toggle button to `_shotCastContainer`, next to the
//      native "Take Screenshot" (camera) and "Record Screen" buttons, and
//      keeps the three behaving like one radio group;
//   2. replaces `_onCaptureButtonClicked` on the *instance* (never on the
//      prototype). While Scan is on, it captures the selection itself and
//      hands PNG bytes to a callback instead of letting GNOME save a file,
//      put an image on the clipboard and play the shutter sound.
//      While Scan is off, it calls the original method unchanged.
//
// disable() removes the button and tooltip, disconnects every signal and
// restores `_onCaptureButtonClicked`, leaving the UI exactly as it was.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';

/**
 * Private ScreenshotUI members this module relies on. Checked up front so an
 * incompatible GNOME version fails loudly with a list instead of misbehaving.
 */
export const REQUIRED_MEMBERS = [
    '_shotCastContainer', // St.BoxLayout holding the camera/video buttons
    '_shotButton', // "Take Screenshot" toggle
    '_castButton', // "Record Screen" toggle (inverse-bound to _shotButton)
    '_selectionButton', // Selection / Screen / Window type toggles
    '_screenButton',
    '_windowButton',
    '_stageScreenshot', // St.Widget whose content is the frozen screen
    '_windowSelectors', // per-monitor window pickers (have .windows())
    '_getSelectedGeometry', // (rescale) → [x, y, w, h] in buffer pixels
    '_onCaptureButtonClicked', // called by the capture button and Enter/Space
    'close',
];

/** `UIMode.SCREENSHOT_ONLY` in screenshot.js (not exported): used by the
 * D-Bus InteractiveScreenshot call, whose caller expects a file back. */
const UI_MODE_SCREENSHOT_ONLY = 2;

const CAPTURE_METHOD = '_onCaptureButtonClicked';

/**
 * Lists required private members that `ui` lacks.
 *
 * @param {object} ui Main.screenshotUI
 * @returns {string[]}
 */
export function findMissingMembers(ui) {
    if (!ui)
        return ['Main.screenshotUI'];
    return REQUIRED_MEMBERS.filter(name => ui[name] === undefined);
}

/**
 * Renders the current selection (area, screen or window) to PNG bytes,
 * without the pointer, without sound, without saving or touching the
 * clipboard.
 *
 * Adapted from `ScreenshotUI._saveScreenshot()` in gnome-shell 50.6
 * js/ui/screenshot.js (GPL-2.0-or-later, © the GNOME Shell authors);
 * identical in 51.1. See CREDITS.md. The only change is that it stops at
 * the PNG bytes instead of calling `captureScreenshot()`, which would store
 * the file in ~/Pictures/Screenshots and copy the image to the clipboard.
 *
 * @param {object} ui Main.screenshotUI
 * @returns {Promise<import('gi://GLib').Bytes|null>} null if nothing to capture
 */
export async function captureSelectionPng(ui) {
    let texture, geometry, scale;

    if (ui._selectionButton.checked || ui._screenButton.checked) {
        const content = ui._stageScreenshot.get_content();
        if (!content)
            return null; // the frozen screenshot failed for some reason
        texture = content.get_texture();
        geometry = ui._getSelectedGeometry(true);
        scale = ui._scale;
    } else if (ui._windowButton.checked) {
        const window = ui._windowSelectors
            .flatMap(selector => selector.windows())
            .find(win => win.checked);
        if (!window)
            return null;
        const content = window.windowContent;
        if (!content)
            return null;
        texture = content.get_texture();
        geometry = null;
        scale = window.bufferScale;
    } else {
        return null;
    }

    const [x, y, w, h] = geometry ?? [0, 0, -1, -1];
    const stream = Gio.MemoryOutputStream.new_resizable();
    // Cursor deliberately omitted: a pointer only adds OCR noise.
    await Shell.Screenshot.composite_to_stream(
        texture, x, y, w, h, scale,
        null, 0, 0, 1,
        stream);
    stream.close(null);
    return stream.steal_as_bytes();
}

/** Gap (logical px) kept between the shot/cast pill and the capture button. */
const CAPTURE_BUTTON_GAP = 6;

/**
 * GNOME lays out the bottom row (shot/cast pill · capture button · pointer
 * toggle) with a plain BinLayout: all three overlap, the capture button is
 * centred and the panel width comes from the Selection/Screen/Window row. A
 * third pill button makes the pill wider than half the panel, so it ran under
 * the capture button. This layout asks for enough width that each side of the
 * centred child fits, which widens the panel only as much as needed.
 */
const CenterSafeBinLayout = GObject.registerClass(
class CenterSafeBinLayout extends Clutter.BinLayout {
    _init(center) {
        super._init();
        this._center = center;
    }

    vfunc_get_preferred_width(container, forHeight) {
        const [min, nat] = super.vfunc_get_preferred_width(container, forHeight);
        let side = 0;
        let center = 0;
        for (const child of container) {
            if (!child.visible)
                continue;
            const [, childNat] = child.get_preferred_width(forHeight);
            if (child === this._center)
                center = childNat;
            else
                side = Math.max(side, childNat);
        }
        const scale = container.get_stage()
            ? St.ThemeContext.get_for_stage(container.get_stage()).scale_factor
            : 1;
        const needed = center + 2 * (side + CAPTURE_BUTTON_GAP * scale);
        return [Math.max(min, needed), Math.max(nat, needed)];
    }
});

export class ScanModePatch {
    /**
     * @param {object} ui Main.screenshotUI
     * @param {object} params
     * @param {Gio.Icon} params.gicon icon for the Scan button
     * @param {string} params.label tooltip / accessible name
     * @param {(bytes: import('gi://GLib').Bytes|null) => void} params.onCapture
     *   called after the UI closes; null means nothing could be captured
     */
    constructor(ui, {gicon, label, onCapture}) {
        this._ui = ui;
        this._gicon = gicon;
        this._label = label;
        this._onCapture = onCapture;
        this._button = null;
        this._tooltip = null;
        this._syncing = false;
        this._enabled = false;
        this._origBottomLayout = null;
    }

    /** True while the Scan button is the selected capture mode. */
    get scanActive() {
        return this._button?.checked ?? false;
    }

    /** The Scan button, for tests. */
    get button() {
        return this._button;
    }

    /**
     * @throws {Error} listing missing private members if GNOME changed
     */
    enable() {
        const ui = this._ui;
        const missing = findMissingMembers(ui);
        if (missing.length > 0)
            throw new Error(`ScreenshotUI is missing ${missing.join(', ')}`);

        this._button = new St.Button({
            style_class: 'screenshot-ui-shot-cast-button',
            child: new St.Icon({gicon: this._gicon}),
            toggle_mode: true,
            can_focus: true,
            accessible_name: this._label,
        });
        ui._shotCastContainer.add_child(this._button);
        this._installBottomRowLayout();

        // Same tooltip widget the native buttons use (exported, but its
        // signature is internal; skip the tooltip if it ever changes).
        try {
            this._tooltip = new Screenshot.Tooltip(this._button, {
                text: this._label,
                style_class: 'screenshot-ui-tooltip',
                visible: false,
            });
            ui.add_child(this._tooltip);
        } catch (e) {
            console.warn(`screenshot-scan: no tooltip: ${e.message}`);
            this._tooltip = null;
        }

        this._button.connectObject('notify::checked', () => {
            if (!this._syncing)
                this._setScanActive(this._button.checked);
        }, this);

        // Camera button: when it is already checked GNOME makes it
        // non-toggleable, so clicking it only emits 'clicked'.
        ui._shotButton.connectObject(
            'clicked', () => this._setScanActive(false),
            'notify::checked', () => {
                if (!ui._shotButton.checked)
                    this._setScanActive(false); // switched to recording
            }, this);

        ui.connectObject(
            'closed', () => this._setScanActive(false),
            'notify::visible', () => this._syncVisibility(), this);

        this._installCaptureOverride();
        this._enabled = true;
        this._syncVisibility();
    }

    disable() {
        this._enabled = false;
        const ui = this._ui;

        if (this._button && this.scanActive)
            this._setScanActive(false); // restores the camera highlight

        this._restoreCaptureOverride();

        ui?.disconnectObject(this);
        ui?._shotButton?.disconnectObject(this);

        this._tooltip?.destroy();
        this._tooltip = null;
        this._button?.destroy();
        this._button = null;
        this._restoreBottomRowLayout();
    }

    /**
     * Cosmetic: stop the wider pill overlapping the capture button. Optional,
     * so a GNOME version without these members still gets a working Scan.
     */
    _installBottomRowLayout() {
        const row = this._ui._bottomRowContainer;
        const center = this._ui._captureButton;
        if (!(row?.layout_manager instanceof Clutter.BinLayout) || !center) {
            console.warn('screenshot-scan: bottom row layout not found; the Scan button may overlap the capture button');
            return;
        }
        this._origBottomLayout = row.layout_manager;
        row.layout_manager = new CenterSafeBinLayout(center);
    }

    _restoreBottomRowLayout() {
        if (!this._origBottomLayout)
            return;
        const row = this._ui?._bottomRowContainer;
        if (row)
            row.layout_manager = this._origBottomLayout;
        this._origBottomLayout = null;
    }

    _syncVisibility() {
        if (!this._button || !this._ui.visible)
            return;
        // A portal / D-Bus caller asked for a screenshot file; don't offer Scan.
        const allowed = this._ui._currentMode !== UI_MODE_SCREENSHOT_ONLY;
        this._button.visible = allowed;
        if (!allowed)
            this._setScanActive(false);
    }

    /**
     * Makes Scan / Screenshot / Record act as one radio group. Scan is a
     * flavour of screenshot mode: `_shotButton` stays checked underneath (so
     * GNOME keeps the frozen screen and window picking) and only its
     * highlight is hidden.
     *
     * @param {boolean} active
     */
    _setScanActive(active) {
        const ui = this._ui;
        if (!this._button || this._syncing)
            return;
        this._syncing = true;
        try {
            this._button.checked = active;
            // Like the native buttons: the selected one can't be un-toggled.
            this._button.toggle_mode = !active;
            if (active) {
                if (!ui._shotButton.checked)
                    ui._shotButton.checked = true; // leaves recording mode
                ui._shotButton.remove_style_pseudo_class('checked');
            } else if (ui._shotButton.checked) {
                ui._shotButton.add_style_pseudo_class('checked');
            }
        } finally {
            this._syncing = false;
        }
    }

    _installCaptureOverride() {
        const ui = this._ui;
        const patch = this;
        this._hadOwnCapture = Object.hasOwn(ui, CAPTURE_METHOD);
        this._originalCapture = ui[CAPTURE_METHOD];
        const original = this._originalCapture;

        // Not async: both branches already return a promise.
        this._captureWrapper = function (...args) {
            if (patch._enabled && patch.scanActive && this._shotButton.checked)
                return patch._captureForScan();
            return original.apply(this, args);
        };
        ui[CAPTURE_METHOD] = this._captureWrapper;
    }

    _restoreCaptureOverride() {
        const ui = this._ui;
        if (!this._captureWrapper)
            return;
        if (ui[CAPTURE_METHOD] === this._captureWrapper) {
            if (this._hadOwnCapture)
                ui[CAPTURE_METHOD] = this._originalCapture;
            else
                delete ui[CAPTURE_METHOD]; // back to the prototype method
        } else {
            // Another extension wrapped ours. Leave the chain intact; our
            // wrapper is a pure pass-through now that _enabled is false.
            console.warn('screenshot-scan: _onCaptureButtonClicked was re-wrapped by someone else; leaving a pass-through in place');
        }
        this._captureWrapper = null;
        this._originalCapture = null;
    }

    async _captureForScan() {
        let bytes = null;
        try {
            bytes = await captureSelectionPng(this._ui);
        } catch (e) {
            console.error(`screenshot-scan: capture failed: ${e.message}`);
        }
        this._ui.close();
        this._onCapture(bytes);
    }
}
