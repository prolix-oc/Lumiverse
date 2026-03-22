import { registry } from "../MacroRegistry";

export function registerTimeMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "time",
    category: "Time",
    description: "Current time (HH:MM). Accepts optional UTC offset argument.",
    returnType: "string",
    args: [{ name: "utcOffset", optional: true, description: "UTC offset like UTC+2 or UTC-5" }],
    handler: (ctx) => {
      const offset = ctx.args[0];
      const now = new Date();

      if (offset) {
        const parsed = parseUTCOffset(offset);
        if (parsed !== null) {
          const utc = now.getTime() + now.getTimezoneOffset() * 60000;
          const shifted = new Date(utc + parsed * 3600000);
          return shifted.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        }
      }

      return now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "date",
    category: "Time",
    description: "Current date (Month Day, Year)",
    returnType: "string",
    handler: () => {
      return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "weekday",
    category: "Time",
    description: "Current day of the week",
    returnType: "string",
    handler: () => {
      return new Date().toLocaleDateString("en-US", { weekday: "long" });
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "isotime",
    category: "Time",
    description: "Current date and time in ISO 8601 format",
    returnType: "string",
    handler: () => new Date().toISOString(),
  });

  registry.registerMacro({
    builtIn: true,
    name: "isodate",
    category: "Time",
    description: "Current date in ISO format (YYYY-MM-DD)",
    returnType: "string",
    handler: () => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "datetimeformat",
    category: "Time",
    description: "Format current date/time with a custom Intl pattern",
    returnType: "string",
    args: [{ name: "format", optional: true, description: "Intl.DateTimeFormat options as key=value pairs" }],
    handler: (ctx) => {
      const now = new Date();
      if (!ctx.args[0]) return now.toLocaleString();

      try {
        const opts: Record<string, string> = {};
        for (const pair of ctx.args[0].split(",")) {
          const [k, v] = pair.split("=").map((s) => s.trim());
          if (k && v) opts[k] = v;
        }
        const locale = opts.locale || "en-US";
        delete opts.locale;
        return new Intl.DateTimeFormat(locale, opts as any).format(now);
      } catch {
        return now.toLocaleString();
      }
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "idleDuration",
    category: "Time",
    description: "Human-readable time since last message",
    returnType: "string",
    aliases: ["idle_duration"],
    handler: (ctx) => {
      const lastMessageTime = ctx.env.extra.lastMessageTime as number | undefined;
      if (!lastMessageTime) return "unknown";
      const diff = Date.now() - lastMessageTime;
      return formatDuration(diff);
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "timeDiff",
    category: "Time",
    description: "Human-readable difference between two ISO date strings",
    returnType: "string",
    args: [
      { name: "date1", description: "First ISO date string" },
      { name: "date2", optional: true, description: "Second ISO date string (defaults to now)" },
    ],
    aliases: ["time_diff"],
    handler: (ctx) => {
      const d1 = Date.parse(ctx.args[0]);
      if (isNaN(d1)) return "invalid date";
      const d2 = ctx.args[1] ? Date.parse(ctx.args[1]) : Date.now();
      if (isNaN(d2)) return "invalid date";
      return formatDuration(Math.abs(d2 - d1));
    },
  });
}

function parseUTCOffset(str: string): number | null {
  const match = str.match(/^UTC([+-])(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const sign = match[1] === "+" ? 1 : -1;
  return sign * parseFloat(match[2]);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}
