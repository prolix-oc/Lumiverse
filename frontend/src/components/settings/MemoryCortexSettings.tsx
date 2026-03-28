import { useState, useEffect, useCallback, useRef } from "react";
import {
  Brain,
  Sparkles,
  Users,
  Network,
  BarChart3,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Gauge,
  Shield,
  Trash2,
  Settings2,
  Zap,
  BookOpen,
  Heart,
} from "lucide-react";
import { Toggle } from "@/components/shared/Toggle";
import { Select } from "@/components/shared/FormComponents";
import { useStore } from "@/store";
import { memoryCortexApi, type CortexConfig, type CortexUsageStats } from "@/api/memory-cortex";
import { connectionsApi } from "@/api/connections";
import { wsClient } from "@/ws/client";
import { EventType } from "@/ws/events";
import styles from "./MemoryCortexSettings.module.css";
import clsx from "clsx";

type PresetMode = "simple" | "standard" | "advanced";

const PRESET_DESCRIPTIONS: Record<PresetMode, { label: string; desc: string; icon: typeof Zap }> = {
  simple: {
    label: "Simple",
    desc: "One toggle. Smart defaults. Entity tracking and importance scoring on, everything else automatic.",
    icon: Zap,
  },
  standard: {
    label: "Standard",
    desc: "Entities, relationships, emotional recall, and story arc summaries. Great for multi-session campaigns.",
    icon: BookOpen,
  },
  advanced: {
    label: "Advanced",
    desc: "Full control over every parameter. Retrieval weights, decay curves, token budgets, and more.",
    icon: Settings2,
  },
};

const FORMATTER_OPTIONS = [
  { value: "shadow", label: "Narrative (default)", desc: "Prose-style context the AI weaves in naturally" },
  { value: "attributed", label: "Attributed", desc: "Character-perspective memories with timestamps" },
  { value: "clinical", label: "Structured", desc: "Database-style facts and bullet points (for lore tracking)" },
  { value: "minimal", label: "Minimal", desc: "Just memory chunks, no entity data" },
];

