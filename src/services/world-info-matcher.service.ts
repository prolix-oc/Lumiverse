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
  configuredPattern: string;
}

interface FoldedText {
  text: string;
  originalStartByFoldedIndex: number[];
  originalEndByFoldedIndex: number[];
}

function foldWithOriginalOffsets(value: string): FoldedText {
  let text = "";
  const originalStartByFoldedIndex: number[] = [];
  const originalEndByFoldedIndex: number[] = [];

  for (let originalIndex = 0; originalIndex < value.length;) {
    const codePoint = value.codePointAt(originalIndex)!;
    const originalWidth = codePoint > 0xffff ? 2 : 1;
    const foldedCodePoint = value.slice(originalIndex, originalIndex + originalWidth).toLowerCase();
    text += foldedCodePoint;
    for (let foldedIndex = 0; foldedIndex < foldedCodePoint.length; foldedIndex++) {
      originalStartByFoldedIndex.push(originalIndex);
      originalEndByFoldedIndex.push(originalIndex + originalWidth);
    }
    originalIndex += originalWidth;
  }

  return { text, originalStartByFoldedIndex, originalEndByFoldedIndex };
}

export type WorldInfoMatchSource =
  | { kind: "message"; messageId: string; messageOffset: number }
  | { kind: "recursive_entry"; entryId: string };

export interface WorldInfoExactMatch {
  configuredPattern: string;
  source: WorldInfoMatchSource;
  start: number;
  end: number;
}

export interface WorldInfoMatcherOptions {
  forceCaseSensitive?: boolean;
  forceMatchWholeWords?: boolean;
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
  exactMatches: Map<string, WorldInfoExactMatch[]>;
}

