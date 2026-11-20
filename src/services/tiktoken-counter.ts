/** Count-only BPE for tiktoken vocabularies. No dependency on an engine's internals. */
type Merge = { rank: number; left: number; right: number; leftVersion: number; rightVersion: number };

class MergeQueue {
  private items: Merge[] = [];
  private before(a: Merge, b: Merge): boolean {
    return a.rank < b.rank || (a.rank === b.rank && a.left < b.left);
  }
  push(value: Merge): void {
    let i = this.items.length;
    this.items.push(value);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (!this.before(value, this.items[parent])) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = value;
  }
  pop(): Merge | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.before(this.items[child + 1], this.items[child])) child++;
        if (!this.before(this.items[child], last)) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

export class TiktokenCounter {
  private ranks = new Map<string, number>();
  private pieces = new Map<string, number>();
  private split: RegExp;
  private special: RegExp | null;

  constructor(bpe: string, pattern: string, specialTokens: Record<string, number>) {
    this.split = new RegExp(pattern, "ug");
    const specials = Object.keys(specialTokens);
    this.special = specials.length
      ? new RegExp(specials.map(token => token.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")) : null;
    const lines = bpe.split(/\r?\n/).filter(line => line.trim().length > 0);
    const standard = /^\S+\s+\d+$/.test(lines[0] ?? "");
    let expectedRank = 0;
    for (const line of lines) {
      if (standard) {
        const [token, rawRank] = line.trim().split(/\s+/);
        const rank = Number(rawRank);
        if (!Number.isInteger(rank) || rank !== expectedRank++) throw new Error("Non-contiguous tiktoken ranks");
        this.add(token, rank);
      } else {
        // js-tiktoken's compressed format consists of sentinel, offset, tokens.
        const [, offset, ...tokens] = line.trim().split(/\s+/);
        const start = Number(offset);
        if (!Number.isInteger(start) || start < 0 || !tokens.length) throw new Error("Invalid compressed tiktoken ranks");
        tokens.forEach((token, i) => this.add(token, start + i));
      }
    }
    if (!this.ranks.size) throw new Error("Empty tiktoken vocabulary");
  }

  private add(base64: string, rank: number): void {
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("Invalid tiktoken vocabulary token");
    // Latin-1 strings preserve arbitrary UTF-8 byte fragments without lossy
    // decoding, and avoid js-tiktoken's comma-separated decimal byte keys.
    this.ranks.set(Buffer.from(base64, "base64").toString("latin1"), rank);
  }

  count(text: string): number {
    if (this.special?.test(text)) throw new Error("The text contains a disallowed special token");
    let count = 0;
    for (const [piece] of text.matchAll(this.split)) {
      const hit = this.pieces.get(piece);
      if (hit !== undefined) {
        this.pieces.delete(piece);
        this.pieces.set(piece, hit);
        count += hit;
        continue;
      }
      const bytes = Buffer.from(piece, "utf8").toString("latin1");
      const tokens = this.ranks.has(bytes) ? 1 : this.mergeCount(bytes);
      if (piece.length <= 256) {
        if (this.pieces.size >= 10_000) this.pieces.delete(this.pieces.keys().next().value!);
        this.pieces.set(piece, tokens);
      }
      count += tokens;
    }
    return count;
  }

  private mergeCount(bytes: string): number {
    const n = bytes.length;
    if (!n) return 0;
    // Match js-tiktoken's one-byte fast path even for incomplete custom vocabularies.
    if (n === 1) return 1;
    const next = new Int32Array(n);
    const previous = new Int32Array(n);
    const end = new Int32Array(n);
    const version = new Uint32Array(n);
    const queue = new MergeQueue();
    const offer = (left: number): void => {
      if (left < 0) return;
      const right = next[left];
      if (right < 0) return;
      const rank = this.ranks.get(bytes.slice(left, end[right]));
      if (rank !== undefined) queue.push({ rank, left, right, leftVersion: version[left], rightVersion: version[right] });
    };
    for (let i = 0; i < n; i++) {
      next[i] = i + 1 < n ? i + 1 : -1;
      previous[i] = i - 1;
      end[i] = i + 1;
    }
    for (let i = 0; i < n - 1; i++) offer(i);
    for (let merge = queue.pop(); merge; merge = queue.pop()) {
      const { left, right } = merge;
      if (version[left] !== merge.leftVersion || version[right] !== merge.rightVersion || next[left] !== right) continue;
      end[left] = end[right];
      next[left] = next[right];
      if (next[right] >= 0) previous[next[right]] = left;
      version[left]++;
      version[right]++;
      next[right] = -1;
      // Only neighbors of the newly merged piece can acquire new ranks.
      offer(previous[left]);
      offer(left);
    }
    let count = 0;
    for (let i = 0; i >= 0; i = next[i]) {
      if (this.ranks.has(bytes.slice(i, end[i]))) count++;
    }
    return count;
  }
}
