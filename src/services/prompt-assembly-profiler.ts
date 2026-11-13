const DEFAULT_SLOW_PHASE_MS = 75;
const DEFAULT_SLOW_TOTAL_MS = 250;

type PhaseTiming = {
  name: string;
  ms: number;
};

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SLOW_PHASE_MS = readPositiveNumber(
  "LUMIVERSE_PROMPT_PHASE_WARN_MS",
  DEFAULT_SLOW_PHASE_MS,
);
const SLOW_TOTAL_MS = readPositiveNumber(
  "LUMIVERSE_PROMPT_TOTAL_WARN_MS",
  DEFAULT_SLOW_TOTAL_MS,
);

export class PromptAssemblyProfiler {
  private readonly startedAt = performance.now();
  private readonly phases: PhaseTiming[] = [];

  constructor(
    private readonly label: string,
    private readonly meta: Record<string, string | number | boolean | null | undefined> = {},
  ) {}

  measureSync<T>(name: string, fn: () => T): T {
    const startedAt = performance.now();
    try {
      return fn();
    } finally {
      this.addPhase(name, performance.now() - startedAt);
    }
  }

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      this.addPhase(name, performance.now() - startedAt);
    }
  }

  addPhase(name: string, ms: number): void {
    this.phases.push({ name, ms });
  }

  finish(): void {
    const totalMs = performance.now() - this.startedAt;
    const slowPhases = this.phases.filter((phase) => phase.ms >= SLOW_PHASE_MS);
    if (totalMs < SLOW_TOTAL_MS && slowPhases.length === 0) return;

    const meta = Object.entries(this.meta)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    const topPhases = [...this.phases]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8)
      .map((phase) => `${phase.name}=${phase.ms.toFixed(1)}ms`)
      .join(" ");

    console.warn(
      `[prompt-profiler] ${this.label} total=${totalMs.toFixed(1)}ms${meta ? ` ${meta}` : ""}${topPhases ? ` phases: ${topPhases}` : ""}`,
    );
  }
}

export function createPromptAssemblyProfiler(
  label: string,
  meta?: Record<string, string | number | boolean | null | undefined>,
): PromptAssemblyProfiler {
  return new PromptAssemblyProfiler(label, meta);
}