export default function MemoryCortexSettings() {
  const addToast = useStore((s) => s.addToast);
  const [config, setConfig] = useState<CortexConfig | null>(null);
  const [stats, setStats] = useState<CortexUsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [whitelistInput, setWhitelistInput] = useState("");

  // Connection profiles for sidecar picker
  const profiles = useStore((s) => s.profiles);
  const [sidecarModels, setSidecarModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Active chat for stats (if available)
  const activeChatId = useStore((s) => s.activeChatId);

  // Fetch models when sidecar connection changes
  const fetchModels = useCallback(async (connectionId: string | null) => {
    if (!connectionId) { setSidecarModels([]); return; }
    setModelsLoading(true);
    try {
      const result = await connectionsApi.models(connectionId);
      setSidecarModels(result.models || []);
    } catch {
      setSidecarModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await memoryCortexApi.getConfig();
      setConfig(cfg);
      setShowAdvanced(cfg.presetMode === "advanced");
    } catch (err) {
      addToast({ type: "error", message: "Failed to load Memory Cortex settings" });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const loadStats = useCallback(async () => {
    if (!activeChatId) return;
    try {
      const s = await memoryCortexApi.getStats(activeChatId);
      setStats(s);
    } catch {
      // Non-fatal
    }
  }, [activeChatId]);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadStats(); }, [loadStats]);

  // On mount: check if a rebuild is already running (survives browser close)
  useEffect(() => {
    if (!activeChatId) return;
    memoryCortexApi.getRebuildStatus(activeChatId).then((status) => {
      if (status.status === "processing") {
        setRebuilding(true);
        setRebuildProgress({
          current: status.current ?? 0,
          total: status.total ?? 0,
          percent: status.percent ?? 0,
        });
      } else if (status.status === "complete" && status.result) {
        addToast({
          type: "success",
          message: `Rebuild finished while away: ${status.result.chunksProcessed} chunks, ${status.result.entitiesFound} entities, ${status.result.relationsFound} relations`,
        });
        loadStats();
      }
    }).catch(() => { /* non-fatal */ });
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for rebuild progress via WebSocket
  useEffect(() => {
    const unsub = wsClient.on(EventType.CORTEX_REBUILD_PROGRESS, (payload: any) => {
      if (!payload || payload.chatId !== activeChatId) return;
      if (payload.status === "processing") {
        setRebuildProgress({ current: payload.current, total: payload.total, percent: payload.percent });
      } else if (payload.status === "complete") {
        setRebuilding(false);
        setRebuildProgress(null);
        addToast({
          type: "success",
          message: `Rebuilt: ${payload.chunksProcessed} chunks, ${payload.entitiesFound} entities, ${payload.relationsFound} relations`,
        });
        loadStats();
      } else if (payload.status === "error") {
        setRebuilding(false);
        setRebuildProgress(null);
        addToast({ type: "error", message: payload.error || "Rebuild failed" });
      }
    });
    return () => unsub();
  }, [activeChatId, addToast, loadStats]);
  useEffect(() => {
    if (config?.sidecar?.connectionProfileId) {
      fetchModels(config.sidecar.connectionProfileId);
    }
  }, [config?.sidecar?.connectionProfileId, fetchModels]);

  const updateConfig = async (patch: Partial<CortexConfig>) => {
    if (!config) return;
    const optimistic = { ...config, ...patch };
    setConfig(optimistic);
    try {
      const updated = await memoryCortexApi.updateConfig(patch);
      setConfig(updated);
    } catch {
      setConfig(config); // Revert
      addToast({ type: "error", message: "Failed to save setting" });
    }
  };

  const applyPreset = async (mode: PresetMode) => {
    try {
      const updated = await memoryCortexApi.applyPreset(mode);
      setConfig(updated);
      setShowAdvanced(mode === "advanced");
      addToast({ type: "success", message: `Applied "${mode}" preset` });
    } catch {
      addToast({ type: "error", message: "Failed to apply preset" });
    }
  };

  const handleRebuild = async () => {
    if (!activeChatId) {
      addToast({ type: "warning", message: "Open a chat first to rebuild its memory graph" });
      return;
    }
    setRebuilding(true);
    setRebuildProgress(null);
    try {
      await memoryCortexApi.rebuild(activeChatId);
      // Response is immediate ({ status: "started" }). Progress comes via WS.
    } catch (err: any) {
      setRebuilding(false);
      addToast({ type: "error", message: err.message || "Failed to start rebuild" });
    }
  };

  const addWhitelistTerm = () => {
    const term = whitelistInput.trim();
    if (!term || !config) return;
    if (config.entityWhitelist.includes(term)) {
      addToast({ type: "warning", message: `"${term}" is already in the whitelist` });
      return;
    }
    updateConfig({ entityWhitelist: [...config.entityWhitelist, term] });
    setWhitelistInput("");
  };

  const removeWhitelistTerm = (term: string) => {
    if (!config) return;
    updateConfig({ entityWhitelist: config.entityWhitelist.filter((t) => t !== term) });
  };

  if (loading || !config) {
    return <div className={styles.container}><div className={styles.loadingText}>Loading...</div></div>;
  }

  const isAdvanced = config.presetMode === "advanced" || showAdvanced;

  return (
    <div className={styles.container}>
      {/* ── Master Toggle ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Brain size={14} />
          <span>Memory Cortex</span>
          <div className={styles.sectionHeaderActions}>
            <span className={clsx(styles.statusDot, config.enabled ? styles.statusActive : styles.statusInactive)} />
            <span className={styles.statusLabel}>{config.enabled ? "Active" : "Off"}</span>
          </div>
        </div>
        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={config.enabled}
            onChange={(v) => updateConfig({ enabled: v })}
            label  ="Enable Memory Cortex"
            hint   ='Adds entity tracking, importance scoring, and emotional recall on top of existing long-term memory. Your existing memory system continues working independently.'
          />
        </div>
      </div>

      {!config.enabled ? (
        <div className={styles.disabledNotice}>
          <p>Memory Cortex is off. Your existing long-term chat memory (vector search) is still active.</p>
          <p>Enable the cortex to add entity tracking, narrative importance scoring, and emotionally-aware recall.</p>
        </div>
      ) : (
        <>
          {/* ── Preset Selector ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Gauge size={14} />
              <span>Mode</span>
            </div>
            <div className={styles.presetGrid}>
              {(Object.entries(PRESET_DESCRIPTIONS) as [PresetMode, typeof PRESET_DESCRIPTIONS.simple][]).map(
                ([mode, { label, desc, icon: Icon }]) => (
                  <button
                    key={mode}
                    className={clsx(styles.presetCard, config.presetMode === mode && styles.presetCardActive)}
                    onClick={() => applyPreset(mode)}
                  >
                    <div className={styles.presetCardHeader}>
                      <Icon size={16} />
                      <span>{label}</span>
                    </div>
                    <p className={styles.presetCardDesc}>{desc}</p>
                  </button>
                ),
              )}
            </div>
          </div>

          {/* ── Context Formatting ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Sparkles size={14} />
              <span>How memories appear in the story</span>
            </div>
            <div className={styles.formatterGrid}>
              {FORMATTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={clsx(styles.formatterOption, config.formatterMode === opt.value && styles.formatterOptionActive)}
                  onClick={() => updateConfig({ formatterMode: opt.value as any })}
                >
                  <div className={styles.formatterLabel}>{opt.label}</div>
                  <div className={styles.formatterDesc}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ── Sidecar AI Connection (Tier 2) ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Zap size={14} />
              <span>AI-assisted analysis</span>
            </div>
            <div className={styles.hintText}>
              Use a secondary LLM for deeper entity extraction, importance scoring, and memory consolidation.
              Without a connection, these features use fast heuristics (free, no API calls).
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>Connection</span>
              <select
                className={styles.selectInput}
                value={config.sidecar.connectionProfileId || ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  // When selecting a connection, auto-switch modes to sidecar.
                  // When clearing, switch back to heuristic.
                  updateConfig({
                    sidecar: { ...config.sidecar, connectionProfileId: id, model: null },
                    entityExtractionMode: id ? "sidecar" : "heuristic",
                    salienceScoringMode: id ? "sidecar" : "heuristic",
                    consolidation: { ...config.consolidation, useSidecar: !!id },
                  });
                  fetchModels(id);
                }}
              >
                <option value="">None (heuristic only)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.provider})</option>
                ))}
              </select>
            </div>
            {config.sidecar.connectionProfileId && (
              <>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Model</span>
                  {modelsLoading ? (
                    <span className={styles.infoValue}>Loading models...</span>
                  ) : sidecarModels.length > 0 ? (
                    <select
                      className={styles.selectInput}
                      value={config.sidecar.model || ""}
                      onChange={(e) => updateConfig({ sidecar: { ...config.sidecar, model: e.target.value || null } })}
                    >
                      <option value="">Use connection default</option>
                      {sidecarModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className={styles.textInput}
                      value={config.sidecar.model || ""}
                      onChange={(e) => updateConfig({ sidecar: { ...config.sidecar, model: e.target.value || null } })}
                      placeholder="e.g. gpt-4o-mini"
                      style={{ width: 180 }}
                    />
                  )}
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Temperature</span>
                  <input type="number" className={styles.numberInput} value={config.sidecar.temperature} min={0} max={2} step={0.05} onChange={(e) => updateConfig({ sidecar: { ...config.sidecar, temperature: parseFloat(e.target.value) || 0.1 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Top P</span>
                  <input type="number" className={styles.numberInput} value={config.sidecar.topP} min={0} max={1} step={0.05} onChange={(e) => updateConfig({ sidecar: { ...config.sidecar, topP: parseFloat(e.target.value) || 1.0 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Entity extraction</span>
                  <select className={styles.selectInput} value={config.entityExtractionMode} onChange={(e) => updateConfig({ entityExtractionMode: e.target.value as any })}>
                    <option value="heuristic">Heuristic (free)</option>
                    <option value="sidecar">AI-assisted</option>
                    <option value="off">Off</option>
                  </select>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Importance scoring</span>
                  <select className={styles.selectInput} value={config.salienceScoringMode} onChange={(e) => updateConfig({ salienceScoringMode: e.target.value as any })}>
                    <option value="heuristic">Heuristic (free)</option>
                    <option value="sidecar">AI-assisted</option>
                  </select>
                </div>
                <div className={styles.toggleRow}>
                  <Toggle.Checkbox
                    checked={config.consolidation.useSidecar}
                    onChange={(v) => updateConfig({ consolidation: { ...config.consolidation, useSidecar: v } })}
                    label="AI-written memory summaries"
                    hint="Consolidation summaries written by AI instead of extractive selection"
                  />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Chunks per request</span>
                  <input type="number" className={styles.numberInput} value={config.sidecar.chunkBatchSize ?? 5} min={1} max={20} step={1} onChange={(e) => updateConfig({ sidecar: { ...config.sidecar, chunkBatchSize: parseInt(e.target.value) || 5 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Parallel requests</span>
                  <input type="number" className={styles.numberInput} value={config.sidecar.rebuildConcurrency ?? 3} min={1} max={10} step={1} onChange={(e) => updateConfig({ sidecar: { ...config.sidecar, rebuildConcurrency: parseInt(e.target.value) || 3 } })} />
                </div>
                <div className={styles.hintText}>
                  Chunks per request: how many memory chunks to analyze in a single LLM call. Higher = fewer API calls but larger prompts.
                  Parallel requests: how many LLM calls to run simultaneously during rebuild.
                </div>
              </>
            )}
          </div>

          {/* ── Entity Whitelist ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Shield size={14} />
              <span>Protected terms</span>
            </div>
            <div className={styles.whitelistHint}>
              Words the entity extractor should never filter out. Use this for fantasy proper nouns that look like common words
              (e.g., "The Pale", "Binding", "Ash").
            </div>
            <div className={styles.whitelistInput}>
              <input
                type="text"
                value={whitelistInput}
                onChange={(e) => setWhitelistInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addWhitelistTerm()}
                placeholder="Type a term and press Enter..."
                className={styles.textInput}
              />
              <button onClick={addWhitelistTerm} className={styles.addBtn} disabled={!whitelistInput.trim()}>
                Add
              </button>
            </div>
            {config.entityWhitelist.length > 0 && (
              <div className={styles.whitelistTags}>
                {config.entityWhitelist.map((term) => (
                  <span key={term} className={styles.tag}>
                    {term}
                    <button onClick={() => removeWhitelistTerm(term)} className={styles.tagRemove}>&times;</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── Advanced Settings (collapsible) ── */}
          {isAdvanced && (
            <>
              <button className={styles.advancedToggle} onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>Advanced settings</span>
              </button>

              {showAdvanced && (
                <>
                  {/* Retrieval tuning */}
                  <div className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <Heart size={14} />
                      <span>Retrieval</span>
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.emotionalResonance} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, emotionalResonance: v } })} label="Emotional resonance" hint="Boost memories matching the current scene's emotional tone" />
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.diversitySelection} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, diversitySelection: v } })} label="Diversity selection" hint="Prevent multiple retrieved memories from the same time period" />
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.entityContextInjection} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, entityContextInjection: v } })} label="Entity snapshots" hint="Include character/location summaries in the prompt" />
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.relationshipInjection} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, relationshipInjection: v } })} label="Relationship edges" hint="Include character relationships in the prompt" />
                    </div>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Context token budget</span>
                      <input type="number" className={styles.numberInput} value={config.contextTokenBudget} min={100} max={2000} step={50} onChange={(e) => updateConfig({ contextTokenBudget: parseInt(e.target.value) || 600 })} />
                    </div>
                  </div>

                  {/* Decay */}
                  <div className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <Network size={14} />
                      <span>Memory decay</span>
                    </div>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Half-life (turns)</span>
                      <input type="number" className={styles.numberInput} value={config.decay.halfLifeTurns} min={100} max={5000} step={50} onChange={(e) => updateConfig({ decay: { ...config.decay, halfLifeTurns: parseInt(e.target.value) || 500 } })} />
                    </div>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Core memory threshold</span>
                      <input type="number" className={styles.numberInput} value={config.decay.coreMemoryThreshold} min={0} max={1} step={0.05} onChange={(e) => updateConfig({ decay: { ...config.decay, coreMemoryThreshold: parseFloat(e.target.value) || 0.7 } })} />
                    </div>
                    <div className={styles.hintText}>
                      Memories scoring above the threshold are "core memories" — they resist decay and never fully fade.
                    </div>
                  </div>

                  {/* Consolidation */}
                  <div className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <BookOpen size={14} />
                      <span>Consolidation</span>
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.consolidation.enabled} onChange={(v) => updateConfig({ consolidation: { ...config.consolidation, enabled: v } })} label="Enable memory consolidation" hint="Compress older memories into summaries. Reduces token usage for long campaigns." />
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Usage Stats ── */}
          {stats && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <BarChart3 size={14} />
                <span>Current chat stats</span>
                <div className={styles.sectionHeaderActions}>
                  <button className={styles.actionBtn} onClick={handleRebuild} disabled={rebuilding}>
                    <RefreshCw size={12} className={rebuilding ? styles.spinning : ""} />
                    {rebuilding
                      ? rebuildProgress
                        ? `${rebuildProgress.percent}% (${rebuildProgress.current}/${rebuildProgress.total})`
                        : "Starting..."
                      : "Rebuild"}
                  </button>
                </div>
              </div>
              <div className={styles.grid}>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Memory chunks</span>
                  <span className={styles.infoValue}>{stats.chunkCount} ({stats.vectorizedChunkCount} vectorized)</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Entities</span>
                  <span className={styles.infoValue}>{stats.activeEntityCount} active / {stats.entityCount} total</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Relations</span>
                  <span className={styles.infoValue}>{stats.relationCount}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Consolidations</span>
                  <span className={styles.infoValue}>{stats.consolidationCount}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Est. embedding calls</span>
                  <span className={styles.infoValue}>{stats.estimatedEmbeddingCalls}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
