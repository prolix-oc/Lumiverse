import type { WorldBookEntry } from "../types/world-book";

interface Node {
  next: Map<number, number>;
  fail: number;
  out: number[];
}

interface Automaton {
  nodes: Node[];
  meta: PatternMeta[];
  empty: boolean;
}

interface PatternMeta {
  entryUid: string;
  keyIndex: number;
  role: "primary" | "secondary";
  wholeWord: boolean;
  patternLen: number;
}

function makeNode(): Node {
  return { next: new Map(), fail: 0, out: [] };
}

function buildAutomaton(patterns: { text: string; meta: PatternMeta }[]): Automaton {
  const nodes: Node[] = [makeNode()];
  const meta: PatternMeta[] = [];

  for (const p of patterns) {
    if (!p.text) continue;
    let cur = 0;
    for (let i = 0; i < p.text.length; i++) {
      const c = p.text.charCodeAt(i);
      let nxt = nodes[cur].next.get(c);
      if (nxt === undefined) {
        nxt = nodes.length;
        nodes.push(makeNode());
        nodes[cur].next.set(c, nxt);
      }
      cur = nxt;
    }
    const id = meta.length;
    meta.push(p.meta);
    nodes[cur].out.push(id);
  }

  const queue: number[] = [];
  for (const [c, child] of nodes[0].next) {
    nodes[child].fail = 0;
    queue.push(child);
    void c;
  }
  while (queue.length) {
    const u = queue.shift()!;
    for (const [c, v] of nodes[u].next) {
      let f = nodes[u].fail;
      while (f !== 0 && !nodes[f].next.has(c)) f = nodes[f].fail;
      const fallback = nodes[f].next.get(c);
      nodes[v].fail = fallback !== undefined && fallback !== v ? fallback : 0;
      for (const o of nodes[nodes[v].fail].out) nodes[v].out.push(o);
      queue.push(v);
    }
  }

  return { nodes, meta, empty: meta.length === 0 };
}

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function verifyWordBoundary(text: string, start: number, end: number): boolean {
  const firstIsWord = isWordChar(text.charCodeAt(start));
  const lastIsWord = isWordChar(text.charCodeAt(end));
  const beforeIsWord = start > 0 && isWordChar(text.charCodeAt(start - 1));
  const afterIsWord = end + 1 < text.length && isWordChar(text.charCodeAt(end + 1));
  if (firstIsWord === beforeIsWord) return false;
  if (lastIsWord === afterIsWord) return false;
  return true;
}

function* runAutomaton(ac: Automaton, text: string): Generator<{ id: number; end: number }> {
  if (ac.empty) return;
  const nodes = ac.nodes;
  let state = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    while (state !== 0 && !nodes[state].next.has(c)) state = nodes[state].fail;
    const nxt = nodes[state].next.get(c);
    state = nxt !== undefined ? nxt : 0;
    if (nodes[state].out.length) {
      for (const id of nodes[state].out) yield { id, end: i };
    }
  }
}

/** Accumulated hit state across recursion passes. Hits are keyed by entry uid. */
export interface ScanState {
  primaryHits: Map<string, Set<number>>;    // uid -> primary key indices that matched
  secondaryHits: Map<string, Set<number>>;  // uid -> secondary key indices that matched
  regexCache: Map<string, RegExp | null>;
}

export function makeScanState(): ScanState {
  return { primaryHits: new Map(), secondaryHits: new Map(), regexCache: new Map() };
}

/**
 * Aho-Corasick-backed keyword matcher for world info entries. Build once per
 * activation cycle; scan text chunks to accumulate hits in a ScanState, then
 * evaluate entries against that state.
 */
export class WorldInfoMatcher {
  private casedAC: Automaton;
  private uncasedAC: Automaton;
  private regexEntries: WorldBookEntry[];
  private entriesByUid: Map<string, WorldBookEntry>;

