/**
 * Terminal environment detection for cross-platform rendering.
 *
 * Different terminal emulators handle VT escape sequences and Ink's
 * rendering strategies differently. This module detects the environment
 * once at import time and exposes capability flags the runner uses to
 * adapt its rendering and VT sequence usage.
 *
 * Known problem terminals for Ink's incremental (cursor-repositioning) rendering:
 *   - tmux: cursor repositioning breaks; header duplicates
 *   - Windows Terminal: eraseLines() cursor math causes header/action bar duplication
 *   - Windows conhost (legacy console): unreliable VT cursor sequences
 *   - Termux: limited VT support depending on the Android terminal app
 */

export interface TerminalEnv {
  /** Running inside tmux multiplexer */
  isTmux: boolean;
  /** Running on Android Termux */
  isTermux: boolean;
  /** Running in Windows Terminal (modern) */
  isWindowsTerminal: boolean;
  /** Running in Windows conhost (legacy console host) */
  isConhost: boolean;
  /** Running over SSH */
  isSsh: boolean;
  /** Windows platform (any console) */
  isWindows: boolean;

  // ── Computed capabilities ──

  /**
   * Use Ink's full-redraw mode (clear + repaint every frame) instead of
   * incremental line-diffing. Achieved by setting the outer Box height
   * to exactly `stdout.rows`, which triggers Ink's fullscreen detection
   * and bypasses incremental rendering regardless of the render option.
   *
   * Needed for terminals where Ink's cursor-repositioning sequences
   * for incremental rendering cause visual corruption:
   *   - tmux: cursor positioning breaks, header duplicates
   *   - Windows (all): eraseLines() cursor math breaks on both Windows
   *     Terminal and conhost, causing header/action bar duplication
   *   - Termux: limited VT support in some Android terminal apps
   */
  useFullRedraw: boolean;

  /**
   * Whether \x1b[3J (erase saved lines / clear scrollback buffer) is
   * safe to emit. Conhost ignores or mishandles it, some Termux terminal
   * apps don't support it, and in tmux it's absorbed without effect.
   */
  supportsClearScrollback: boolean;
}

function detect(): TerminalEnv {
  const env = process.env;

  const isTmux = !!env["TMUX"];

  const isTermux = !!(
    env["TERMUX_VERSION"] ||
    env["LUMIVERSE_IS_TERMUX"] === "true" ||
    (env["PREFIX"] && env["PREFIX"].includes("/com.termux/"))
  );

  const isWindows = process.platform === "win32";
  const isWindowsTerminal = isWindows && !!env["WT_SESSION"];
  const isConhost = isWindows && !isWindowsTerminal;

  const isSsh = !!(
    env["SSH_TTY"] || env["SSH_CLIENT"] || env["SSH_CONNECTION"]
  );

  // Terminals that need full-redraw: can't handle incremental cursor repositioning.
  // Windows Terminal AND conhost both fail — Ink's eraseLines() cursor math causes
  // header/action bar duplication on every render frame. Use all-Windows, not just conhost.
  const useFullRedraw = isTmux || isWindows || isTermux;

  // \x1b[3J only works reliably on modern desktop terminal emulators
  const supportsClearScrollback = !isConhost && !isTermux && !isTmux;

  return {
    isTmux,
    isTermux,
    isWindowsTerminal,
    isConhost,
    isSsh,
    isWindows,
    useFullRedraw,
    supportsClearScrollback,
  };
}

/** Singleton — detected once at import time */
export const terminalEnv: TerminalEnv = detect();