export function makeScanState(): ScanState {
  return { primaryHits: new Map(), secondaryHits: new Map(), regexCache: new Map(), exactMatches: new Map() };
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

  private forceCaseSensitive: boolean;
  private forceMatchWholeWords: boolean;

  constructor(entries: WorldBookEntry[], options: WorldInfoMatcherOptions = {}) {
    this.forceCaseSensitive = options.forceCaseSensitive === true;
    this.forceMatchWholeWords = options.forceMatchWholeWords === true;
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
      const caseSensitive = this.forceCaseSensitive || e.case_sensitive;
      const matchWholeWords = this.forceMatchWholeWords || e.match_whole_words;
      const sink = caseSensitive ? cased : uncased;
      const pushKeys = (keys: string[], role: "primary" | "secondary") => {
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (!k) continue;
          const text = caseSensitive ? k : foldWithOriginalOffsets(k).text;
          sink.push({
            text,
            meta: {
              entryUid: e.uid, keyIndex: i, role,
              wholeWord: matchWholeWords,
              patternLen: text.length,
              configuredPattern: k,
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
  scanChunk(
    chunk: string,
    state: ScanState,
    scope?: Set<string>,
    source?: WorldInfoMatchSource,
  ): void {
    if (!chunk) return;

    const runAC = (ac: Automaton, text: string, offsets?: FoldedText) => {
      if (ac.empty) return;
      const active = new Uint8Array(ac.meta.length);
      let remaining = 0;
      for (let id = 0; id < ac.meta.length; id++) {
        const meta = ac.meta[id];
        if (scope && !scope.has(meta.entryUid)) continue;
        const bucket = meta.role === "primary" ? state.primaryHits : state.secondaryHits;
        const keyAlreadyMatched = bucket.get(meta.entryUid)?.has(meta.keyIndex) === true;
        const hasEnoughLocatorEvidence =
          !source || (state.exactMatches.get(meta.entryUid)?.length ?? 0) >= 2;
        if (keyAlreadyMatched && hasEnoughLocatorEvidence) continue;
        active[id] = 1;
        remaining++;
      }
      if (remaining === 0) return;

      for (const { id, end } of runAutomaton(ac, text)) {
        if (active[id] === 0) continue;
        const m = ac.meta[id];
        const foldedStart = end - m.patternLen + 1;
        const foldedEnd = end + 1;
        const originalStart = offsets
          ? offsets.originalStartByFoldedIndex[foldedStart]
          : foldedStart;
        const originalEnd = offsets
          ? offsets.originalEndByFoldedIndex[foldedEnd - 1]
          : foldedEnd;
        if (m.wholeWord) {
          const boundaryText = offsets ? chunk : text;
          if (!verifyWordBoundary(boundaryText, originalStart, originalEnd - 1)) continue;
        }
        this.recordHit(state, m, source, originalStart, originalEnd);
        const hasEnoughLocatorEvidence =
          !source || (state.exactMatches.get(m.entryUid)?.length ?? 0) >= 2;
        if (hasEnoughLocatorEvidence) {
          active[id] = 0;
          remaining--;
          if (remaining === 0) break;
        }
      }
    };

    runAC(this.casedAC, chunk);
    if (!this.uncasedAC.empty) {
      const folded = foldWithOriginalOffsets(chunk);
      runAC(this.uncasedAC, folded.text, folded);
    }

    for (const entry of this.regexEntries) {
      if (scope && !scope.has(entry.uid)) continue;
      this.scanRegexEntry(entry, chunk, state, source);
    }
  }

  private recordHit(
    state: ScanState,
    m: PatternMeta,
    source?: WorldInfoMatchSource,
    start?: number,
    end?: number,
  ) {
    const bucket = m.role === "primary" ? state.primaryHits : state.secondaryHits;
    let set = bucket.get(m.entryUid);
    if (!set) { set = new Set(); bucket.set(m.entryUid, set); }
    set.add(m.keyIndex);
    if (source && start !== undefined && end !== undefined) {
      const matches = state.exactMatches.get(m.entryUid) ?? [];
      // Provenance only distinguishes one unambiguous locator from multiple
      // possible locators. Once two distinct matches exist, retaining every
      // later occurrence adds no information and makes common keys in long
      // chats quadratic: each new occurrence scanned the full accumulated
      // array. Keep the evidence bounded at the semantic threshold instead.
      if (matches.length >= 2) return;
      const duplicate = matches.some((match) => {
        if (match.configuredPattern !== m.configuredPattern || match.start !== start || match.end !== end) return false;
        if (match.source.kind !== source.kind) return false;
        if (match.source.kind === "message" && source.kind === "message") {
          return match.source.messageId === source.messageId && match.source.messageOffset === source.messageOffset;
        }
        if (match.source.kind === "recursive_entry" && source.kind === "recursive_entry") {
          return match.source.entryId === source.entryId;
        }
        return false;
      });
      if (!duplicate) {
        matches.push({ configuredPattern: m.configuredPattern, source, start, end });
        state.exactMatches.set(m.entryUid, matches);
      }
    }
  }

  private scanRegexEntry(
    entry: WorldBookEntry,
    text: string,
    state: ScanState,
    source?: WorldInfoMatchSource,
  ) {
    const flags = this.forceCaseSensitive || entry.case_sensitive ? "g" : "gi";
    const wholeWord = (this.forceMatchWholeWords || entry.match_whole_words) && !entry.use_regex;
    const run = (keys: string[], role: "primary" | "secondary") => {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!k) continue;
        const bucket = role === "primary" ? state.primaryHits : state.secondaryHits;
        const keyAlreadyMatched = bucket.get(entry.uid)?.has(i) === true;
        const hasEnoughLocatorEvidence =
          !source || (state.exactMatches.get(entry.uid)?.length ?? 0) >= 2;
        if (keyAlreadyMatched && hasEnoughLocatorEvidence) continue;
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
        regex.lastIndex = 0;
        const match = regex.exec(text);
        if (match) {
          this.recordHit(state, {
            entryUid: entry.uid, keyIndex: i, role,
            wholeWord: false, patternLen: 0, configuredPattern: k,
          }, source, match.index, match.index + match[0].length);
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
