/**
 * Shared input helpers for CLI scripts (setup wizard, password reset, etc.).
 *
 * Both askText() and askSecret() use the same byte-level raw-mode reader so
 * that a single consumer owns stdin.  Mixing Node's readline with a raw-mode
 * handler causes cross-platform breakage (double-echoed characters on Windows
 * ConPTY / Termux) and occasionally loses bytes when readline's internal line
 * editor steals the CR before the raw listener sees it.
 *
 * Features:
 *  - Byte-level processing (handles multi-byte data events like CRLF in one chunk)
 *  - ANSI escape sequence filtering (arrow keys, IME composition sequences)
 *  - Multi-byte UTF-8 support (bytes accumulated raw, decoded only at the end)
 *  - Unicode NFC normalization for consistent string comparison
 *  - Raw-mode engagement check with graceful fallback for environments where
 *    stdin.setRawMode() silently no-ops (some Windows wrappers, non-TTY pipes)
 *
 * These are critical for Termux / Android, where software keyboards and IME
 * can send multi-character data events, escape sequences, and varying line
 * endings that break naive char.toString() single-event handling.
 */

import { theme, promptLabel, inputHint } from "./ui";

export interface AskTextOptions {
  defaultValue?: string;
  /** Return an error message to re-prompt, or null to accept the value. */
  validate?: (value: string) => string | null;
}

/**
 * Prompt for plain text input with visible echo.
 *
 * Loops on validation failure so callers don't need to reconstruct the prompt.
 */
export async function askText(question: string, options: AskTextOptions = {}): Promise<string> {
  const { defaultValue, validate } = options;

  for (;;) {
    const raw = await readLine({ masked: false, question, defaultValue });
    const value = raw.trim() || defaultValue || "";
    if (validate) {
      const error = validate(value);
      if (error) {
        console.log(`    ${theme.warning}${error}${theme.reset}`);
        continue;
      }
    }
    return value;
  }
}

/**
 * Prompt for secret input with masked echo (* per character).
 *
 * Processes stdin byte-by-byte so that multi-byte data events (CRLF as a
 * single chunk, pasted input, IME bursts) are handled correctly.  The final
 * string is NFC-normalized so that identical visual passwords always compare
 * equal regardless of how the terminal encodes combining characters.
 */
export function askSecret(question: string): Promise<string> {
  return readLine({ masked: true, question });
}

// ─── Internal: unified raw-mode line reader ─────────────────────────────────

interface ReadLineOptions {
  masked: boolean;
  question: string;
  defaultValue?: string;
}

function readLine(opts: ReadLineOptions): Promise<string> {
  const { masked, question, defaultValue } = opts;
  const hint = !masked && defaultValue ? ` ${inputHint(`(${defaultValue})`)}` : "";
  process.stdout.write(`${promptLabel(question)}${hint} `);

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;

  // Attempt to engage raw mode.  On some Windows wrappers and non-TTY pipes
  // this is a silent no-op — we detect that by re-reading stdin.isRaw and
  // fall back to a line-buffered read path.
  let rawEngaged = false;
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true);
      rawEngaged = stdin.isRaw === true;
    } catch {
      rawEngaged = false;
    }
  }

  if (!rawEngaged) {
    return readLineFallback({ masked, wasRaw });
  }

  return readLineRaw({ masked, wasRaw });
}

/**
 * Raw-mode byte-by-byte read.  Responsible for echo (visible or masked),
 * backspace, CR/LF handling, Ctrl+C abort, and ANSI escape filtering.
 */
