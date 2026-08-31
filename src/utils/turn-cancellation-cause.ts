export type CancellationTerminalCause = Readonly<{
  phase: "CANCELLED" | "TIMED_OUT";
  code: "cancelled" | "timed_out";
  reason: "cancelled" | "root_wall_clock_limit_exceeded";
}>;

const CANCELLED_CAUSE: CancellationTerminalCause = Object.freeze({
  phase: "CANCELLED",
  code: "cancelled",
  reason: "cancelled",
});
const TIMED_OUT_CAUSE: CancellationTerminalCause = Object.freeze({
  phase: "TIMED_OUT",
  code: "timed_out",
  reason: "root_wall_clock_limit_exceeded",
});

/** Classifies the immutable first cancellation marker against the root deadline. */
export function cancellationTerminalCause(
  firstMarkerAt: number,
  deadlineAt: number,
): CancellationTerminalCause {
  return deadlineAt > 0 && firstMarkerAt >= deadlineAt ? TIMED_OUT_CAUSE : CANCELLED_CAUSE;
}
