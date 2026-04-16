/**
 * Shared input helpers for CLI scripts (setup wizard, password reset, etc.).
 *
 * askSecret() handles raw-mode password entry with:
 *  - Byte-level processing (handles multi-byte data events like CRLF in one chunk)
 *  - ANSI escape sequence filtering (arrow keys, IME composition sequences)
 *  - Multi-byte UTF-8 support (bytes accumulated raw, decoded only at the end)
 *  - Unicode NFC normalization for consistent password comparison
 *
 * These are critical for Termux / Android, where software keyboards and IME
 * can send multi-character data events, escape sequences, and varying line
 * endings that break naive char.toString() single-event handling.
 */

import { theme, promptLabel } from "./ui";

/**
 * Prompt for secret input with masked echo (* per character).
 *
 * Processes stdin byte-by-byte so that multi-byte data events (CRLF as a
 * single chunk, pasted input, IME bursts) are handled correctly.  The final
 * string is NFC-normalized so that identical visual passwords always compare
 * equal regardless of how the terminal encodes combining characters.
 */
export function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${promptLabel(question)} `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    const inputBytes: number[] = [];
    let displayCount = 0;
    let escState: "normal" | "esc" | "csi" = "normal";

    function finish() {
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      process.stdout.write("\n");

      const password = Buffer.from(inputBytes)
        .toString("utf-8")
        .normalize("NFC");
      resolve(password);
    }

    function handleBackspace() {
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
    }

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
          process.stdout.write("\n");
          process.exit(1);
        }

        // ── Skip other control characters (Ctrl+A … Ctrl+Z, etc.) ─────
        if (byte < 0x20) continue;

        // ── Regular byte → accumulate ──────────────────────────────────
        inputBytes.push(byte);

        // Show * only for the leading byte of each UTF-8 code point.
        // Leading bytes are ASCII (< 0x80) or multi-byte starters (≥ 0xC0).
        // Continuation bytes (0x80–0xBF) are silent.
        if (byte < 0x80 || byte >= 0xc0) {
          displayCount++;
          process.stdout.write(`${theme.muted}*${theme.reset}`);
        }
      }
    };

    stdin.resume();
    stdin.on("data", onData);
  });
}
