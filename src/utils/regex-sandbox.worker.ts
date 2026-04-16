/**
 * Worker-side regex evaluator. Runs untrusted patterns inside a Bun Worker so
 * a catastrophic-backtracking pattern blocks ONLY the worker's thread, not the
 * main HTTP/event loop. The parent process kills and respawns this worker if
 * an evaluation exceeds its timeout.
 *
 * Protocol:
 *   in:  { id, op: "replace" | "test" | "collect", pattern, flags, input, replacement? }
 *   out: { id, ok: true, result } | { id, ok: false, error }
 */

// `self` is a global inside Bun Workers. We narrow its type here without
// re-declaring it (which would conflict with lib.dom).
const workerSelf = self as unknown as {
  addEventListener: (type: "message", handler: (event: MessageEvent) => void) => void;
  postMessage: (message: unknown) => void;
};

interface ReplaceRequest {
  id: string;
  op: "replace";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
}

interface TestRequest {
  id: string;
  op: "test";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
}

interface CollectRequest {
  id: string;
  op: "collect";
  pattern: string;
  flags: string;
  input: string;
}

type RegexRequest = ReplaceRequest | TestRequest | CollectRequest;

interface CollectedMatch {
  fullMatch: string;
  index: number;
  groups: (string | undefined)[];
  namedGroups?: Record<string, string>;
}

function collectMatches(input: string, re: RegExp): CollectedMatch[] {
  const matches: CollectedMatch[] = [];
  if (re.global || re.sticky) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      matches.push({
        fullMatch: m[0],
        index: m.index,
        groups: Array.from(m).slice(1),
        namedGroups: m.groups,
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  } else {
    const m = re.exec(input);
    if (m) {
      matches.push({
        fullMatch: m[0],
        index: m.index,
        groups: Array.from(m).slice(1),
        namedGroups: m.groups,
      });
    }
  }
  return matches;
}

workerSelf.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as RegexRequest;
  try {
    const re = new RegExp(data.pattern, data.flags);
    let result: unknown;

    if (data.op === "replace") {
      result = data.input.replace(re, data.replacement);
    } else if (data.op === "test") {
      // Counting via a side-effect callback avoids a second compile.
      let matches = 0;
      const counter = new RegExp(re.source, re.flags);
      data.input.replace(counter, (...args) => {
        matches++;
        return String(args[0] ?? "");
      });
      const out = data.input.replace(re, data.replacement);
      result = { result: out, matches };
    } else if (data.op === "collect") {
      result = collectMatches(data.input, re);
    } else {
      throw new Error(`Unknown regex op: ${(data as { op: string }).op}`);
    }

    workerSelf.postMessage({ id: data.id, ok: true, result });
  } catch (err: unknown) {
    workerSelf.postMessage({
      id: data.id,
      ok: false,
      error: err instanceof Error ? err.message : "Regex evaluation failed",
    });
  }
});
