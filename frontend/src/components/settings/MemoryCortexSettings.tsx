import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Brain,
  Sparkles,
  Users,
  Network,
  Activity,
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
  MessageSquareQuote,
} from "lucide-react";
import { Toggle } from "@/components/shared/Toggle";
import NumericInput from "@/components/shared/NumericInput";
import { useStore } from "@/store";
import { memoryCortexApi, type CortexConfig, type CortexUsageStats } from "@/api/memory-cortex";
import { fetchConnectionModels } from "@/api/connectionModels";
import ModelCombobox from "@/components/panels/connection-manager/ModelCombobox";
import ConnectionSelect from "@/components/shared/ConnectionSelect";
import { getReasoningBindingSummary } from "@/lib/reasoning-binding";
import { wsClient } from "@/ws/client";
import { EventType } from "@/ws/events";
import styles from "./MemoryCortexSettings.module.css";
import clsx from "clsx";

type PresetMode = "simple" | "standard" | "advanced";
type EntityFilterType = "character" | "location" | "item" | "faction" | "concept" | "event";

const ENTITY_FILTER_TYPES: EntityFilterType[] = ["character", "location", "item", "faction", "concept", "event"];

const THOUGHT_MARKER_PRESETS = [
  { label: "<think>", prefix: "<think>\n", suffix: "\n</think>" },
  { label: "<thinking>", prefix: "<thinking>\n", suffix: "\n</thinking>" },
  { label: "<reasoning>", prefix: "<reasoning>\n", suffix: "\n</reasoning>" },
];

function formatRebuildStatusLine(
  t: TFunction<"settings">,
  progress: {
    phase?: string;
    inFlightBatches?: number;
    lastProviderRequestAt?: number | null;
    lastProviderResponseMs?: number | null;
  },
  fallback: string,
): string {
  const parts: string[] = [];
  if (progress.phase) {
    parts.push(t(`memoryCortex.rebuildPhase.${progress.phase}`, { defaultValue: progress.phase }));
  }
  if (typeof progress.inFlightBatches === "number" && progress.inFlightBatches > 0) {
    parts.push(t("memoryCortex.rebuildBatchesInFlight", { count: progress.inFlightBatches }));
  }
  if (progress.lastProviderRequestAt) {
    const seconds = Math.max(0, Math.round((Date.now() - progress.lastProviderRequestAt) / 1000));
    parts.push(t("memoryCortex.rebuildLastRequest", { seconds }));
  }
  if (typeof progress.lastProviderResponseMs === "number") {
    parts.push(t("memoryCortex.rebuildLastResponse", {
      seconds: (progress.lastProviderResponseMs / 1000).toFixed(1),
    }));
  }
  return parts.join(" · ") || fallback;
}

