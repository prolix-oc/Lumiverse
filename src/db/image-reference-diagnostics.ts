export interface ImageReferenceDiagnostics {
  strategy: "legacy" | "backfill" | "dirty-fallback" | "indexed" | "index-error";
  candidateCount: number;
  referencedCount: number;
  dirtyProcessed: number;
  pendingSources: number;
  stages: Array<{ name: string; durationMs: number }>;
}

export function createImageReferenceDiagnostics(candidateCount: number): ImageReferenceDiagnostics {
  return { strategy: "legacy", candidateCount, referencedCount: 0, dirtyProcessed: 0, pendingSources: 0, stages: [] };
}

export function timeImageReferenceStage<T>(diagnostics: ImageReferenceDiagnostics, name: string, run: () => T): T {
  const started = performance.now();
  try { return run(); }
  finally {
    const elapsed = performance.now() - started;
    const existing = diagnostics.stages.find(stage => stage.name === name);
    if (existing) existing.durationMs += elapsed;
    else diagnostics.stages.push({ name, durationMs: elapsed });
  }
}

/** No IDs or source content in operational logs. */
export function formatImageReferenceDiagnostics(diagnostics: ImageReferenceDiagnostics): string {
  const stages = diagnostics.stages.map(stage => `${stage.name}:${Math.round(stage.durationMs)}ms`).join(",");
  return ` candidates=${diagnostics.candidateCount} referenced=${diagnostics.referencedCount} strategy=${diagnostics.strategy} dirty=${diagnostics.dirtyProcessed} pendingSources=${diagnostics.pendingSources} stages=[${stages}]`;
}
