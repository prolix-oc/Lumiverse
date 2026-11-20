/**
 * Terminal UI utilities for the Lumiverse setup wizard.
 *
 * Uses ANSI 256-color for gradient effects and Unicode box-drawing for structure.
 * Degrades gracefully on terminals without color support (NO_COLOR / TERM=dumb).
 */

// ─── Color support detection ────────────────────────────────────────────────

const supportsColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY !== false;

// ANSI helpers
const esc = (code: string) => (supportsColor ? `\x1b[${code}m` : "");
const fg256 = (n: number) => esc(`38;5;${n}`);
const bold = esc("1");
const dim = esc("2");
const reset = esc("0");

// Lumiverse gradient palette (purple → blue → cyan)
const GRADIENT = [
  141, // light purple
  135, // purple
  99,  // blue-purple
  63,  // blue
  69,  // light blue
  75,  // cyan-blue
  81,  // cyan
  117, // light cyan
  159, // pale cyan
  195, // near-white cyan
];

function gradient(text: string, palette: number[] = GRADIENT): string {
  if (!supportsColor) return text;
  let out = "";
  let ci = 0;
  for (const ch of text) {
    if (ch === " " || ch === "\n") {
      out += ch;
    } else {
      out += fg256(palette[ci % palette.length]) + ch;
      ci++;
    }
  }
  return out + reset;
}

function gradientLine(line: string, palette: number[] = GRADIENT, offset = 0): string {
  if (!line) return ""; 
  if (!supportsColor) return line;
  let out = "";
  let ci = offset;
  for (const ch of line) {
    if (ch === " ") {
      out += ch;
    } else {
      out += fg256(palette[ci % palette.length]) + ch;
      ci++;
    }
  }
  return out + reset;
}

// ─── Theme colors ───────────────────────────────────────────────────────────

export const theme = {
  primary:   fg256(141),  // purple
  secondary: fg256(75),   // cyan-blue
  accent:    fg256(219),  // pink
  success:   fg256(114),  // green
  warning:   fg256(221),  // yellow
  error:     fg256(204),  // red
  muted:     fg256(245),  // gray
  bold,
  dim,
  reset,
};

// ─── ASCII Art Banner ───────────────────────────────────────────────────────

const LOGO_LINES = [
  "  ██╗     ██╗   ██╗███╗   ███╗██╗██╗   ██╗███████╗██████╗ ███████╗███████╗",
  "  ██║     ██║   ██║████╗ ████║██║██║   ██║██╔════╝██╔══██╗██╔════╝██╔════╝",
  "  ██║     ██║   ██║██╔████╔██║██║██║   ██║█████╗  ██████╔╝███████╗█████╗  ",
  "  ██║     ██║   ██║██║╚██╔╝██║██║╚██╗ ██╔╝██╔══╝  ██╔══██╗╚════██║██╔══╝  ",
  "  ███████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚████╔╝ ███████╗██║  ██║███████║███████╗",
  "  ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝",
];

// Compact fallback for narrow terminals (< 78 cols)
const LOGO_COMPACT = [
  "  ╦  ╦ ╦╔╦╗╦╦  ╦╔═╗╦═╗╔═╗╔═╗",
  "  ║  ║ ║║║║║╚╗╔╝║╣ ╠╦╝╚═╗║╣ ",
  "  ╩═╝╚═╝╩ ╩╩ ╚╝ ╚═╝╩╚═╚═╝╚═╝",
];

const STARS_WIDE = [
  "        .            *           .        *       .    ",
  "   *         .              .         .                ",
  "                                                       ",
  "  .        *          .              *          .      ",
  "        .        .           *           .        *    ",
];

const STARS_COMPACT = [
  "     .        *       .    ",
  "  *       .        .       ",
  "                           ",
  "     .     *       .    *  ",
];

