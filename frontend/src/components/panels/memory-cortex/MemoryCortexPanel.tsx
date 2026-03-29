import { useState, useEffect, useCallback } from "react";
import {
  Brain, Users, Network, ChevronDown, ChevronRight, ChevronLeft, RefreshCw,
  MapPin, Swords, Package, Landmark, Lightbulb, Calendar,
  Heart, Shield, Zap, BookOpen, BarChart3, Search, ArrowRight,
  Palette, Trash2, AlertTriangle, FileQuestion, Clock,
} from "lucide-react";
import { useStore } from "@/store";
import { memoryCortexApi, type CortexEntity, type CortexRelation, type CortexUsageStats } from "@/api/memory-cortex";
import styles from "./MemoryCortexPanel.module.css";
import clsx from "clsx";

type ViewTab = "entities" | "colors" | "stats";

const ENTITY_ICONS: Record<string, typeof Brain> = {
  character: Users,
  location: MapPin,
  item: Package,
  faction: Landmark,
  concept: Lightbulb,
  event: Calendar,
};

const STATUS_COLORS: Record<string, string> = {
  active: "#4caf50",
  inactive: "var(--lumiverse-text-dim)",
  deceased: "#e53e3e",
  destroyed: "#e53e3e",
  unknown: "var(--lumiverse-text-muted)",
};

