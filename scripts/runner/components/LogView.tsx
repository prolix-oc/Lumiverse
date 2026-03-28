import React from "react";
import { Box, Text, useStdout } from "ink";
import { LogLine } from "./LogLine.js";
import type { LogEntry } from "../hooks/useLogBuffer.js";
import { terminalEnv } from "../lib/terminal.js";

interface LogViewProps {
  logs: LogEntry[];
  scrollOffset: number;
  /** Number of rows reserved for non-log chrome (header + action bar) */
  chromeRows?: number;
}

/**
 * Bordered log container with scrollable content.
 * Border consumes 2 rows (top + bottom), accounted for in height calc.
 */
export const LogView = React.memo(function LogView({
  logs,
  scrollOffset,
  chromeRows = 2,
}: LogViewProps): React.ReactElement {
  const { stdout } = useStdout();
  const rawRows = stdout?.rows ?? 24;
  // Must match App's termHeight logic: full-redraw terminals use exact rows
  // (triggers Ink fullscreen path), others use rows - 1 (incremental rendering).
  const rows = terminalEnv.useFullRedraw ? rawRows : rawRows - 1;
  const cols = stdout?.columns ?? 80;

  // 2 for the border top/bottom
  const logAreaHeight = Math.max(1, rows - chromeRows - 2);
  const totalLogs = logs.length;

  let startIdx: number;
  if (scrollOffset === 0) {
    startIdx = Math.max(0, totalLogs - logAreaHeight);
  } else {
    startIdx = Math.max(0, totalLogs - logAreaHeight - scrollOffset);
  }
  const endIdx = Math.min(startIdx + logAreaHeight, totalLogs);

  const elements: React.ReactElement[] = [];

  for (let i = startIdx; i < endIdx; i++) {
    elements.push(<LogLine key={i} entry={logs[i]} />);
  }

  // Pad remaining empty rows so the box holds its shape
  const rendered = endIdx - startIdx;
  for (let i = rendered; i < logAreaHeight; i++) {
    elements.push(<Text key={`empty-${i}`}> </Text>);
  }

  // Explicit height: content rows + 2 for border top/bottom.
  // This pins the box size so it never pushes the header off screen.
  const boxHeight = logAreaHeight + 2;

  return (
    <Box
      flexDirection="column"
      height={boxHeight}
      borderStyle="single"
      borderColor="cyan"
      width={cols}
      paddingX={1}
      overflow="hidden"
    >
      {elements}
    </Box>
  );
});