export function printBanner(subtitle?: string): void {
  const cols = process.stdout.columns || 80;
  const wide = cols >= 78;
  const logo = wide ? LOGO_LINES : LOGO_COMPACT;
  const stars = wide ? STARS_WIDE : STARS_COMPACT;

  console.log("");

  // Stars above
  console.log(gradientLine(stars[0], GRADIENT, 0));
  console.log(gradientLine(stars[1], GRADIENT, 3));

  // Logo with gradient
  logo.forEach((line, i) => {
    console.log(gradientLine(line, GRADIENT, i * 2));
  });

  // Stars below
  console.log(gradientLine(stars[3], GRADIENT, 5));
  console.log(gradientLine(stars[4], GRADIENT, 2));

  if (subtitle) {
    const pad = wide ? "    " : "  ";
    console.log("");
    console.log(`${pad}${theme.muted}${subtitle}${theme.reset}`);
  }

  console.log("");
}

// ─── Step Header ────────────────────────────────────────────────────────────

export function printStepHeader(step: number, total: number, title: string, subtitle?: string): void {
  const barWidth = 30;
  const filled = Math.round((step / total) * barWidth);
  const empty = barWidth - filled;

  const bar =
    theme.secondary + "━".repeat(filled) +
    theme.muted + "─".repeat(empty) +
    theme.reset;

  const stepLabel = `${theme.primary}${bold}[${step}/${total}]${reset}`;

  console.log(`  ${bar}  ${stepLabel} ${bold}${title}${reset}`);

  if (subtitle) {
    console.log(`  ${theme.muted}${subtitle}${theme.reset}`);
  }

  console.log("");
}

// ─── Box ────────────────────────────────────────────────────────────────────

export function printBox(lines: string[], color = theme.muted): void {
  // Strip ANSI for width measurement
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length));
  const width = maxLen + 4;

  console.log(`  ${color}╭${"─".repeat(width)}╮${reset}`);
  for (const line of lines) {
    const visible = stripAnsi(line).length;
    const pad = " ".repeat(Math.max(0, maxLen - visible));
    console.log(`  ${color}│${reset}  ${line}${pad}  ${color}│${reset}`);
  }
  console.log(`  ${color}╰${"─".repeat(width)}╯${reset}`);
}

// ─── Summary Box ────────────────────────────────────────────────────────────

interface SummaryItem {
  label: string;
  value: string;
}

export function printSummary(title: string, items: SummaryItem[], footer?: string[]): void {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const maxLabel = Math.max(...items.map((i) => i.label.length));

  const formatted = items.map(
    (i) => `${theme.muted}${i.label.padEnd(maxLabel)}${reset}  ${i.value}`
  );

  const allLines = [
    `${bold}${theme.success}${title}${reset}`,
    "",
    ...formatted,
  ];

  if (footer && footer.length > 0) {
    allLines.push("");
    allLines.push(...footer.map((f) => `${theme.warning}${f}${reset}`));
  }

  console.log("");
  printBox(allLines, theme.secondary);
  console.log("");
}

// ─── Divider ────────────────────────────────────────────────────────────────

export function printDivider(): void {
  const cols = Math.min(process.stdout.columns || 60, 60);
  console.log(`  ${theme.muted}${"·".repeat(cols - 4)}${theme.reset}`);
  console.log("");
}

// ─── Prompt styling ─────────────────────────────────────────────────────────

export function promptLabel(text: string): string {
  return `  ${theme.secondary}?${reset} ${bold}${text}${reset}`;
}

export function inputHint(text: string): string {
  return `${theme.muted}${text}${reset}`;
}

// ─── Completion animation ───────────────────────────────────────────────────

export async function printCompletionAnimation(): Promise<void> {
  if (!supportsColor || !process.stdout.isTTY) return;

  const frames = ["◐", "◓", "◑", "◒"];
  const msg = " Generating identity";

  for (let i = 0; i < 8; i++) {
    process.stdout.write(`\r  ${theme.secondary}${frames[i % frames.length]}${reset}${msg}${"·".repeat((i % 3) + 1)}   `);
    await new Promise((r) => setTimeout(r, 120));
  }
  process.stdout.write(`\r  ${theme.success}✓${reset}${msg}... done!       \n`);
}
