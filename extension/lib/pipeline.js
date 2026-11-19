// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Screenshot Scan contributors
//
// Image → text pipeline.
//
// This module must stay free of GNOME Shell imports (no `resource:///…`,
// no St/Clutter/Meta/Shell). It only uses Gio and GLib so that
// `tests/pipeline.test.js` can run it under plain `gjs -m` against the
// fixture images, without a running Shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Result modes, mirrored by the `result-mode` key in the GSettings schema. */
export const ResultMode = Object.freeze({
    AUTO: 'auto', // codes if any were found, otherwise OCR text
    CODES: 'codes', // only QR/barcode payloads
    TEXT: 'text', // only OCR text
    BOTH: 'both', // codes, a blank line, then OCR text
});

/** External programs and the Fedora packages that provide them. */
export const TOOLS = Object.freeze({
    zbarimg: 'zbar',
    tesseract: 'tesseract',
});

/** zbarimg exits with 4 when the image was fine but held no symbols. */
const ZBAR_EXIT_NOTHING_FOUND = 4;

/**
 * Fedora package name for a tesseract language code.
 *
 * @param {string} lang e.g. `fin`
 * @returns {string} e.g. `tesseract-langpack-fin`
 */
export function langpackFor(lang) {
    return `tesseract-langpack-${lang}`;
}

/**
 * Parses and validates a tesseract language string such as `eng+fin`.
 * Invalid entries are dropped; an empty result falls back to `eng`.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function parseLanguages(value) {
    const langs = String(value ?? '')
        .split(/[+,\s]+/)
        .map(l => l.trim())
        .filter(l => /^[A-Za-z0-9_]+$/.test(l));
    return langs.length > 0 ? [...new Set(langs)] : ['eng'];
}

/**
 * Every Unicode control character (category Cc: C0, DEL and C1) except tab
 * and newline. Written as "not (non-control, tab or newline)".
 */
const CONTROL_CHARS = /[^\P{Cc}\t\n]/gu;

/**
 * Removes control characters, keeping tab and newline.
 *
 * What is on screen is untrusted: a QR code can carry any bytes, and the
 * result is pasted wherever the user likes. An ESC or a bracketed-paste end
 * marker pasted into a terminal can run commands, so nothing but printable
 * text, tabs and newlines reaches the clipboard or the notification.
 * Call this after line endings are normalised (a lone CR is removed here).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripControlChars(text) {
    return String(text ?? '').replace(CONTROL_CHARS, '');
}

/**
 * Cleans raw tesseract output: drops form feeds, control characters,
 * trailing spaces and leading/trailing blank lines, and collapses 2+ blank
 * lines into one.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanOcrText(raw) {
    return stripControlChars(String(raw ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\f/g, '\n'))
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Splits `zbarimg --raw` output into one payload per line, with control
 * characters removed (see stripControlChars).
 *
 * Note: with `--raw`, a payload that itself contains newlines (e.g. a
 * multi-line QR code) is printed across several lines. That is fine for the
 * clipboard, which gets the same text either way.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseZbarOutput(raw) {
    return stripControlChars(String(raw ?? '')
        .replace(/\r\n?/g, '\n'))
        .split('\n')
        .map(line => line.replace(/\s+$/, ''))
        .filter(line => line.length > 0);
}

/**
 * Combines code payloads and OCR text according to the result mode.
 *
 * @param {string[]} codes
 * @param {string} text cleaned OCR text
 * @param {string} mode one of ResultMode
 * @returns {string} what goes to the clipboard ('' means nothing found)
 */
export function formatResult(codes, text, mode) {
    const codeText = codes.join('\n');
    switch (mode) {
    case ResultMode.CODES:
        return codeText;
    case ResultMode.TEXT:
        return text;
    case ResultMode.BOTH:
        return [codeText, text].filter(s => s.length > 0).join('\n\n');
    case ResultMode.AUTO:
    default:
        return codes.length > 0 ? codeText : text;
    }
}

/**
 * Counts lines in a result for the "Copied N lines" notification.
 *
 * @param {string} result
 * @returns {number}
 */
export function countLines(result) {
    if (!result)
        return 0;
    return result.split('\n').filter(l => l.trim().length > 0).length;
}

/**
 * Longest a single tool run may take. A full 4K screen takes tesseract a few
 * seconds; anything near a minute is stuck or was fed something hostile.
 */
export const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Runs a program and collects its output without blocking the main loop.
 *
 * The process is killed (SIGKILL) when `cancellable` is cancelled or the
 * timeout passes, so a replaced, abandoned or stuck scan does not keep
 * running in the background with a screenshot in memory.
 *
 * @param {string[]} argv
 * @param {Gio.Cancellable|null} cancellable
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 0 means no timeout
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 *   rejects with Gio.IOErrorEnum.CANCELLED or .TIMED_OUT
 */
