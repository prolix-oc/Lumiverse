import type { MacroDiagnostic } from "./types";

export function warn(message: string, macroName?: string, offset?: number): MacroDiagnostic {
  return { level: "warn", message, macroName, offset };
}

export function error(message: string, macroName?: string, offset?: number): MacroDiagnostic {
  return { level: "error", message, macroName, offset };
}

export function formatDiagnostics(diagnostics: MacroDiagnostic[]): string {
  return diagnostics
    .map((d) => {
      const prefix = d.level === "error" ? "ERROR" : "WARN";
      const loc = d.macroName ? ` [${d.macroName}]` : "";
      return `[${prefix}${loc}] ${d.message}`;
    })
    .join("\n");
}
