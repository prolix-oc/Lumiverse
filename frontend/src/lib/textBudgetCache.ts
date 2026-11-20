/**
 * FIFO cache bounded by both entry count and retained UTF-16 text. Browser
 * string storage varies; this is a text budget, not a JavaScript heap estimate.
 * Oversized results still reach their caller, but are not retained for reuse.
 * Pending entries should include the text captured by their async work.
 */
export class TextBudgetCache<T> extends Map<string, T> {
  private readonly weights = new Map<string, number>()
  private characters = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxCharacters: number,
    private readonly valueCharacters: (value: T) => number,
  ) {
    super()
  }

  get retainedCharacters(): number { return this.characters }

  override set(key: string, value: T): this {
    const weight = key.length + this.valueCharacters(value)
    this.delete(key)
    if (weight > this.maxCharacters) return this
    super.set(key, value)
    this.weights.set(key, weight)
    this.characters += weight
    while (this.size > this.maxEntries || this.characters > this.maxCharacters) {
      this.delete(this.keys().next().value!)
    }
    return this
  }

  override delete(key: string): boolean {
    this.characters -= this.weights.get(key) ?? 0
    this.weights.delete(key)
    return super.delete(key)
  }

  override clear(): void {
    super.clear()
    this.weights.clear()
    this.characters = 0
  }
}