function readLineRaw(opts: { masked: boolean; wasRaw: boolean }): Promise<string> {
  const { masked, wasRaw } = opts;
  const stdin = process.stdin;

  return new Promise((resolve) => {
    const inputBytes: number[] = [];
    let displayCount = 0;
    let escState: "normal" | "esc" | "csi" = "normal";

    const finish = () => {
      if (stdin.isTTY) {
        try { stdin.setRawMode(wasRaw); } catch {}
      }
      stdin.removeListener("data", onData);
      stdin.pause();
      process.stdout.write("\n");

      const value = Buffer.from(inputBytes)
        .toString("utf-8")
        .normalize("NFC");
      resolve(value);
    };

    const handleBackspace = () => {
      if (inputBytes.length === 0) return;

      // Decode → remove last visual character → re-encode.
      // Array.from() splits correctly on surrogate pairs (emoji, etc.).
      const chars = Array.from(Buffer.from(inputBytes).toString("utf-8"));
      chars.pop();
      const shortened = chars.join("");

      inputBytes.length = 0;
      if (shortened.length > 0) {
        const buf = Buffer.from(shortened, "utf-8");
        for (let j = 0; j < buf.length; j++) inputBytes.push(buf[j]);
      }

      if (displayCount > 0) {
        displayCount--;
        process.stdout.write("\b \b");
      }
    };

    const onData = (data: Buffer) => {
      for (let i = 0; i < data.length; i++) {
        const byte = data[i];

        // ── ANSI escape sequence tracking ──────────────────────────────
        // ESC starts a sequence; ESC [ starts a CSI sequence whose
        // parameter bytes (0x20-0x3F) are skipped until a final byte
        // (0x40-0x7E) terminates it.  Non-CSI escapes (ESC + char) are
        // consumed as two bytes.  This prevents arrow keys, function
        // keys, and other terminal sequences from leaking into input.
        if (escState === "esc") {
          escState = byte === 0x5b ? "csi" : "normal";
          continue;
        }
        if (escState === "csi") {
          if (byte >= 0x40 && byte <= 0x7e) escState = "normal";
          continue;
        }
        if (byte === 0x1b) {
          escState = "esc";
          continue;
        }

        // ── CR (0x0D) or LF (0x0A) → finish ───────────────────────────
        // Handles Enter regardless of whether the terminal sends CR, LF,
        // or CRLF, and whether they arrive in one chunk or two.
        if (byte === 0x0d || byte === 0x0a) {
          finish();
          return;
        }

        // ── Backspace (DEL 0x7F) or BS (0x08) ─────────────────────────
        if (byte === 0x7f || byte === 0x08) {
          handleBackspace();
          continue;
        }

        // ── Ctrl+C → abort ─────────────────────────────────────────────
        if (byte === 0x03) {
          if (stdin.isTTY) {
            try { stdin.setRawMode(wasRaw); } catch {}
          }
          process.stdout.write("\n");
          process.exit(1);
        }

        // ── Skip other control characters (Ctrl+A … Ctrl+Z, etc.) ─────
        if (byte < 0x20) continue;

        // ── Regular byte → accumulate ──────────────────────────────────
        inputBytes.push(byte);

        // Echo.  Leading bytes of each UTF-8 code point are ASCII (< 0x80)
        // or multi-byte starters (≥ 0xC0); continuation bytes are 0x80-0xBF.
        if (masked) {
          // One * per visual character (suppress on continuation bytes).
          if (byte < 0x80 || byte >= 0xc0) {
            displayCount++;
            process.stdout.write(`${theme.muted}*${theme.reset}`);
          }
        } else {
          // Visible echo: write every byte as-is.  Terminals assemble the
          // UTF-8 glyph themselves, so this correctly renders multi-byte
          // characters in real time.
          process.stdout.write(Buffer.from([byte]));
          if (byte < 0x80 || byte >= 0xc0) displayCount++;
        }
      }
    };

    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Fallback line-buffered read for environments where raw mode cannot be
 * engaged.  When masked, wraps the read in ANSI conceal codes so the typed
 * text isn't visible on VT-compatible terminals (Windows Terminal, Termux,
 * most modern emulators).  Older conhost without VT enabled will still show
 * the text — there's no universal way to hide it without raw mode.
 */
function readLineFallback(opts: { masked: boolean; wasRaw: boolean }): Promise<string> {
  const { masked, wasRaw } = opts;
  const stdin = process.stdin;

  return new Promise((resolve) => {
    if (masked) process.stdout.write("\x1b[8m"); // conceal

    const chunks: Buffer[] = [];

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.pause();
      if (masked) process.stdout.write("\x1b[28m"); // reveal
      if (stdin.isTTY) {
        try { stdin.setRawMode(wasRaw); } catch {}
      }
    };

    const deliver = () => {
      const joined = Buffer.concat(chunks).toString("utf-8").normalize("NFC");
      // Strip trailing CR/LF (handles CR, LF, and CRLF from any platform).
      const value = joined.replace(/\r?\n?$/, "");
      cleanup();
      if (masked) process.stdout.write("\n");
      resolve(value);
    };

    const onData = (data: Buffer) => {
      chunks.push(data);
      // Resolve as soon as we see a line terminator — terminals in cooked
      // mode deliver the whole line on Enter, so this is effectively atomic.
      const joined = Buffer.concat(chunks).toString("utf-8");
      if (joined.includes("\n") || joined.includes("\r")) {
        deliver();
      }
    };

    const onEnd = () => deliver();

    stdin.resume();
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}