export default function MemoryCortexSettings() {
  const { t } = useTranslation("settings");
  const addToast = useStore((s) => s.addToast);
  const openModal = useStore((s) => s.openModal);

  const presetDescriptions = useMemo((): Record<PresetMode, { label: string; desc: string; icon: typeof Zap }> => ({
    simple: {
      label: t("memoryCortex.presetSimple"),
      desc: t("memoryCortex.presetSimpleDesc"),
      icon: Zap,
    },
    standard: {
      label: t("memoryCortex.presetStandard"),
      desc: t("memoryCortex.presetStandardDesc"),
      icon: BookOpen,
    },
    advanced: {
      label: t("memoryCortex.presetAdvanced"),
      desc: t("memoryCortex.presetAdvancedDesc"),
      icon: Settings2,
    },
  }), [t]);

  const formatterOptions = useMemo(() => [
    { value: "shadow" as const, label: t("memoryCortex.formatterShadow"), desc: t("memoryCortex.formatterShadowDesc") },
    { value: "attributed" as const, label: t("memoryCortex.formatterAttributed"), desc: t("memoryCortex.formatterAttributedDesc") },
    { value: "clinical" as const, label: t("memoryCortex.formatterClinical"), desc: t("memoryCortex.formatterClinicalDesc") },
    { value: "minimal" as const, label: t("memoryCortex.formatterMinimal"), desc: t("memoryCortex.formatterMinimalDesc") },
  ], [t]);

  const entityFilterLabel = useCallback((type: EntityFilterType) => t(`memoryCortex.entity.${type}`), [t]);

  const [config, setConfig] = useState<CortexConfig | null>(null);
  const [stats, setStats] = useState<CortexUsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<{
    current: number;
    total: number;
    percent: number;
    phase?: string;
    inFlightBatches?: number;
    lastProviderRequestAt?: number | null;
    lastProviderResponseMs?: number | null;
  } | null>(null);
  // Wall-clock "now" tick driving the "X seconds ago" subtext so it updates
  // while a long LLM call is mid-flight even without new WS events.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!rebuilding) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [rebuilding]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [whitelistInput, setWhitelistInput] = useState("");
  const [scaffoldInput, setScaffoldInput] = useState("");

  // Connection profiles for sidecar picker
  const profiles = useStore((s) => s.profiles);
  const [sidecarModels, setSidecarModels] = useState<string[]>([]);
  const [sidecarModelLabels, setSidecarModelLabels] = useState<Record<string, string>>({});
  const [modelsLoading, setModelsLoading] = useState(false);

  // Active chat for stats (if available)
  const activeChatId = useStore((s) => s.activeChatId);

  const activeThoughtPreset = THOUGHT_MARKER_PRESETS.find(
    (preset) => preset.prefix === config?.thoughtMarkers.prefix && preset.suffix === config?.thoughtMarkers.suffix,
  );
  const selectedSidecarProfile = profiles.find((p) => p.id === config?.sidecar?.connectionProfileId) || null;
  const sidecarReasoningBinding = selectedSidecarProfile?.metadata?.reasoningBindings?.settings;

  const handleOpenDiagnostics = useCallback(() => {
    openModal("memoryCortexDiagnostics", { chatId: activeChatId || null });
  }, [activeChatId, openModal]);

  // Fetch models when sidecar connection changes
  const fetchModels = useCallback(async (connectionId: string | null) => {
    if (!connectionId) {
      setSidecarModels([]);
      setSidecarModelLabels({});
      return;
    }
    setModelsLoading(true);
    try {
      const result = await fetchConnectionModels('llm', connectionId);
      setSidecarModels(result.models);
      setSidecarModelLabels(result.labels);
    } catch {
      setSidecarModels([]);
      setSidecarModelLabels({});
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
      addToast({ type: "error", message: t("memoryCortex.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [addToast, t]);

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
          phase: (status as any).phase,
          inFlightBatches: (status as any).inFlightBatches,
          lastProviderRequestAt: (status as any).lastProviderRequestAt,
          lastProviderResponseMs: (status as any).lastProviderResponseMs,
        });
      } else if (status.status === "complete") {
        // Silently refresh stats — the WS event handles the live toast notification.
        // Showing a toast here would fire every time the panel opens (stale "complete" state).
        loadStats();
      }
    }).catch(() => { /* non-fatal */ });
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for rebuild progress via WebSocket
  useEffect(() => {
    const unsub = wsClient.on(EventType.CORTEX_REBUILD_PROGRESS, (payload: any) => {
      if (!payload || payload.chatId !== activeChatId) return;
      if (payload.status === "processing") {
        setRebuildProgress({
          current: payload.current,
          total: payload.total,
          percent: payload.percent,
          phase: payload.phase,
          inFlightBatches: payload.inFlightBatches,
          lastProviderRequestAt: payload.lastProviderRequestAt,
          lastProviderResponseMs: payload.lastProviderResponseMs,
        });
      } else if (payload.status === "complete") {
        setRebuilding(false);
        setRebuildProgress(null);
        addToast({
          type: "success",
          message: t("memoryCortex.rebuildComplete", {
            chunks: payload.chunksProcessed,
            entities: payload.entitiesFound,
            relations: payload.relationsFound,
          }),
        });
        loadStats();
      } else if (payload.status === "error") {
        setRebuilding(false);
        setRebuildProgress(null);
        addToast({ type: "error", message: payload.error || t("memoryCortex.rebuildFailed") });
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
      addToast({ type: "error", message: t("memoryCortex.saveFailed") });
    }
  };

  const updateThoughtMarkers = useCallback((patch: Partial<CortexConfig["thoughtMarkers"]>) => {
    if (!config) return;
    updateConfig({
      thoughtMarkers: {
        ...config.thoughtMarkers,
        ...patch,
      },
    });
  }, [config]);

  const applyPreset = async (mode: PresetMode) => {
    try {
      const updated = await memoryCortexApi.applyPreset(mode);
      setConfig(updated);
      setShowAdvanced(mode === "advanced");
      const presetLabels: Record<PresetMode, string> = {
        simple: t("memoryCortex.presetSimple"),
        standard: t("memoryCortex.presetStandard"),
        advanced: t("memoryCortex.presetAdvanced"),
      };
      addToast({
        type: "success",
        message: t("memoryCortex.presetApplied", { mode: presetLabels[mode] }),
      });
    } catch {
      addToast({ type: "error", message: t("memoryCortex.presetFailed") });
    }
  };

  const handleRebuild = async () => {
    if (!activeChatId) {
      addToast({ type: "warning", message: t("memoryCortex.openChatFirst") });
      return;
    }
    setRebuilding(true);
    setRebuildProgress(null);
    try {
      await memoryCortexApi.rebuild(activeChatId);
      // Response is immediate ({ status: "started" }). Progress comes via WS.
    } catch (err: any) {
      setRebuilding(false);
      addToast({ type: "error", message: err.message || t("memoryCortex.rebuildStartFailed") });
    }
  };

  const addWhitelistTerm = () => {
    const term = whitelistInput.trim();
    if (!term || !config) return;
    if (config.entityWhitelist.includes(term)) {
      addToast({ type: "warning", message: t("memoryCortex.whitelistAlready", { term }) });
      return;
    }
    updateConfig({ entityWhitelist: [...config.entityWhitelist, term] });
    setWhitelistInput("");
  };

  const removeWhitelistTerm = (term: string) => {
    if (!config) return;
    updateConfig({ entityWhitelist: config.entityWhitelist.filter((t) => t !== term) });
  };

  const addScaffoldTag = () => {
    if (!config) return;
    const tag = scaffoldInput.trim().toLowerCase().replace(/^<|>$|\//g, "");
    if (!tag || !/^[a-z0-9_]+$/.test(tag)) {
      addToast({ type: "warning", message: t("memoryCortex.invalidTag") });
      return;
    }
    const existing = config.nonProseScaffoldTags ?? [];
    if (existing.includes(tag)) {
      addToast({ type: "warning", message: t("memoryCortex.scaffoldAlready", { tag }) });
      return;
    }
    updateConfig({ nonProseScaffoldTags: [...existing, tag] });
    setScaffoldInput("");
  };

  const removeScaffoldTag = (tag: string) => {
    if (!config) return;
    updateConfig({ nonProseScaffoldTags: (config.nonProseScaffoldTags ?? []).filter((t) => t !== tag) });
  };

  const parseFilterLines = (value: string) => value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const updateEntityFilter = (
    type: EntityFilterType,
    field: "protectedTerms" | "rejectedTerms" | "cleanupPatterns",
    value: string,
  ) => {
    if (!config) return;
    updateConfig({
      entityExtractionFilters: {
        ...config.entityExtractionFilters,
        [type]: {
          ...config.entityExtractionFilters[type],
          [field]: parseFilterLines(value),
        },
      },
    });
  };

  if (loading || !config) {
    return <div className={styles.container}><div className={styles.loadingText}>{t("memoryCortex.loading")}</div></div>;
  }

  const isAdvanced = config.presetMode === "advanced" || showAdvanced;

  return (
    <div className={styles.container}>
      {/* ── Master Toggle ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Brain size={14} />
          <span>{t("memoryCortex.title")}</span>
          <div className={styles.sectionHeaderActions}>
            <button type="button" className={styles.actionBtn} onClick={handleOpenDiagnostics}>
              <Activity size={12} />
              {t("memoryCortex.diagnostics")}
            </button>
            <span className={clsx(styles.statusDot, config.enabled ? styles.statusActive : styles.statusInactive)} />
            <span className={styles.statusLabel}>{config.enabled ? t("memoryCortex.active") : t("memoryCortex.off")}</span>
          </div>
        </div>
        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={config.enabled}
            onChange={(v) => updateConfig({ enabled: v })}
            label={t("memoryCortex.enable")}
            hint={t("memoryCortex.enableHint")}
          />
        </div>
        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={config.autoWarmup}
            onChange={(v) => updateConfig({ autoWarmup: v })}
            label={t("memoryCortex.warmup")}
            hint={t("memoryCortex.warmupHint")}
          />
        </div>
      </div>

      {!config.enabled ? (
        <div className={styles.disabledNotice}>
          <p>{t("memoryCortex.disabledNotice1")}</p>
          <p>{t("memoryCortex.disabledNotice2")}</p>
        </div>
      ) : (
        <>
          {/* ── Preset Selector ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Gauge size={14} />
              <span>{t("memoryCortex.mode")}</span>
            </div>
            <div className={styles.presetGrid}>
              {(Object.entries(presetDescriptions) as [PresetMode, typeof presetDescriptions.simple][]).map(
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
              <span>{t("memoryCortex.formattingSection")}</span>
            </div>
            <div className={styles.toggleRow}>
              <Toggle.Checkbox
                checked={config.useChatMemoryFormatting}
                onChange={(v) => updateConfig({ useChatMemoryFormatting: v })}
                label={t("memoryCortex.useLtmFormatting")}
                hint={t("memoryCortex.useLtmFormattingHint")}
              />
            </div>
            <div className={styles.formatterGrid}>
              {formatterOptions.map((opt) => (
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

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <MessageSquareQuote size={14} />
              <span>{t("memoryCortex.thoughtMarkers")}</span>
            </div>
            <div className={styles.hintText}>
              {t("memoryCortex.thoughtMarkersHint")}
            </div>
            <div className={styles.presetRow}>
              {THOUGHT_MARKER_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={clsx(styles.presetBtn, activeThoughtPreset?.label === preset.label && styles.presetBtnActive)}
                  onClick={() => updateThoughtMarkers({ prefix: preset.prefix, suffix: preset.suffix })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className={styles.markerGrid}>
              <label className={styles.markerField}>
                <span className={styles.markerLabel}>{t("memoryCortex.thoughtPrefix")}</span>
                <textarea
                  className={styles.textareaInput}
                  value={config.thoughtMarkers.prefix}
                  onChange={(e) => updateThoughtMarkers({ prefix: e.target.value })}
                  placeholder="<think>"
                  rows={3}
                />
              </label>
              <label className={styles.markerField}>
                <span className={styles.markerLabel}>{t("memoryCortex.thoughtSuffix")}</span>
                <textarea
                  className={styles.textareaInput}
                  value={config.thoughtMarkers.suffix}
                  onChange={(e) => updateThoughtMarkers({ suffix: e.target.value })}
                  placeholder="</think>"
                  rows={3}
                />
              </label>
            </div>
          </div>

          {/* ── Sidecar AI Connection (Tier 2) ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Zap size={14} />
              <span>{t("memoryCortex.sidecarTitle")}</span>
            </div>
            <div className={styles.hintText}>
              {t("memoryCortex.sidecarHint")}
            </div>
            {config.sidecar.connectionProfileId && (
              <div className={styles.hintText}>
                {sidecarReasoningBinding
                  ? t("memoryCortex.sidecarReasoningBound", { summary: getReasoningBindingSummary(sidecarReasoningBinding) })
                  : t("memoryCortex.sidecarReasoningGlobal")}
              </div>
            )}
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>{t("memoryCortex.connection")}</span>
              <ConnectionSelect
                kind="llm"
                value={config.sidecar.connectionProfileId || ""}
                onChange={(value) => {
                  const id = value || null;
                  // When selecting a connection, auto-switch modes to sidecar and
                  // seed the model override from the connection's default. When
                  // clearing, switch back to heuristic.
                  const defaultModel = id ? (profiles.find((p) => p.id === id)?.model || null) : null;
                  updateConfig({
                    sidecar: { ...config.sidecar, connectionProfileId: id, model: defaultModel },
                    entityExtractionMode: id ? "sidecar" : "heuristic",
                    salienceScoringMode: id ? "sidecar" : "heuristic",
                    consolidation: { ...config.consolidation, useSidecar: !!id },
                  });
                  fetchModels(id);
                }}
                clearable
                clearLabel={t("memoryCortex.connectionNone")}
                placeholder={t("memoryCortex.connectionNone")}
                ariaLabel={t("memoryCortex.connection")}
              />
            </div>
            {config.sidecar.connectionProfileId && (
              <>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.modelOverride")}</span>
                  <div className={styles.modelPicker}>
                    <ModelCombobox
                      value={config.sidecar.model || ""}
                      onChange={(value) => updateConfig({ sidecar: { ...config.sidecar, model: value || null } })}
                      models={sidecarModels}
                      modelLabels={sidecarModelLabels}
                      loading={modelsLoading}
                      onRefresh={() => fetchModels(config.sidecar.connectionProfileId)}
                      autoRefreshOnFocus
                      refreshKey={config.sidecar.connectionProfileId || ""}
                      placeholder={t("memoryCortex.modelPlaceholder")}
                      emptyMessage={t("memoryCortex.noModels")}
                      browseHint={t("memoryCortex.modelBrowseHint")}
                    />
                  </div>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.temperature")}</span>
                  <NumericInput className={styles.numberInput} value={config.sidecar.temperature} min={0} max={2} step={0.05} onChange={(value) => updateConfig({ sidecar: { ...config.sidecar, temperature: value ?? 0.1 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.topP")}</span>
                  <NumericInput className={styles.numberInput} value={config.sidecar.topP} min={0} max={1} step={0.05} onChange={(value) => updateConfig({ sidecar: { ...config.sidecar, topP: value ?? 1.0 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.maxOutputTokens")}</span>
                  <NumericInput
                    className={styles.numberInput}
                    value={config.sidecar.maxTokens ?? 4096}
                    min={512}
                    max={65536}
                    step={256}
                    integer
                    onChange={(value) => updateConfig({ sidecar: { ...config.sidecar, maxTokens: value ?? 4096 } })}
                  />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.entityExtraction")}</span>
                  <select className={styles.selectInput} value={config.entityExtractionMode} onChange={(e) => updateConfig({ entityExtractionMode: e.target.value as any })}>
                    <option value="heuristic">{t("memoryCortex.modeHeuristic")}</option>
                    <option value="sidecar">{t("memoryCortex.modeSidecar")}</option>
                    <option value="off">{t("memoryCortex.modeOff")}</option>
                  </select>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.importanceScoring")}</span>
                  <select className={styles.selectInput} value={config.salienceScoringMode} onChange={(e) => updateConfig({ salienceScoringMode: e.target.value as any })}>
                    <option value="heuristic">{t("memoryCortex.modeHeuristic")}</option>
                    <option value="sidecar">{t("memoryCortex.modeSidecar")}</option>
                  </select>
                </div>
                <div className={styles.toggleRow}>
                  <Toggle.Checkbox
                    checked={config.consolidation.useSidecar}
                    onChange={(v) => updateConfig({ consolidation: { ...config.consolidation, useSidecar: v } })}
                    label={t("memoryCortex.aiSummaries")}
                    hint={t("memoryCortex.aiSummariesHint")}
                  />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.chunksPerRequest")}</span>
                  <NumericInput className={styles.numberInput} value={config.sidecar.chunkBatchSize ?? 5} min={1} max={20} step={1} integer onChange={(value) => updateConfig({ sidecar: { ...config.sidecar, chunkBatchSize: value ?? 5 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.parallelRequests")}</span>
                  <NumericInput className={styles.numberInput} value={config.sidecar.rebuildConcurrency ?? 3} min={1} max={10} step={1} integer onChange={(value) => updateConfig({ sidecar: { ...config.sidecar, rebuildConcurrency: value ?? 3 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.rpmLimit")}</span>
                  <NumericInput className={styles.numberInput} value={config.sidecar.requestsPerMinute ?? 0} min={0} max={600} step={1} integer onChange={(value) => updateConfig({ sidecar: { ...config.sidecar, requestsPerMinute: value ?? 0 } })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.sidecarTimeout")}</span>
                  <NumericInput className={styles.numberInput} value={Math.round((config.sidecarTimeoutMs ?? 60000) / 1000)} min={0} max={300} step={5} integer onChange={(value) => updateConfig({ sidecarTimeoutMs: (value ?? 60) * 1000 })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.retrievalTimeout")}</span>
                  <NumericInput className={styles.numberInput} value={Math.round((config.retrievalTimeoutMs ?? 60000) / 1000)} min={0} max={300} step={5} integer onChange={(value) => updateConfig({ retrievalTimeoutMs: (value ?? 60) * 1000 })} />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.onSidecarFailure")}</span>
                  <select
                    className={styles.selectInput}
                    value={config.sidecarReliability?.fallback ?? "heuristic"}
                    onChange={(e) => updateConfig({
                      sidecarReliability: {
                        ...config.sidecarReliability,
                        fallback: e.target.value as "heuristic" | "skip",
                      },
                    })}
                  >
                    <option value="heuristic">{t("memoryCortex.fallbackHeuristic")}</option>
                    <option value="skip">{t("memoryCortex.fallbackSkip")}</option>
                  </select>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.retryAttempts")}</span>
                  <NumericInput
                    className={styles.numberInput}
                    value={config.sidecarReliability?.maxRetries ?? 0}
                    min={0}
                    max={10}
                    step={1}
                    integer
                    onChange={(value) => updateConfig({
                      sidecarReliability: { ...config.sidecarReliability, maxRetries: value ?? 0 },
                    })}
                  />
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.retryDelay")}</span>
                  <NumericInput
                    className={styles.numberInput}
                    value={config.sidecarReliability?.retryDelayMs ?? 500}
                    min={0}
                    max={10000}
                    step={100}
                    integer
                    onChange={(value) => updateConfig({
                      sidecarReliability: { ...config.sidecarReliability, retryDelayMs: value ?? 500 },
                    })}
                  />
                </div>
                <div className={styles.toggleRow}>
                  <Toggle.Checkbox
                    checked={config.sidecarReliability?.arbitratesHeuristics ?? false}
                    onChange={(v) => updateConfig({
                      sidecarReliability: { ...config.sidecarReliability, arbitratesHeuristics: v },
                    })}
                    label={t("memoryCortex.arbitratesHeuristics")}
                    hint={t("memoryCortex.arbitratesHeuristicsHint")}
                  />
                </div>
                <div className={styles.toggleRow}>
                  <Toggle.Checkbox
                    checked={config.sidecarReliability?.gradesExistingRecords ?? false}
                    onChange={(v) => updateConfig({
                      sidecarReliability: { ...config.sidecarReliability, gradesExistingRecords: v },
                    })}
                    label={t("memoryCortex.pruneGraph")}
                    hint={t("memoryCortex.pruneGraphHint")}
                  />
                </div>
                <div className={styles.hintText}>
                  {t("memoryCortex.sidecarLongHint")}
                </div>
              </>
            )}
          </div>

          {/* ── Entity Whitelist ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Shield size={14} />
              <span>{t("memoryCortex.whitelist")}</span>
            </div>
            <div className={styles.whitelistHint}>
              {t("memoryCortex.whitelistHint")}
            </div>
            <div className={styles.whitelistInput}>
              <input
                type="text"
                value={whitelistInput}
                onChange={(e) => setWhitelistInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addWhitelistTerm()}
                placeholder={t("memoryCortex.whitelistPlaceholder")}
                className={styles.textInput}
              />
              <button onClick={addWhitelistTerm} className={styles.addBtn} disabled={!whitelistInput.trim()}>
                {t("memoryCortex.add")}
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

          {/* ── Non-prose Scaffold Tags ── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Shield size={14} />
              <span>{t("memoryCortex.scaffoldTags")}</span>
            </div>
            <div className={styles.whitelistHint}>
              {t("memoryCortex.scaffoldHint")}
            </div>
            <div className={styles.whitelistInput}>
              <input
                type="text"
                value={scaffoldInput}
                onChange={(e) => setScaffoldInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addScaffoldTag()}
                placeholder={t("memoryCortex.scaffoldPlaceholder")}
                className={styles.textInput}
              />
              <button onClick={addScaffoldTag} className={styles.addBtn} disabled={!scaffoldInput.trim()}>
                {t("memoryCortex.add")}
              </button>
            </div>
            {(config.nonProseScaffoldTags ?? []).length > 0 && (
              <div className={styles.whitelistTags}>
                {(config.nonProseScaffoldTags ?? []).map((tag) => (
                  <span key={tag} className={styles.tag}>
                    &lt;{tag}&gt;
                    <button onClick={() => removeScaffoldTag(tag)} className={styles.tagRemove}>&times;</button>
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
                <span>{t("memoryCortex.advancedSettings")}</span>
              </button>

              {showAdvanced && (
                <>
                  {/* Retrieval tuning */}
                  <div className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <Heart size={14} />
                      <span>{t("memoryCortex.retrieval")}</span>
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.emotionalResonance} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, emotionalResonance: v } })} label={t("memoryCortex.emotionalResonance")} hint={t("memoryCortex.emotionalResonanceHint")} />
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.diversitySelection} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, diversitySelection: v } })} label={t("memoryCortex.diversitySelection")} hint={t("memoryCortex.diversitySelectionHint")} />
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.entityContextInjection} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, entityContextInjection: v } })} label={t("memoryCortex.entitySnapshots")} hint={t("memoryCortex.entitySnapshotsHint")} />
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.retrieval.relationshipInjection} onChange={(v) => updateConfig({ retrieval: { ...config.retrieval, relationshipInjection: v } })} label={t("memoryCortex.relationshipEdges")} hint={t("memoryCortex.relationshipEdgesHint")} />
                    </div>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>{t("memoryCortex.contextTokenBudget")}</span>
                      <NumericInput className={styles.numberInput} value={config.contextTokenBudget} min={100} max={2000} step={50} integer onChange={(value) => updateConfig({ contextTokenBudget: value ?? 600 })} />
                    </div>
                  </div>

                  {/* Decay */}
                  <div className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <Network size={14} />
                      <span>{t("memoryCortex.memoryDecay")}</span>
                    </div>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>{t("memoryCortex.halfLifeTurns")}</span>
                      <NumericInput className={styles.numberInput} value={config.decay.halfLifeTurns} min={100} max={5000} step={50} integer onChange={(value) => updateConfig({ decay: { ...config.decay, halfLifeTurns: value ?? 500 } })} />
                    </div>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>{t("memoryCortex.coreMemoryThreshold")}</span>
                      <NumericInput className={styles.numberInput} value={config.decay.coreMemoryThreshold} min={0} max={1} step={0.05} onChange={(value) => updateConfig({ decay: { ...config.decay, coreMemoryThreshold: value ?? 0.7 } })} />
                    </div>
                    <div className={styles.hintText}>
                      {t("memoryCortex.coreMemoryHint")}
                    </div>
                  </div>

                  {/* Consolidation */}
                  <div className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <BookOpen size={14} />
                      <span>{t("memoryCortex.consolidation")}</span>
                    </div>
                    <div className={styles.toggleRow}>
                      <Toggle.Checkbox checked={config.consolidation.enabled} onChange={(v) => updateConfig({ consolidation: { ...config.consolidation, enabled: v } })} label={t("memoryCortex.enableConsolidation")} hint={t("memoryCortex.enableConsolidationHint")} />
                    </div>
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <Shield size={14} />
                      <span>{t("memoryCortex.entityFilters")}</span>
                    </div>
                    <div className={styles.whitelistHint}>
                      {t("memoryCortex.entityFiltersHint")}
                    </div>
                    {ENTITY_FILTER_TYPES.map((type) => {
                      const rules = config.entityExtractionFilters[type];
                      return (
                        <div key={type} className={styles.filterGroup}>
                          <div className={styles.filterGroupHeader}>{entityFilterLabel(type)}</div>
                          <div className={styles.filterGrid}>
                            <label className={styles.filterField}>
                              <span>{t("memoryCortex.protectedTerms")}</span>
                              <textarea
                                key={`${type}-protected-${rules.protectedTerms.join("\n")}`}
                                defaultValue={rules.protectedTerms.join("\n")}
                                onBlur={(e) => updateEntityFilter(type, "protectedTerms", e.target.value)}
                                className={styles.textareaInput}
                                placeholder={t("memoryCortex.filterPlaceholderLine")}
                              />
                            </label>
                            <label className={styles.filterField}>
                              <span>{t("memoryCortex.rejectedTerms")}</span>
                              <textarea
                                key={`${type}-rejected-${rules.rejectedTerms.join("\n")}`}
                                defaultValue={rules.rejectedTerms.join("\n")}
                                onBlur={(e) => updateEntityFilter(type, "rejectedTerms", e.target.value)}
                                className={styles.textareaInput}
                                placeholder={t("memoryCortex.filterPlaceholderLine")}
                              />
                            </label>
                            <label className={styles.filterField}>
                              <span>{t("memoryCortex.cleanupRegexes")}</span>
                              <textarea
                                key={`${type}-cleanup-${rules.cleanupPatterns.join("\n")}`}
                                defaultValue={rules.cleanupPatterns.join("\n")}
                                onBlur={(e) => updateEntityFilter(type, "cleanupPatterns", e.target.value)}
                                className={styles.textareaInput}
                                placeholder={t("memoryCortex.filterPlaceholderRegex")}
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })}
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
                <span>{t("memoryCortex.chatStats")}</span>
                <div className={styles.sectionHeaderActions}>
                  <button className={styles.actionBtn} onClick={handleRebuild} disabled={rebuilding}>
                    <RefreshCw size={12} className={rebuilding ? styles.spinning : ""} />
                    {rebuilding
                      ? rebuildProgress
                        ? `${rebuildProgress.percent}% (${rebuildProgress.current}/${rebuildProgress.total})`
                        : t("memoryCortex.rebuildStarting")
                      : t("memoryCortex.rebuild")}
                  </button>
                </div>
              </div>
              {rebuilding && rebuildProgress && (
                <div className={styles.hintText}>
                  {formatRebuildStatusLine(t, rebuildProgress, t("memoryCortex.working"))}
                </div>
              )}
              <div className={styles.grid}>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.memoryChunks")}</span>
                  <span className={styles.infoValue}>{t("memoryCortex.memoryChunksValue", { chunks: stats.chunkCount, vectorized: stats.vectorizedChunkCount })}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.entities")}</span>
                  <span className={styles.infoValue}>{t("memoryCortex.entitiesValue", { active: stats.activeEntityCount, total: stats.entityCount })}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.relations")}</span>
                  <span className={styles.infoValue}>{stats.relationCount}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.consolidations")}</span>
                  <span className={styles.infoValue}>{stats.consolidationCount}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.estEmbeddingCalls")}</span>
                  <span className={styles.infoValue}>{stats.estimatedEmbeddingCalls}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.lastIngestion")}</span>
                  <span className={styles.infoValue}>
                    {stats.ingestionTelemetry.last
                      ? t("memoryCortex.lastIngestionValue", {
                        ms: Math.round(stats.ingestionTelemetry.last.totalMs),
                        mode: stats.ingestionTelemetry.last.mode,
                      })
                      : t("memoryCortex.noSamples")}
                  </span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>{t("memoryCortex.avgIngestion")}</span>
                  <span className={styles.infoValue}>
                    {stats.ingestionTelemetry.samples > 0
                      ? t("memoryCortex.avgIngestionValue", {
                        ms: Math.round(stats.ingestionTelemetry.averages.totalMs),
                        count: stats.ingestionTelemetry.samples,
                      })
                      : t("memoryCortex.noSamples")}
                  </span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