  constructor(entries: WorldBookEntry[]) {
    const cased: { text: string; meta: PatternMeta }[] = [];
    const uncased: { text: string; meta: PatternMeta }[] = [];
    const regexEntries: WorldBookEntry[] = [];
    this.entriesByUid = new Map();

    for (const e of entries) {
      this.entriesByUid.set(e.uid, e);
      if (e.use_regex) {
        if (e.key.length || e.keysecondary.length) regexEntries.push(e);
        continue;
      }
      const sink = e.case_sensitive ? cased : uncased;
      const pushKeys = (keys: string[], role: "primary" | "secondary") => {
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (!k) continue;
          const text = e.case_sensitive ? k : k.toLowerCase();
          sink.push({
            text,
            meta: {
              entryUid: e.uid, keyIndex: i, role,
              wholeWord: e.match_whole_words,
              patternLen: text.length,
            },
          });
        }
      };
      pushKeys(e.key, "primary");
      pushKeys(e.keysecondary, "secondary");
    }

    this.casedAC = buildAutomaton(cased);
    this.uncasedAC = buildAutomaton(uncased);
    this.regexEntries = regexEntries;
  }

  /** Scan a text chunk and merge hits into `state`. If `scope` is provided,
   *  only entries whose uid is in the set receive hits — used to honor
   *  per-entry `scan_depth` without scanning the same text multiple times. */
  scanChunk(chunk: string, state: ScanState, scope?: Set<string>): void {
    if (!chunk) return;

    const runAC = (ac: Automaton, text: string) => {
      for (const { id, end } of runAutomaton(ac, text)) {
        const m = ac.meta[id];
        if (scope && !scope.has(m.entryUid)) continue;
        if (m.wholeWord) {
          const start = end - m.patternLen + 1;
          if (!verifyWordBoundary(text, start, end)) continue;
        }
        this.recordHit(state, m);
      }
    };

    runAC(this.casedAC, chunk);
    if (!this.uncasedAC.empty) runAC(this.uncasedAC, chunk.toLowerCase());

    for (const entry of this.regexEntries) {
      if (scope && !scope.has(entry.uid)) continue;
      this.scanRegexEntry(entry, chunk, state);
    }
  }

  private recordHit(state: ScanState, m: PatternMeta) {
    const bucket = m.role === "primary" ? state.primaryHits : state.secondaryHits;
    let set = bucket.get(m.entryUid);
    if (!set) { set = new Set(); bucket.set(m.entryUid, set); }
    set.add(m.keyIndex);
  }

  private scanRegexEntry(entry: WorldBookEntry, text: string, state: ScanState) {
    const flags = entry.case_sensitive ? "g" : "gi";
    const wholeWord = entry.match_whole_words && !entry.use_regex;
    const run = (keys: string[], role: "primary" | "secondary") => {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!k) continue;
        const pattern = wholeWord
          ? `\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
          : k;
        const cacheKey = `${pattern}|${flags}`;
        let regex = state.regexCache.get(cacheKey);
        if (regex === undefined) {
          try { regex = new RegExp(pattern, flags); } catch { regex = null; }
          state.regexCache.set(cacheKey, regex);
        }
        if (!regex) continue;
        regex.lastIndex = 0;
        if (regex.test(text)) {
          this.recordHit(state, {
            entryUid: entry.uid, keyIndex: i, role,
            wholeWord: false, patternLen: 0,
          });
        }
      }
    };
    run(entry.key, "primary");
    run(entry.keysecondary, "secondary");
  }

  shouldActivate(entry: WorldBookEntry, state: ScanState): boolean {
    const primary = state.primaryHits.get(entry.uid);
    if (!primary || primary.size === 0) return false;

    if (!entry.selective || entry.keysecondary.length === 0) return true;

    const hits = state.secondaryHits.get(entry.uid);
    const hitCount = hits?.size ?? 0;
    const total = entry.keysecondary.length;

    switch (entry.selective_logic) {
      case 0: return hitCount === total;       // AND
      case 1: return hitCount === 0;           // NOT
      case 2: return hitCount > 0;             // OR
      case 3: return hitCount < total;         // NOT All
      default: return true;
    }
  }
}
