import { inspect } from "node:util";

/** Console arguments must survive capture without losing Error's non-enumerable fields. */
export function formatLogArguments(args: readonly unknown[]): string {
  return args.map((value) => {
    if (typeof value === "string") return value;
    try {
      // inspect also handles causes, AggregateError, nested errors, cycles and
      // bigint. Don't run application-provided inspection hooks or getters.
      return inspect(value, { colors: false, depth: 5, customInspect: false, getters: false });
    } catch {
      // Diagnostics must never replace the original failure with a logging error.
      return "[Unformattable log argument]";
    }
  }).join(" ");
}