export function runCommand(argv, cancellable = null, {timeoutMs = COMMAND_TIMEOUT_MS} = {}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    // Tesseract's OpenMP threads busy-spin and are slower than a single
    // thread for screenshot-sized images; one thread also keeps the Shell
    // responsive.
    launcher.setenv('OMP_THREAD_LIMIT', '1', true);
    // Force C locale so tool messages are predictable; text output is UTF-8.
    launcher.setenv('LC_ALL', 'C.UTF-8', true);

    const proc = launcher.spawnv(argv);

    // Cancelling only stops the wait; also stop the process itself so that
    // disable() or a newer scan never leaves a tesseract run behind. If
    // already cancelled, the handler runs right here.
    const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;

    let timedOut = false;
    let timeoutId = 0;
    if (timeoutMs > 0) {
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timeoutId = 0;
            timedOut = true;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
    }

    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            // Runs from the main loop, never from inside the cancel handler,
            // so disconnecting here cannot deadlock.
            if (cancelId)
                cancellable.disconnect(cancelId);
            if (timeoutId)
                GLib.source_remove(timeoutId);
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (timedOut) {
                    throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT,
                        `${argv[0]} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`);
                }
                resolve({
                    status: p.get_if_exited() ? p.get_exit_status() : -1,
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Lists programs from TOOLS that are not on $PATH.
 *
 * @returns {{program: string, package: string}[]}
 */
export function findMissingTools() {
    return Object.entries(TOOLS)
        .filter(([program]) => GLib.find_program_in_path(program) === null)
        .map(([program, pkg]) => ({program, package: pkg}));
}

/**
 * Lists the tesseract languages that are installed.
 *
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<string[]>} empty if tesseract is missing
 */
export async function listInstalledLanguages(cancellable = null) {
    if (GLib.find_program_in_path('tesseract') === null)
        return [];
    const {stdout} = await runCommand(['tesseract', '--list-langs'], cancellable);
    // First line is 'List of available languages in "…" (N):'
    return stdout.split('\n').slice(1).map(l => l.trim()).filter(l => l.length > 0);
}

/**
 * Checks what the given result mode needs and returns the Fedora packages
 * that are missing, e.g. `['zbar', 'tesseract-langpack-fin']`.
 *
 * @param {string[]} languages
 * @param {Gio.Cancellable|null} cancellable
 * @param {string} mode one of ResultMode; `codes` skips tesseract checks,
 *   `text` skips zbar
 * @returns {Promise<string[]>}
 */
export async function findMissingPackages(languages, cancellable = null, mode = ResultMode.AUTO) {
    const needsZbar = mode !== ResultMode.TEXT;
    const needsTesseract = mode !== ResultMode.CODES;
    const missing = findMissingTools()
        .filter(t => t.program === 'zbarimg' ? needsZbar : needsTesseract)
        .map(t => t.package);
    if (needsTesseract && !missing.includes('tesseract')) {
        const installed = await listInstalledLanguages(cancellable);
        for (const lang of languages) {
            if (!installed.includes(lang))
                missing.push(langpackFor(lang));
        }
    }
    return missing;
}

/**
 * Decodes QR codes and 1D barcodes with zbarimg.
 *
 * @param {string} path PNG file
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<string[]>} payloads, in the order zbar reports them
 */
export async function decodeCodes(path, cancellable = null) {
    const {status, stdout, stderr} = await runCommand(
        ['zbarimg', '--raw', '-q', path], cancellable);
    if (status === ZBAR_EXIT_NOTHING_FOUND)
        return [];
    if (status !== 0)
        throw new Error(`zbarimg failed (exit ${status}): ${stderr.trim()}`);
    return parseZbarOutput(stdout);
}

/**
 * Reads text with tesseract.
 *
 * @param {string} path PNG file
 * @param {string[]} languages tesseract language codes
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<string>} cleaned text ('' if none)
 */
export async function recognizeText(path, languages, cancellable = null) {
    const {status, stdout, stderr} = await runCommand(
        ['tesseract', path, '-', '-l', languages.join('+')], cancellable);
    if (status !== 0)
        throw new Error(`tesseract failed (exit ${status}): ${stderr.trim()}`);
    return cleanOcrText(stdout);
}

/**
 * Full pipeline: image file → clipboard text.
 *
 * Only the tools the result mode needs are run. In `auto` mode zbar runs
 * first (it takes milliseconds) and tesseract only when no code was found.
 *
 * @param {string} path PNG file
 * @param {object} [options]
 * @param {string} [options.mode] one of ResultMode
 * @param {string[]} [options.languages] tesseract languages
 * @param {Gio.Cancellable|null} [options.cancellable]
 * @returns {Promise<{codes: string[], text: string, result: string}>}
 */
export async function scanImage(path, options = {}) {
    const mode = options.mode ?? ResultMode.AUTO;
    const languages = options.languages ?? ['eng'];
    const cancellable = options.cancellable ?? null;

    let codes = [];
    let text = '';

    switch (mode) {
    case ResultMode.CODES:
        codes = await decodeCodes(path, cancellable);
        break;
    case ResultMode.TEXT:
        text = await recognizeText(path, languages, cancellable);
        break;
    case ResultMode.BOTH:
        [codes, text] = await Promise.all([
            decodeCodes(path, cancellable),
            recognizeText(path, languages, cancellable),
        ]);
        break;
    case ResultMode.AUTO:
    default:
        codes = await decodeCodes(path, cancellable);
        if (codes.length === 0)
            text = await recognizeText(path, languages, cancellable);
    }

    return {codes, text, result: formatResult(codes, text, mode)};
}