export default function MemoryCortexPanel() {
  const activeChatId = useStore((s) => s.activeChatId);
  const addToast = useStore((s) => s.addToast);

  const [tab, setTab] = useState<ViewTab>("entities");
  const [entities, setEntities] = useState<CortexEntity[]>([]);
  const [stats, setStats] = useState<CortexUsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const loadEntities = useCallback(async () => {
    if (!activeChatId) return;
    setLoading(true);
    try {
      const res = await memoryCortexApi.getEntities(activeChatId);
      setEntities(res.data);
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [activeChatId]);

  const loadStats = useCallback(async () => {
    if (!activeChatId) return;
    try {
      const s = await memoryCortexApi.getStats(activeChatId);
      setStats(s);
    } catch {
      // Non-fatal
    }
  }, [activeChatId]);

  useEffect(() => {
    loadEntities();
    loadStats();
  }, [loadEntities, loadStats]);

  const handleDeleteEntity = async (entityId: string) => {
    if (!activeChatId) return;
    try {
      await memoryCortexApi.deleteEntity(activeChatId, entityId);
      setEntities((prev) => prev.filter((e) => e.id !== entityId));
      addToast({ type: "info", message: "Entity removed" });
    } catch {
      addToast({ type: "error", message: "Failed to remove entity" });
    }
  };

  // Filter entities
  const filtered = entities.filter((e) => {
    if (typeFilter !== "all" && e.entityType !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return e.name.toLowerCase().includes(q) ||
        e.aliases.some((a) => a.toLowerCase().includes(q)) ||
        e.facts.some((f) => f.toLowerCase().includes(q));
    }
    return true;
  });

  const activeEntities = filtered.filter((e) => e.status !== "inactive");
  const archivedEntities = filtered.filter((e) => e.status === "inactive");

  // Get unique entity types for filter
  const entityTypes = [...new Set(entities.map((e) => e.entityType))];

  if (!activeChatId) {
    return (
      <div className={styles.empty}>
        <Brain size={32} strokeWidth={1.5} />
        <p>Open a chat to view its memory graph</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Tab bar */}
      <div className={styles.tabBar}>
        <button className={clsx(styles.tab, tab === "entities" && styles.tabActive)} onClick={() => setTab("entities")}>
          <Users size={13} />
          Entities
          {entities.length > 0 && <span className={styles.tabBadge}>{activeEntities.length}</span>}
        </button>
        <button className={clsx(styles.tab, tab === "colors" && styles.tabActive)} onClick={() => setTab("colors")}>
          <Palette size={13} />
          Colors
        </button>
        <button className={clsx(styles.tab, tab === "stats" && styles.tabActive)} onClick={() => setTab("stats")}>
          <BarChart3 size={13} />
          Stats
        </button>
        <button className={styles.refreshBtn} onClick={() => { loadEntities(); loadStats(); }} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {tab === "entities" && (
        <>
          {/* Search + filter */}
          <div className={styles.searchBar}>
            <Search size={13} className={styles.searchIcon} />
            <input
              type="text"
              className={styles.searchInput}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search entities..."
            />
            {entityTypes.length > 1 && (
              <select
                className={styles.typeFilter}
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All</option>
                {entityTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}
          </div>

          {/* Entity list */}
          {loading ? (
            <div className={styles.loadingText}>Loading entities...</div>
          ) : activeEntities.length === 0 && archivedEntities.length === 0 ? (
            <div className={styles.emptyList}>
              <Lightbulb size={20} strokeWidth={1.5} />
              <p>No entities tracked yet</p>
              <span>Entities are extracted automatically as you chat</span>
            </div>
          ) : (
            <div className={styles.entityList}>
              {activeEntities.map((entity) => (
                <EntityCard
                  key={entity.id}
                  entity={entity}
                  expanded={expandedId === entity.id}
                  onToggle={() => setExpandedId(expandedId === entity.id ? null : entity.id)}
                  onDelete={() => handleDeleteEntity(entity.id)}
                />
              ))}
              {archivedEntities.length > 0 && (
                <div className={styles.archivedSection}>
                  <span className={styles.archivedLabel}>Archived ({archivedEntities.length})</span>
                  {archivedEntities.slice(0, 10).map((entity) => (
                    <EntityCard
                      key={entity.id}
                      entity={entity}
                      expanded={expandedId === entity.id}
                      onToggle={() => setExpandedId(expandedId === entity.id ? null : entity.id)}
                      onDelete={() => handleDeleteEntity(entity.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === "colors" && (
        <ColorsView chatId={activeChatId} addToast={addToast} />
      )}

      {tab === "stats" && (
        <StatsView stats={stats} chatId={activeChatId} />
      )}
    </div>
  );
}

// ─── Entity Card ───────────────────────────────────────────────

/** Format a timestamp as relative time ("2m ago", "3h ago", "5d ago") */
function relativeTime(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function EntityCard({
  entity,
  expanded,
  onToggle,
  onDelete,
}: {
  entity: CortexEntity;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const Icon = ENTITY_ICONS[entity.entityType] || Lightbulb;
  const statusColor = STATUS_COLORS[entity.status] || STATUS_COLORS.unknown;
  const isProvisional = entity.confidence === "provisional";

  // Top emotional tags
  const topEmotions = Object.entries(entity.emotionalValence || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([tag]) => tag);

  // Salience breakdown for mini bar
  const bd = entity.salienceBreakdown;
  const bdTotal = bd ? (bd.mentionComponent + bd.arcComponent + bd.graphComponent) || 1 : 0;

  // Fact extraction status indicator
  const needsFacts = entity.factExtractionStatus !== "ok" && entity.salienceAvg > 0.45;

  // Last seen
  const lastSeen = relativeTime(entity.lastMentionTimestamp ?? entity.lastSeenAt);

  return (
    <div className={clsx(
      styles.entityCard,
      entity.status === "inactive" && styles.entityCardArchived,
      isProvisional && styles.entityCardProvisional,
    )}>
      <div className={styles.entityHeader} role="button" tabIndex={0} onClick={onToggle}>
        <div className={styles.entityIcon}>
          <Icon size={14} />
        </div>
        <div className={styles.entityInfo}>
          <div className={styles.entityName}>
            {entity.name}
            <span className={styles.entityStatus} style={{ background: statusColor }} />
            {isProvisional && <span className={styles.provisionalBadge}>provisional</span>}
            {needsFacts && (
              <span className={clsx(styles.factStatusBadge, entity.factExtractionStatus === "never" ? styles.factStatusNever : styles.factStatusEmpty)} title={entity.factExtractionStatus === "never" ? "No facts extracted yet" : "Fact extraction found nothing — will retry"}>
                <FileQuestion size={9} />
                {entity.factExtractionStatus === "never" ? "no facts" : "retry"}
              </span>
            )}
          </div>
          <div className={styles.entityMeta}>
            {entity.entityType} &middot; {entity.mentionCount} mentions
            {lastSeen && <span className={styles.lastSeen}> &middot; {lastSeen}</span>}
            {entity.salienceAvg > 0 && (
              <span className={styles.salienceBadge} style={{
                opacity: 0.4 + entity.salienceAvg * 0.6,
              }}>
                {(entity.salienceAvg * 100).toFixed(0)}%
              </span>
            )}
            {bd && bdTotal > 0 && (
              <span className={styles.salienceBar} title={`Mention: ${(bd.mentionComponent * 100).toFixed(0)}% · Arc: ${(bd.arcComponent * 100).toFixed(0)}% · Graph: ${(bd.graphComponent * 100).toFixed(0)}%`}>
                <span className={clsx(styles.salienceBarSegment, styles.salienceBarMention)} style={{ width: `${(bd.mentionComponent / bdTotal) * 100}%` }} />
                <span className={clsx(styles.salienceBarSegment, styles.salienceBarArc)} style={{ width: `${(bd.arcComponent / bdTotal) * 100}%` }} />
                <span className={clsx(styles.salienceBarSegment, styles.salienceBarGraph)} style={{ width: `${(bd.graphComponent / bdTotal) * 100}%` }} />
              </span>
            )}
          </div>
        </div>
        <div className={styles.chevron}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>

      {expanded && (
        <div className={styles.entityBody}>
          {/* Show the latest mention excerpt — the actual chunk text, not a stale description */}
          {((entity as any).latestExcerpt || entity.description) && (
            <p className={styles.entityDescription}>
              {((entity as any).latestExcerpt || entity.description)
                .replace(/^\.*\s*\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/i, "")
                .replace(/^\.{3}\s*/, "")
                .replace(/\s*\.{3}$/, "")
                .trim() || null}
            </p>
          )}

          {entity.aliases.length > 0 && (
            <div className={styles.entityField}>
              <span className={styles.fieldLabel}>Aliases</span>
              <div className={styles.tagRow}>
                {entity.aliases.map((a) => (
                  <span key={a} className={styles.miniTag}>{a}</span>
                ))}
              </div>
            </div>
          )}

          {entity.facts.length > 0 && (
            <div className={styles.entityField}>
              <span className={styles.fieldLabel}>Facts</span>
              <ul className={styles.factList}>
                {entity.facts.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {topEmotions.length > 0 && (
            <div className={styles.entityField}>
              <span className={styles.fieldLabel}>Emotional profile</span>
              <div className={styles.tagRow}>
                {topEmotions.map((tag) => (
                  <span key={tag} className={styles.emotionTag}>{tag}</span>
                ))}
              </div>
            </div>
          )}

          {/* Salience breakdown detail when expanded */}
          {bd && bd.total > 0 && (
            <div className={styles.entityField}>
              <span className={styles.fieldLabel}>Salience breakdown</span>
              <div className={styles.tagRow}>
                <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, var(--lumiverse-primary) 30%, transparent)" }}>
                  Mention {(bd.mentionComponent * 100).toFixed(0)}%
                </span>
                <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, #8b5cf6 30%, transparent)" }}>
                  Arc {(bd.arcComponent * 100).toFixed(0)}%
                </span>
                <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, #06b6d4 30%, transparent)" }}>
                  Graph {(bd.graphComponent * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )}

          <div className={styles.entityActions}>
            <button className={styles.dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete(); }}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Colors View ───────────────────────────────────────────────

function ColorsView({ chatId, addToast }: { chatId: string; addToast: (t: any) => void }) {
  const [colors, setColors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await memoryCortexApi.getColors(chatId);
      setColors(res.data);
    } catch {
      setColors([]);
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    try {
      await memoryCortexApi.deleteColor(chatId, id);
      setColors((prev) => prev.filter((c) => c.id !== id));
      addToast({ type: "info", message: "Color attribution removed" });
    } catch {
      addToast({ type: "error", message: "Failed to remove" });
    }
  };

  if (loading) return <div className={styles.loadingText}>Loading color map...</div>;

  if (colors.length === 0) {
    return (
      <div className={styles.emptyList}>
        <Palette size={20} strokeWidth={1.5} />
        <p>No font colors detected yet</p>
        <span>Colors are extracted from font tags in chat messages as you play</span>
      </div>
    );
  }

  // Group by entity
  const byEntity = new Map<string, any[]>();
  const unattributed: any[] = [];
  for (const c of colors) {
    if (c.entityName) {
      const list = byEntity.get(c.entityName) || [];
      list.push(c);
      byEntity.set(c.entityName, list);
    } else {
      unattributed.push(c);
    }
  }

  return (
    <div className={styles.entityList}>
      {[...byEntity.entries()].map(([name, entries]) => (
        <div key={name} className={styles.colorGroup}>
          <div className={styles.colorGroupHeader}>{name}</div>
          {entries.map((c) => (
            <div key={c.id} className={styles.colorRow}>
              <span className={styles.colorSwatch} style={{ background: c.hexColor }} />
              <span className={styles.colorHex}>{c.hexColor}</span>
              <span className={styles.colorUsage}>{c.usageType}</span>
              <span className={styles.colorConfidence}>{(c.confidence * 100).toFixed(0)}%</span>
              <button className={styles.colorDeleteBtn} onClick={() => handleDelete(c.id)} title="Remove">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          {entries[0]?.sampleExcerpt && (
            <div className={styles.colorSample}>
              {entries[0].sampleExcerpt.slice(0, 100)}
            </div>
          )}
        </div>
      ))}
      {unattributed.length > 0 && (
        <div className={styles.colorGroup}>
          <div className={styles.colorGroupHeader} style={{ opacity: 0.6 }}>Unattributed</div>
          {unattributed.map((c) => (
            <div key={c.id} className={styles.colorRow}>
              <span className={styles.colorSwatch} style={{ background: c.hexColor }} />
              <span className={styles.colorHex}>{c.hexColor}</span>
              <span className={styles.colorUsage}>{c.usageType}</span>
              <span className={styles.colorConfidence}>{(c.confidence * 100).toFixed(0)}%</span>
              <button className={styles.colorDeleteBtn} onClick={() => handleDelete(c.id)} title="Remove">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stats View with Drill-Down ────────────────────────────────

type DrillTarget = "chunks" | "entities" | "relations" | "consolidations" | "salience" | null;

function StatsView({ stats, chatId }: { stats: CortexUsageStats | null; chatId: string }) {
  const [drill, setDrill] = useState<DrillTarget>(null);
  const [drillData, setDrillData] = useState<any[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);

  const openDrill = async (target: DrillTarget) => {
    if (!target) return;
    setDrill(target);
    setDrillLoading(true);
    setDrillData([]);
    try {
      let res: { data: any[] };
      switch (target) {
        case "chunks": res = await memoryCortexApi.getChunks(chatId, 30); break;
        case "entities": res = await memoryCortexApi.getEntities(chatId); break;
        case "relations": res = await memoryCortexApi.getRelations(chatId); break;
        case "consolidations": res = await memoryCortexApi.getConsolidations(chatId); break;
        case "salience": res = await memoryCortexApi.getSalience(chatId, 30); break;
        default: res = { data: [] };
      }
      setDrillData(res.data);
    } catch {
      setDrillData([]);
    } finally {
      setDrillLoading(false);
    }
  };

  if (!stats) return <div className={styles.loadingText}>Loading stats...</div>;

  // Drill-down view
  if (drill) {
    return (
      <div className={styles.drillView}>
        <button className={styles.drillBack} onClick={() => setDrill(null)}>
          <ChevronLeft size={14} />
          Back to stats
        </button>
        <div className={styles.drillTitle}>{drill.charAt(0).toUpperCase() + drill.slice(1)}</div>
        {drillLoading ? (
          <div className={styles.loadingText}>Loading records...</div>
        ) : drillData.length === 0 ? (
          <div className={styles.loadingText}>No records found</div>
        ) : (
          <div className={styles.drillList}>
            {drill === "chunks" && drillData.map((c: any) => (
              <DrillRecord key={c.id} lines={[
                { label: "Content", value: (c.content || "").slice(0, 200) + ((c.content || "").length > 200 ? "..." : "") },
                { label: "Tokens", value: c.token_count },
                { label: "Messages", value: c.message_count },
                { label: "Salience", value: c.salience_score != null ? `${(c.salience_score * 100).toFixed(0)}%` : "unscored" },
                { label: "Retrieved", value: c.retrieval_count ? `${c.retrieval_count}x` : "never" },
                { label: "Vectorized", value: c.vectorized_at ? "yes" : "pending" },
              ]} tags={c.emotional_tags ? JSON.parse(c.emotional_tags) : []} />
            ))}
            {drill === "relations" && drillData.map((r: CortexRelation) => (
              <RelationDrillRecord key={r.id} relation={r} />
            ))}
            {drill === "consolidations" && (() => {
              const arcs = drillData.filter((c: any) => c.tier === 2);
              const scenes = drillData.filter((c: any) => c.tier !== 2);
              return (
                <>
                  {arcs.length > 0 && (
                    <>
                      <div className={styles.drillSectionHeader}>Story Arcs</div>
                      {arcs.map((c: any) => (
                        <div key={c.id} className={styles.arcRecord}>
                          <div className={styles.arcHeader}>
                            <span className={styles.arcBadge}>Arc</span>
                            <span className={styles.arcTitle}>{c.title || "Arc Summary"}</span>
                          </div>
                          <div className={styles.arcSummary}>{c.summary || ""}</div>
                          <div className={styles.arcMeta}>
                            <span className={styles.arcMetaItem}><strong>Messages</strong> {c.messageRangeStart ?? "?"}–{c.messageRangeEnd ?? "?"}</span>
                            <span className={styles.arcMetaItem}><strong>Entities</strong> {(c.entityIds || []).length}</span>
                            <span className={styles.arcMetaItem}><strong>Salience</strong> {c.salienceAvg != null ? `${(c.salienceAvg * 100).toFixed(0)}%` : "—"}</span>
                          </div>
                          {(c.emotionalTags || []).length > 0 && (
                            <div className={styles.drillTags}>
                              {(c.emotionalTags || []).map((t: string) => (
                                <span key={t} className={styles.emotionTag}>{t}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                  {scenes.length > 0 && (
                    <>
                      {arcs.length > 0 && <div className={styles.drillSectionHeader}>Scene Summaries</div>}
                      {scenes.map((c: any) => (
                        <DrillRecord key={c.id} lines={[
                          { label: c.title || "Scene Summary", value: "" },
                          { label: "Summary", value: (c.summary || "").slice(0, 250) + ((c.summary || "").length > 250 ? "..." : "") },
                          { label: "Messages", value: `${c.messageRangeStart ?? "?"}–${c.messageRangeEnd ?? "?"}` },
                          { label: "Salience", value: c.salienceAvg != null ? `${(c.salienceAvg * 100).toFixed(0)}%` : "—" },
                        ]} tags={c.emotionalTags || []} />
                      ))}
                    </>
                  )}
                </>
              );
            })()}
            {drill === "salience" && drillData.map((s: any) => (
              <DrillRecord key={s.id} lines={[
                { label: "Score", value: `${(s.score * 100).toFixed(0)}%` },
                { label: "Source", value: s.score_source },
                { label: "Preview", value: (s.chunk_content || "").slice(0, 180) + ((s.chunk_content || "").length > 180 ? "..." : "") },
                { label: "Flags", value: (() => { try { return JSON.parse(s.narrative_flags || "[]").join(", ") || "none"; } catch { return "none"; } })() },
                { label: "Dialogue", value: s.has_dialogue ? "yes" : "no" },
                { label: "Words", value: s.word_count },
              ]} tags={(() => { try { return JSON.parse(s.emotional_tags || "[]"); } catch { return []; } })()} />
            ))}
            {drill === "entities" && drillData.map((e: CortexEntity) => (
              <DrillRecord key={e.id} lines={[
                { label: "Name", value: `${e.name}${e.confidence === "provisional" ? " (provisional)" : ""}` },
                { label: "Type", value: e.entityType },
                { label: "Status", value: e.status },
                { label: "Mentions", value: e.mentionCount },
                { label: "Salience", value: `${((e.salienceAvg ?? 0) * 100).toFixed(0)}%` },
                { label: "Facts", value: `${(e.facts || []).length}${e.factExtractionStatus === "never" ? " (needs extraction)" : e.factExtractionStatus === "attempted_empty" ? " (retry pending)" : ""}` },
                ...(e.lastMentionTimestamp ? [{ label: "Last seen", value: relativeTime(e.lastMentionTimestamp) || "—" }] : []),
              ]} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Stats overview
  return (
    <div className={styles.statsGrid}>
      <StatCard icon={Brain} label="Memory chunks" value={stats.chunkCount} sub={`${stats.vectorizedChunkCount} vectorized`} desc="Segments of conversation stored for recall." onClick={() => openDrill("chunks")} />
      <StatCard icon={Users} label="Entities" value={stats.activeEntityCount} sub={`${stats.entityCount - stats.activeEntityCount} archived`} desc="Characters, locations, items tracked." onClick={() => openDrill("entities")} />
      <StatCard icon={Network} label="Relations" value={stats.relationCount} desc="Connections between entities." onClick={() => openDrill("relations")} />
      <StatCard icon={BookOpen} label="Consolidations" value={stats.consolidationCount} desc="Compressed memory summaries." onClick={() => openDrill("consolidations")} />
      <StatCard icon={Zap} label="Embedding calls" value={stats.estimatedEmbeddingCalls} sub="estimated total" desc="API calls used for vectorization." />
      <StatCard icon={Heart} label="Salience records" value={stats.salienceRecordCount} desc="Chunks scored for importance." onClick={() => openDrill("salience")} />
    </div>
  );
}

// ─── Stat Card ─────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  desc,
  onClick,
}: {
  icon: typeof Brain;
  label: string;
  value: number;
  sub?: string;
  desc?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={clsx(styles.statCard, onClick && styles.statCardClickable)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className={styles.statTop}>
        <div className={styles.statIcon}>
          <Icon size={16} strokeWidth={1.5} />
        </div>
        <div className={styles.statContent}>
          <div className={styles.statValue}>{value.toLocaleString()}</div>
          <div className={styles.statLabel}>{label}</div>
          {sub && <div className={styles.statSub}>{sub}</div>}
        </div>
        {onClick && <ArrowRight size={13} className={styles.statArrow} />}
      </div>
      {desc && <div className={styles.statDesc}>{desc}</div>}
    </div>
  );
}

// ─── Relation Drill Record ────────────────────────────────────

function RelationDrillRecord({ relation: r }: { relation: CortexRelation }) {
  const contradictionFlag = r.contradictionFlag ?? "none";
  const hasContradiction = contradictionFlag !== "none";
  const edgeSalience = r.edgeSalience ?? r.strength ?? 0;
  const sentimentRange = r.sentimentRange;
  const aliases = r.labelAliases ?? [];

  return (
    <div className={styles.drillRecord}>
      <div className={styles.drillLine}>
        <span className={styles.drillLineLabel}>Edge</span>
        <span className={styles.drillLineValue}>
          {r.sourceName || (r.sourceEntityId ?? "").slice(0, 8)} → {r.targetName || (r.targetEntityId ?? "").slice(0, 8)}
        </span>
      </div>
      <div className={styles.drillLine}>
        <span className={styles.drillLineLabel}>Type</span>
        <span className={styles.drillLineValue}>{r.relationType}</span>
      </div>
      <div className={styles.drillLine}>
        <span className={styles.drillLineLabel}>Label</span>
        <span className={styles.drillLineValue}>{r.relationLabel || "—"}</span>
      </div>
      <div className={styles.drillLine}>
        <span className={styles.drillLineLabel}>Strength</span>
        <span className={styles.drillLineValue}>{((r.strength ?? 0) * 100).toFixed(0)}%</span>
      </div>
      <div className={styles.drillLine}>
        <span className={styles.drillLineLabel}>Edge salience</span>
        <span className={styles.edgeSalienceBar}>
          <span className={styles.edgeSalienceTrack}>
            <span className={styles.edgeSalienceFill} style={{ width: `${Math.min(100, edgeSalience * 100)}%` }} />
          </span>
          <span className={styles.edgeSalienceLabel}>{(edgeSalience * 100).toFixed(0)}%</span>
        </span>
      </div>
      <div className={styles.drillLine}>
        <span className={styles.drillLineLabel}>Sentiment</span>
        <span className={styles.drillLineValue}>
          {(r.sentiment ?? 0) > 0 ? `+${(r.sentiment ?? 0).toFixed(2)}` : (r.sentiment ?? 0).toFixed(2)}
          {sentimentRange && (
            <span className={styles.sentimentRangeLabel}>
              {" "}[{sentimentRange[0].toFixed(1)}..{sentimentRange[1].toFixed(1)}]
            </span>
          )}
        </span>
      </div>
      <div className={styles.drillLine}>
        <span className={styles.drillLineLabel}>Evidence</span>
        <span className={styles.drillLineValue}>{(r.evidenceChunkIds || []).length} chunks</span>
      </div>
      {hasContradiction && (
        <div className={styles.relationMeta}>
          <span className={clsx(
            styles.contradictionBadge,
            contradictionFlag === "complex" && styles.contradictionComplex,
            contradictionFlag === "suspect" && styles.contradictionSuspect,
            contradictionFlag === "temporal" && styles.contradictionTemporal,
          )}>
            <AlertTriangle size={9} />
            {contradictionFlag}
          </span>
        </div>
      )}
      {aliases.length > 0 && (
        <div className={styles.relationMeta}>
          <span className={styles.drillLineLabel}>Also called</span>
          <div className={styles.labelAliasList}>
            {aliases.map((a, i) => (
              <span key={i} className={styles.labelAlias}>{a}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Drill-down Record ─────────────────────────────────────────

function DrillRecord({
  lines,
  tags,
}: {
  lines: Array<{ label: string; value: string | number }>;
  tags?: string[];
}) {
  return (
    <div className={styles.drillRecord}>
      {lines.map(({ label, value }, i) =>
        // Full-width content lines (previews/summaries)
        String(value).length > 60 ? (
          <div key={i} className={styles.drillContentLine}>
            <span className={styles.drillLineLabel}>{label}</span>
            <span className={styles.drillLineContent}>{value}</span>
          </div>
        ) : (
          <div key={i} className={styles.drillLine}>
            <span className={styles.drillLineLabel}>{label}</span>
            <span className={styles.drillLineValue}>{value}</span>
          </div>
        ),
      )}
      {tags && tags.length > 0 && (
        <div className={styles.drillTags}>
          {tags.map((t: string) => (
            <span key={t} className={styles.emotionTag}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}
