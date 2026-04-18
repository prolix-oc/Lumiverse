/**
 * Shared input helpers for CLI scripts (setup wizard, password reset, etc.).
 *
 * Built on a single long-lived `readline.Interface` — the same pattern used
 * by inquirer / prompts / enquirer.  Keeping one readline for the whole
 * script means stdin ownership never changes hands, which sidesteps two
 * Bun-on-Windows bugs that broke earlier attempts at a raw-mode byte reader:
 *
 *   - oven-sh/bun#9853, #25663 — `setRawMode(true)` returns and `isRaw`
 *     reads `true`, but the underlying console mode never actually
 *     switches, so cooked-mode echo leaks the password before the data
 *     handler fires.
 *   - oven-sh/bun#8693 — `stdin.pause()` + `removeListener` doesn't
 *     release fd 0 on Windows, so the next prompt's `data` listener
 *     never fires (re-prompt after validation rejection hangs).
 *
 * Masking uses a per-interface `_writeToOutput` override rather than a
 * mute-stream wrapper.  Mute-stream replaces every write with the mask
 * character, which also wipes the prompt label on every line redraw
 * (readline reprints `\r\x1b[0J${prompt}${line}` on every keystroke — with
 * the prompt passed into `rl.question` so readline owns it, the override
 * re-renders the prompt verbatim and only masks the typed line).
 */

import readline from "node:readline";
import { theme, promptLabel, inputHint } from "./ui";

export interface AskTextOptions {
  defaultValue?: string;
  /** Return an error message to re-prompt, or null to accept the value. */
  validate?: (value: string) => string | null;
}

/**
 * Prompt for plain text input with visible echo.
 * Loops on validation failure so callers don't need to reconstruct the prompt.
 */
export async function askText(question: string, options: AskTextOptions = {}): Promise<string> {
  const { defaultValue, validate } = options;
  for (;;) {
    const raw = await prompt(question, { masked: false, defaultValue });
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
 * Prompt for secret input with masked echo (one `*` per typed character).
 * NFC-normalized so identical visual passwords always compare equal.
 */
export function askSecret(question: string): Promise<string> {
  return prompt(question, { masked: true });
}

/**
 * Close the cached readline interface so the script can exit.  Without this
 * call the readline keeps stdin readable and Node/Bun will keep the event
 * loop alive even after the wizard's `main()` resolves.
 */
export function closeInput(): void {
  if (cachedRl) {
    cachedRl.close();
    cachedRl = null;
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

let cachedRl: readline.Interface | null = null;

function getReadline(): readline.Interface {
  if (cachedRl) return cachedRl;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 0,
  });

  // Ctrl+C → exit cleanly.
  rl.on("SIGINT", () => {
    process.stdout.write("\n");
    rl.close();
    process.exit(1);
  });

  cachedRl = rl;
  return rl;
}

interface PromptOptions {
  masked: boolean;
  defaultValue?: string;
}

function prompt(question: string, opts: PromptOptions): Promise<string> {
  const rl = getReadline() as readline.Interface & {
    _writeToOutput?: (str: string) => void;
    line?: string;
  };
  const hint = !opts.masked && opts.defaultValue ? ` ${inputHint(`(${opts.defaultValue})`)}` : "";
  const fullPrompt = `${promptLabel(question)}${hint} `;

  return new Promise<string>((resolve) => {
    if (!opts.masked) {
      rl.question(fullPrompt, (answer) => {
        resolve(sanitizeAnswer(answer));
      });
      return;
    }

    // Masked mode.  Override _writeToOutput so that every redraw which
    // contains the prompt re-renders the prompt verbatim and masks only
    // the line content.  Non-redraw writes (pure escape sequences, cursor
    // moves, clears) pass through untouched.
    const original = rl._writeToOutput;
    rl._writeToOutput = (str: string) => {
      const idx = str.indexOf(fullPrompt);
      if (idx === -1) {
        process.stdout.write(str);
        return;
      }
      const before = str.slice(0, idx);
      const after = str.slice(idx + fullPrompt.length);
      // `after` is readline's view of the current line buffer.  Mask one
      // `*` per code point so emoji / CJK count as a single glyph's worth
      // of feedback rather than per-UTF-16 code unit.
      const maskCount = Array.from(after).length;
      process.stdout.write(before + fullPrompt + "*".repeat(maskCount));
    };

    rl.question(fullPrompt, (answer) => {
      rl._writeToOutput = original;
      resolve(sanitizeAnswer(answer));
    });
  });
}

/**
 * Normalize and strip line terminators that some terminal / tty stacks leak
 * into readline's question callback.  The previous byte-level reader couldn't
 * hit this because it terminated on CR/LF bytes before appending to its
 * buffer — moving to readline re-opened the hole.
 *
 * Symptom if omitted: on Bun-on-Windows (cooked mode leaking CR, see
 * oven-sh/bun#9853, #25663) the owner username is stored as `admin\r` and
 * the password hash is computed against `pw\r`.  Login then fails because
 * the user types the actual characters without the trailing CR, so
 * BetterAuth's lookup and hash compare both miss.
 */
function sanitizeAnswer(answer: string): string {
  return answer.replace(/[\r\n]+$/, "").normalize("NFC");
}
