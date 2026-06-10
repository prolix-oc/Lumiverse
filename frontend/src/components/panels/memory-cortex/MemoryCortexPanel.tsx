import { useState, useEffect, useCallback, type KeyboardEvent } from "react";
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/lib/formatRelativeTime'

import {
  Brain, Users, Network, ChevronDown, ChevronRight, ChevronLeft, RefreshCw,
  MapPin, Swords, Package, Landmark, Lightbulb, Calendar,
  Heart, Shield, Zap, BookOpen, BarChart3, Search, ArrowRight,
  Palette, Trash2, AlertTriangle, FileQuestion, Clock, Link2,
  Edit2, CheckCircle2, Plus,
} from "lucide-react";
import { useStore } from "@/store";
import { memoryCortexApi, type CortexEntity, type CortexFontColor, type CortexRelation, type CortexUsageStats } from "@/api/memory-cortex";
import ConfirmationModal from "@/components/shared/ConfirmationModal";
import CortexLinksTab from "./CortexLinksTab";
import { EntityEditorModal, RelationEditorModal, RelationCreatorModal, ColorEditorModal } from "./MemoryCortexEditors";
import styles from "./MemoryCortexPanel.module.css";
import clsx from "clsx";

type ViewTab = "entities" | "colors" | "stats" | "links";

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
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')

  const activeChatId = useStore((s) => s.activeChatId);
  const totalChatLength = useStore((s) => s.totalChatLength);
  const addToast = useStore((s) => s.addToast);

  const [tab, setTab] = useState<ViewTab>("entities");
  const [entities, setEntities] = useState<CortexEntity[]>([]);
  const [stats, setStats] = useState<CortexUsageStats | null>(null);
  // Start in the loading state: the fetch is kicked off by an effect that runs
  // after first paint, so initializing to false would paint the empty state
  // ("No entities yet") for one frame before loading begins — a visible flash.
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [editingEntity, setEditingEntity] = useState<CortexEntity | null>(null);
  const [deleteEntityTarget, setDeleteEntityTarget] = useState<CortexEntity | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  // Reset read-state when the active chat changes — DURING render, not in an
  // effect. An effect runs after paint, so it can't stop the previous chat's
  // entities/stats (and the count badge) from flashing for a frame before the
  // refetch lands. React's "adjust state on prior-render change" pattern
  // re-renders synchronously with the cleared state before committing.
  const [loadedChatId, setLoadedChatId] = useState<string | null>(activeChatId);
  if (activeChatId !== loadedChatId) {
    setLoadedChatId(activeChatId);
    setEntities([]);
    setStats(null);
    setLoading(true);
    setExpandedId(null);
    setSelectionMode(false);
    setSelectedEntityIds(new Set());
    setDeleteEntityTarget(null);
    setConfirmBulkDelete(false);
  }

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
      setSelectedEntityIds((prev) => {
        if (!prev.has(entityId)) return prev;
        const next = new Set(prev);
        next.delete(entityId);
        return next;
      });
      addToast({ type: "info", message: t('memoryCortexPanel.toast.entityRemoved') });
    } catch {
      addToast({ type: "error", message: t('memoryCortexPanel.toast.entityRemoveFailed') });
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
  const visibleArchivedEntities = archivedEntities.slice(0, 10);
  const visibleEntityIds = [...activeEntities, ...visibleArchivedEntities].map((e) => e.id);
  const selectedCount = selectedEntityIds.size;

  const toggleEntitySelection = (entityId: string) => {
    setSelectedEntityIds((prev) => {
      const next = new Set(prev);
      if (next.has(entityId)) next.delete(entityId);
      else next.add(entityId);
      return next;
    });
  };

  const selectVisibleEntities = () => {
    setSelectionMode(true);
    setSelectedEntityIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleEntityIds) next.add(id);
      return next;
    });
  };

  const clearEntitySelection = () => {
    setSelectedEntityIds(new Set());
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    clearEntitySelection();
  };

  const handleBulkDeleteEntities = async () => {
    if (!activeChatId || selectedEntityIds.size === 0 || bulkDeleting) return;
    const ids = [...selectedEntityIds];
    setConfirmBulkDelete(false);
    setBulkDeleting(true);
    try {
      const res = await memoryCortexApi.bulkDeleteEntities(activeChatId, ids);
      const deletedIds = new Set(ids);
      setEntities((prev) => prev.filter((e) => !deletedIds.has(e.id)));
      setSelectedEntityIds(new Set());
      setSelectionMode(false);
      setExpandedId((prev) => prev && deletedIds.has(prev) ? null : prev);
      await loadStats();
      addToast({ type: "info", message: t('memoryCortexPanel.toast.bulkRemoved', { count: res.deletedCount }) });
    } catch {
      addToast({ type: "error", message: t('memoryCortexPanel.toast.bulkRemoveFailed') });
    } finally {
      setBulkDeleting(false);
    }
  };

  // Get unique entity types for filter
  const entityTypes = [...new Set(entities.map((e) => e.entityType))];
  const showLowActivityNotice = totalChatLength > 0 && totalChatLength < 6;

  if (!activeChatId) {
    return (
      <div className={styles.empty}>
        <Brain size={32} strokeWidth={1.5} />
        <p>{t('memoryCortexPanel.noChat')}</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Tab bar */}
      <div className={styles.tabBar}>
        <button className={clsx(styles.tab, tab === "entities" && styles.tabActive)} onClick={() => setTab("entities")}>
          <Users size={13} />
          {t('memoryCortexPanel.tabs.entities')}
          {entities.length > 0 && <span className={styles.tabBadge}>{activeEntities.length}</span>}
        </button>
        <button className={clsx(styles.tab, tab === "colors" && styles.tabActive)} onClick={() => setTab("colors")}>
          <Palette size={13} />
          {t('memoryCortexPanel.tabs.colors')}
        </button>
        <button className={clsx(styles.tab, tab === "stats" && styles.tabActive)} onClick={() => setTab("stats")}>
          <BarChart3 size={13} />
          {t('memoryCortexPanel.tabs.stats')}
        </button>
        <button className={clsx(styles.tab, tab === "links" && styles.tabActive)} onClick={() => setTab("links")}>
          <Link2 size={13} />
          {t('memoryCortexPanel.tabs.links')}
        </button>
        <button className={styles.refreshBtn} onClick={() => { loadEntities(); loadStats(); }} title={tc('actions.refresh')}>
          <RefreshCw size={13} />
        </button>
      </div>

      {showLowActivityNotice && (
        <div className={styles.noticeBanner}>
          <AlertTriangle size={14} className={styles.noticeIcon} />
          <div>
            <div className={styles.noticeTitle}>{t('memoryCortexPanel.warmupTitle')}</div>
            <p className={styles.noticeText}>
              {t('memoryCortexPanel.warmupText', { count: totalChatLength })}
            </p>
          </div>
        </div>
      )}

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
              placeholder={t('memoryCortexPanel.searchPlaceholder')}
            />
            {entityTypes.length > 1 && (
              <select
                className={styles.typeFilter}
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">{t('memoryCortexPanel.filterAll')}</option>
                {entityTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}
            <button
              className={clsx(styles.selectionModeBtn, selectionMode && styles.selectionModeBtnActive)}
              onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
              type="button"
            >
              {selectionMode ? t('memoryCortexPanel.done') : t('memoryCortexPanel.select')}
            </button>
          </div>

          {selectionMode && (
            <div className={styles.selectionToolbar}>
              <span className={styles.selectionCount}>{t('memoryCortexPanel.selectedCount', { count: selectedCount })}</span>
              <button className={styles.selectionToolbarBtn} onClick={selectVisibleEntities} type="button">
                {t('memoryCortexPanel.selectVisible')}
              </button>
              <button className={styles.selectionToolbarBtn} onClick={clearEntitySelection} disabled={selectedCount === 0} type="button">
                {t('memoryCortexPanel.clear')}
              </button>
              <button
                className={styles.selectionToolbarDanger}
                onClick={() => setConfirmBulkDelete(true)}
                disabled={selectedCount === 0 || bulkDeleting}
                type="button"
              >
                {bulkDeleting ? t('memoryCortexPanel.removing') : t('memoryCortexPanel.removeSelected')}
              </button>
            </div>
          )}

          {/* Entity list */}
          {loading ? (
            <div className={styles.loadingText}>{t('memoryCortexPanel.loadingEntities')}</div>
          ) : activeEntities.length === 0 && archivedEntities.length === 0 ? (
            <div className={styles.emptyList}>
              <Lightbulb size={20} strokeWidth={1.5} />
              <p>{t('memoryCortexPanel.emptyEntitiesTitle')}</p>
              <span>{t('memoryCortexPanel.emptyEntitiesHint')}</span>
            </div>
          ) : (
            <div className={styles.entityList}>
              {activeEntities.map((entity) => (
                <EntityCard
                  key={entity.id}
                  entity={entity}
                  expanded={expandedId === entity.id}
                  onToggle={() => setExpandedId(expandedId === entity.id ? null : entity.id)}
                  onDelete={() => setDeleteEntityTarget(entity)}
                  onEdit={() => setEditingEntity(entity)}
                  selectionMode={selectionMode}
                  selected={selectedEntityIds.has(entity.id)}
                  onSelect={() => toggleEntitySelection(entity.id)}
                />
              ))}
              {archivedEntities.length > 0 && (
                <div className={styles.archivedSection}>
                  <span className={styles.archivedLabel}>{t('memoryCortexPanel.archived', { count: archivedEntities.length })}</span>
                  {visibleArchivedEntities.map((entity) => (
                    <EntityCard
                      key={entity.id}
                      entity={entity}
                      expanded={expandedId === entity.id}
                      onToggle={() => setExpandedId(expandedId === entity.id ? null : entity.id)}
                      onDelete={() => setDeleteEntityTarget(entity)}
                      onEdit={() => setEditingEntity(entity)}
                      selectionMode={selectionMode}
                      selected={selectedEntityIds.has(entity.id)}
                      onSelect={() => toggleEntitySelection(entity.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === "colors" && (
        <ColorsView chatId={activeChatId} addToast={addToast} entities={entities} />
      )}

      {tab === "stats" && (
        <StatsView stats={stats} chatId={activeChatId} entities={entities} addToast={addToast} />
      )}

      {tab === "links" && (
        <CortexLinksTab activeChatId={activeChatId} />
      )}

      {editingEntity && (
        <EntityEditorModal
          chatId={activeChatId}
          entity={editingEntity}
          onClose={() => setEditingEntity(null)}
          onSaved={() => { setEditingEntity(null); loadEntities(); }}
        />
      )}

      {deleteEntityTarget && (
        <ConfirmationModal
          isOpen={true}
          title={t('memoryCortexPanel.confirm.entityTitle')}
          message={t('memoryCortexPanel.confirm.entityMessage', { name: deleteEntityTarget.name })}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => {
            const id = deleteEntityTarget.id;
            setDeleteEntityTarget(null);
            void handleDeleteEntity(id);
          }}
          onCancel={() => setDeleteEntityTarget(null)}
        />
      )}

      {confirmBulkDelete && (
        <ConfirmationModal
          isOpen={true}
          title={t('memoryCortexPanel.confirm.bulkTitle')}
          message={t('memoryCortexPanel.confirm.bulkMessage', { count: selectedCount })}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => { void handleBulkDeleteEntities() }}
          onCancel={() => setConfirmBulkDelete(false)}
        />
      )}
    </div>
  );
}

// ─── Entity Card ───────────────────────────────────────────────

function EntityCard({
  entity,
  expanded,
  onToggle,
  onDelete,
  onEdit,
  selectionMode,
  selected,
  onSelect,
}: {
  entity: CortexEntity;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  selectionMode: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('panels')
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
  const bdTotal = bd ? (bd.mentionComponent + bd.arcComponent + bd.graphComponent + (bd.frequencyFloor ?? 0)) || 1 : 0;

  // Fact extraction status indicator
  const needsFacts = entity.factExtractionStatus !== "ok" && entity.salienceAvg > 0.45;

  const lastSeenTs = entity.lastMentionTimestamp ?? entity.lastSeenAt
  const lastSeen = lastSeenTs ? formatRelativeTime(lastSeenTs) : null

  // Blurb shown in the expanded card body. A user-edited entity surfaces its
  // curated description — the manual edit must win. Otherwise we keep the
  // original behaviour: prefer the freshest mention excerpt over the
  // auto-backfilled (first-mention) description. Each side falls back to the
  // other so the line is never blank.
  const rawBlurb = entity.userEditedAt
    ? (entity.description || entity.latestExcerpt)
    : (entity.latestExcerpt || entity.description);
  const blurb = (rawBlurb || "")
    .replace(/^\.*\s*\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/i, "")
    .replace(/^\.{3}\s*/, "")
    .replace(/\s*\.{3}$/, "")
    .trim();
  const handleHeaderClick = () => {
    if (selectionMode) onSelect();
    else onToggle();
  };

  const handleHeaderKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    handleHeaderClick();
  };

  return (
    <div className={clsx(
      styles.entityCard,
      entity.status === "inactive" && styles.entityCardArchived,
      isProvisional && styles.entityCardProvisional,
      selected && styles.entityCardSelected,
    )}>
      <div className={styles.entityHeader} role="button" tabIndex={0} onClick={handleHeaderClick} onKeyDown={handleHeaderKeyDown}>
        {selectionMode && (
          <input
            className={styles.entitySelectCheckbox}
            type="checkbox"
            checked={selected}
            onChange={onSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('memoryCortexPanel.entity.selectAria', { name: entity.name })}
          />
        )}
        <div className={styles.entityIcon}>
          <Icon size={14} />
        </div>
        <div className={styles.entityInfo}>
          <div className={styles.entityName}>
            {entity.name}
            <span className={styles.entityStatus} style={{ background: statusColor }} />
            {isProvisional && <span className={styles.provisionalBadge}>{t('memoryCortexPanel.entity.provisional')}</span>}
            {entity.userEditedAt !== null && (
              <span className={styles.curatedBadge} title={t('memoryCortexPanel.entity.curatedTitle')}>
                <CheckCircle2 size={9} /> {t('memoryCortexPanel.entity.curated')}
              </span>
            )}
            {needsFacts && (
              <span className={clsx(styles.factStatusBadge, entity.factExtractionStatus === "never" ? styles.factStatusNever : styles.factStatusEmpty)} title={entity.factExtractionStatus === "never" ? t('memoryCortexPanel.entity.noFactsTitle') : t('memoryCortexPanel.entity.retryFactsTitle')}>
                <FileQuestion size={9} />
                {entity.factExtractionStatus === "never" ? t('memoryCortexPanel.entity.noFacts') : t('memoryCortexPanel.entity.retry')}
              </span>
            )}
          </div>
          <div className={styles.entityMeta}>
            {entity.entityType} &middot; {t('memoryCortexPanel.entity.mentions', { count: entity.mentionCount })}
            {lastSeen && <span className={styles.lastSeen}> &middot; {lastSeen}</span>}
            {entity.salienceAvg > 0 && (
              <span className={styles.salienceBadge} style={{
                opacity: 0.4 + entity.salienceAvg * 0.6,
              }} title={[
                `Salience: ${(entity.salienceAvg * 100).toFixed(0)}%`,
                bd ? `Mention: ${(bd.mentionComponent * 100).toFixed(0)}%` : null,
                bd ? `Arc: ${(bd.arcComponent * 100).toFixed(0)}%` : null,
                bd ? `Graph: ${(bd.graphComponent * 100).toFixed(0)}%` : null,
                bd?.frequencyFloor ? `Floor: ${(bd.frequencyFloor * 100).toFixed(0)}%` : null,
                entity.saliencePeak > 0 ? `Peak: ${(entity.saliencePeak * 100).toFixed(0)}%` : null,
              ].filter(Boolean).join("\n")}>
                {(entity.salienceAvg * 100).toFixed(0)}%
              </span>
            )}
            {bd && bdTotal > 0 && (
              <span className={styles.salienceBar} title={`${t('memoryCortexPanel.entity.salienceTooltip', {
                mention: (bd.mentionComponent * 100).toFixed(0),
                arc: (bd.arcComponent * 100).toFixed(0),
                graph: (bd.graphComponent * 100).toFixed(0),
              })}${bd.frequencyFloor ? ` · ${t('memoryCortexPanel.entity.salienceFloor', { floor: (bd.frequencyFloor * 100).toFixed(0) })}` : ""}`}>

                <span className={clsx(styles.salienceBarSegment, styles.salienceBarMention)} style={{ width: `${(bd.mentionComponent / bdTotal) * 100}%` }} />
                <span className={clsx(styles.salienceBarSegment, styles.salienceBarArc)} style={{ width: `${(bd.arcComponent / bdTotal) * 100}%` }} />
                <span className={clsx(styles.salienceBarSegment, styles.salienceBarGraph)} style={{ width: `${(bd.graphComponent / bdTotal) * 100}%` }} />
                {(bd.frequencyFloor ?? 0) > 0 && (
                  <span className={clsx(styles.salienceBarSegment, styles.salienceBarFloor)} style={{ width: `${((bd.frequencyFloor ?? 0) / bdTotal) * 100}%` }} />
                )}
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
          {/* User edits win; otherwise show the latest mention excerpt (see `blurb` above). */}
          {blurb && (
            <p className={styles.entityDescription}>{blurb}</p>
          )}

          {entity.aliases.length > 0 && (
            <div className={styles.entityField}>
              <span className={styles.fieldLabel}>{t('memoryCortexPanel.entity.aliases')}</span>
              <div className={styles.tagRow}>
                {entity.aliases.map((a) => (
                  <span key={a} className={styles.miniTag}>{a}</span>
                ))}
              </div>
            </div>
          )}

          {entity.facts.length > 0 && (
            <div className={styles.entityField}>
              <span className={styles.fieldLabel}>{t('memoryCortexPanel.entity.facts')}</span>
              <ul className={styles.factList}>
                {entity.facts.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {topEmotions.length > 0 && (
            <div className={styles.entityField}>
              <span className={styles.fieldLabel}>{t('memoryCortexPanel.entity.emotionalProfile')}</span>
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
              <span className={styles.fieldLabel}>{t('memoryCortexPanel.entity.salienceBreakdown')}</span>
              <div className={styles.tagRow}>
                <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, var(--lumiverse-primary) 30%, transparent)" }}>
                  {t('memoryCortexPanel.entity.salienceMention', { percent: (bd.mentionComponent * 100).toFixed(0) })}
                </span>
                <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, #8b5cf6 30%, transparent)" }}>
                  {t('memoryCortexPanel.entity.salienceArc', { percent: (bd.arcComponent * 100).toFixed(0) })}
                </span>
                <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, #06b6d4 30%, transparent)" }}>
                  {t('memoryCortexPanel.entity.salienceGraph', { percent: (bd.graphComponent * 100).toFixed(0) })}
                </span>
                {(bd.frequencyFloor ?? 0) > 0 && (
                  <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, #f59e0b 30%, transparent)" }}>
                    Floor {((bd.frequencyFloor ?? 0) * 100).toFixed(0)}%
                  </span>
                )}
                {(entity.saliencePeak ?? 0) > 0 && (
                  <span className={styles.miniTag} style={{ borderColor: "color-mix(in srgb, #ef4444 30%, transparent)" }}>
                    Peak {((entity.saliencePeak ?? 0) * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          )}

          <div className={styles.entityActions}>
            <button className={styles.editBtn} onClick={(e) => { e.stopPropagation(); onEdit(); }}>
              <Edit2 size={12} /> {t('memoryCortexPanel.entity.edit')}
            </button>
            <button className={styles.dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete(); }}>
              {t('memoryCortexPanel.entity.remove')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Colors View ───────────────────────────────────────────────

function ColorsView({
  chatId,
  addToast,
  entities,
}: {
  chatId: string;
  addToast: (t: any) => void;
  entities: CortexEntity[];
}) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const [colors, setColors] = useState<CortexFontColor[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingColor, setEditingColor] = useState<CortexFontColor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CortexFontColor | null>(null);

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
    setDeleteTarget(null);
    try {
      await memoryCortexApi.deleteColor(chatId, id);
      setColors((prev) => prev.filter((c) => c.id !== id));
      addToast({ type: "info", message: t('memoryCortexPanel.colors.removed') });
    } catch {
      addToast({ type: "error", message: t('memoryCortexPanel.colors.removeFailed') });
    }
  };

  const handleReattribute = async (colorId: string, entityId: string | null) => {
    try {
      await memoryCortexApi.reattributeColor(chatId, colorId, entityId);
      addToast({ type: "success", message: entityId ? t('memoryCortexPanel.colors.reattributed') : t('memoryCortexPanel.colors.detached') });
      load();
    } catch (err: any) {
      addToast({ type: "error", message: t('memoryCortexPanel.colors.reattributeFailed', { error: err.message }) });
    }
  };

  if (loading) return <div className={styles.loadingText}>{t('memoryCortexPanel.colors.loading')}</div>;

  if (colors.length === 0) {
    return (
      <div className={styles.emptyList}>
        <Palette size={20} strokeWidth={1.5} />
        <p>{t('memoryCortexPanel.colors.emptyTitle')}</p>
        <span>{t('memoryCortexPanel.colors.emptyHint')}</span>
      </div>
    );
  }

  // Group by detected character name, with legacy entity-name fallback.
  const byCharacter = new Map<string, CortexFontColor[]>();
  const unattributed: CortexFontColor[] = [];
  for (const c of colors) {
    if (c.displayName) {
      const list = byCharacter.get(c.displayName) || [];
      list.push(c);
      byCharacter.set(c.displayName, list);
    } else {
      unattributed.push(c);
    }
  }

  const renderRow = (c: CortexFontColor) => (
    <div key={c.id} className={styles.colorRow}>
      <div className={styles.colorRowMain}>
        <span className={styles.colorSwatch} style={{ background: c.hexColor }} />
        <span className={styles.colorHex}>{c.hexColor}</span>
        <span className={styles.colorUsage}>{c.usageType.replace(/_/g, " ")}</span>
        <span className={styles.colorConfidence}>{(c.confidence * 100).toFixed(0)}%</span>
        <button className={styles.colorEditBtn} onClick={() => setEditingColor(c)} title={tc('actions.edit')}>
          <Edit2 size={11} />
        </button>
        <button className={styles.colorDeleteBtn} onClick={() => setDeleteTarget(c)} title={tc('actions.delete')}>
          <Trash2 size={11} />
        </button>
      </div>
      <div className={styles.colorRowReassign}>
        <span className={styles.colorRowReassignLabel}>{t('memoryCortexPanel.colors.reattributeLabel')}</span>
        <select
          className={styles.colorReattributeSelect}
          value={c.entityId ?? ""}
          onChange={(e) => handleReattribute(c.id, e.target.value || null)}
          disabled={entities.length === 0}
          title={entities.length === 0 ? t('memoryCortexPanel.colors.noEntitiesTitle') : t('memoryCortexPanel.colors.reattributeTitle')}
        >
          <option value="">{c.entityId ? t('memoryCortexPanel.colors.detach') : t('memoryCortexPanel.colors.pickEntity')}</option>
          {entities.map((ent) => (
            <option key={ent.id} value={ent.id}>{ent.name}</option>
          ))}
        </select>
      </div>
    </div>
  );

  return (
    <div className={styles.entityList}>
      {unattributed.length > 0 && (
        <div className={styles.colorGroup}>
          <div className={styles.colorGroupHeader} style={{ color: "#f59e0b" }}>
            <AlertTriangle size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
            {t('memoryCortexPanel.colors.unattributed', { count: unattributed.length })}
          </div>
          {unattributed.map(renderRow)}
        </div>
      )}
      {[...byCharacter.entries()].map(([name, entries]) => (
        <div key={name} className={styles.colorGroup}>
          <div className={styles.colorGroupHeader}>{name}</div>
          {entries.map(renderRow)}
          {entries[0]?.sampleExcerpt && (
            <div className={styles.colorSample}>
              {entries[0].sampleExcerpt.slice(0, 100)}
            </div>
          )}
        </div>
      ))}

      {deleteTarget && (
        <ConfirmationModal
          isOpen={true}
          title={t('memoryCortexPanel.colors.deleteConfirmTitle')}
          message={t('memoryCortexPanel.colors.deleteConfirmMessage', { hex: deleteTarget.hexColor })}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => { void handleDelete(deleteTarget.id) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editingColor && (
        <ColorEditorModal
          chatId={chatId}
          color={editingColor}
          entities={entities}
          onClose={() => setEditingColor(null)}
          onSaved={() => { setEditingColor(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Stats View with Drill-Down ────────────────────────────────

type DrillTarget = "chunks" | "entities" | "relations" | "consolidations" | "salience" | null;

function StatsView({
  stats,
  chatId,
  entities,
  addToast,
}: {
  stats: CortexUsageStats | null;
  chatId: string;
  entities: CortexEntity[];
  addToast: (t: any) => void;
}) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const dl = (key: string) => t(`memoryCortexPanel.stats.drillLabels.${key}`)
  const [drill, setDrill] = useState<DrillTarget>(null);
  const [drillData, setDrillData] = useState<any[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [editingRelation, setEditingRelation] = useState<CortexRelation | null>(null);
  const [creatingRelation, setCreatingRelation] = useState(false);
  const [deleteRelationId, setDeleteRelationId] = useState<string | null>(null);

  const reloadDrill = useCallback(async () => {
    if (!drill) return;
    setDrillLoading(true);
    try {
      let res: { data: any[] };
      switch (drill) {
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
  }, [drill, chatId]);

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

  const handleDeleteRelation = async (relationId: string) => {
    setDeleteRelationId(null);
    try {
      await memoryCortexApi.deleteRelation(chatId, relationId);
      addToast({ type: "success", message: t('memoryCortexPanel.stats.relationDeleted') });
      reloadDrill();
    } catch (err: any) {
      addToast({ type: "error", message: t('memoryCortexPanel.stats.deleteFailed', { error: err.message }) });
    }
  };

  if (!stats) return <div className={styles.loadingText}>{t('memoryCortexPanel.stats.loading')}</div>;

  // Drill-down view
  if (drill) {
    return (
      <div className={styles.drillView}>
        <button className={styles.drillBack} onClick={() => setDrill(null)}>
          <ChevronLeft size={14} />
          {t('memoryCortexPanel.stats.backToStats')}
        </button>
        <div className={styles.drillTitle}>
          {t(`memoryCortexPanel.stats.drill.${drill}`)}
          {drill === "relations" && entities.length >= 2 && (
            <button className={styles.addRelationBtn} onClick={() => setCreatingRelation(true)}>
              <Plus size={11} /> {t('memoryCortexPanel.stats.addRelation')}
            </button>
          )}
        </div>
        {drillLoading ? (
          <div className={styles.loadingText}>{t('memoryCortexPanel.stats.loadingRecords')}</div>
        ) : drillData.length === 0 ? (
          <div className={styles.loadingText}>{t('memoryCortexPanel.stats.noRecords')}</div>
        ) : (
          <div className={styles.drillList}>
            {drill === "chunks" && drillData.map((c: any) => (
              <DrillRecord key={c.id} lines={[
                { label: dl('content'), value: (c.content || "").slice(0, 200) + ((c.content || "").length > 200 ? "..." : "") },
                { label: dl('tokens'), value: c.token_count },
                { label: dl('messages'), value: c.message_count },
                { label: dl('salience'), value: c.salience_score != null ? `${(c.salience_score * 100).toFixed(0)}%` : dl('unscored') },
                { label: dl('retrieved'), value: c.retrieval_count ? `${c.retrieval_count}x` : dl('never') },
                { label: dl('vectorized'), value: c.vectorized_at ? dl('yes') : dl('pending') },
              ]} tags={c.emotional_tags ? JSON.parse(c.emotional_tags) : []} />
            ))}
            {drill === "relations" && drillData.map((r: CortexRelation) => (
              <RelationDrillRecord
                key={r.id}
                relation={r}
                onEdit={() => setEditingRelation(r)}
                onDelete={() => setDeleteRelationId(r.id)}
              />
            ))}
            {drill === "consolidations" && (() => {
              const arcs = drillData.filter((c: any) => c.tier === 2);
              const scenes = drillData.filter((c: any) => c.tier !== 2);
              return (
                <>
                  {arcs.length > 0 && (
                    <>
                      <div className={styles.drillSectionHeader}>{dl('storyArcs')}</div>
                      {arcs.map((c: any) => (
                        <div key={c.id} className={styles.arcRecord}>
                          <div className={styles.arcHeader}>
                            <span className={styles.arcBadge}>{dl('arc')}</span>
                            <span className={styles.arcTitle}>{c.title || dl('arcSummary')}</span>
                          </div>
                          <div className={styles.arcSummary}>{c.summary || ""}</div>
                          <div className={styles.arcMeta}>
                            <span className={styles.arcMetaItem}><strong>{dl('messages')}</strong> {c.messageRangeStart ?? "?"}–{c.messageRangeEnd ?? "?"}</span>
                            <span className={styles.arcMetaItem}><strong>{dl('entitiesCount')}</strong> {(c.entityIds || []).length}</span>
                            <span className={styles.arcMetaItem}><strong>{dl('salience')}</strong> {c.salienceAvg != null ? `${(c.salienceAvg * 100).toFixed(0)}%` : "—"}</span>
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
                      {arcs.length > 0 && <div className={styles.drillSectionHeader}>{dl('sceneSummaries')}</div>}
                      {scenes.map((c: any) => (
                        <DrillRecord key={c.id} lines={[
                          { label: c.title || dl('sceneSummary'), value: "" },
                          { label: dl('summary'), value: (c.summary || "").slice(0, 250) + ((c.summary || "").length > 250 ? "..." : "") },
                          { label: dl('messages'), value: `${c.messageRangeStart ?? "?"}–${c.messageRangeEnd ?? "?"}` },
                          { label: dl('salience'), value: c.salienceAvg != null ? `${(c.salienceAvg * 100).toFixed(0)}%` : "—" },
                        ]} tags={c.emotionalTags || []} />
                      ))}
                    </>
                  )}
                </>
              );
            })()}
            {drill === "salience" && drillData.map((s: any) => (
              <SalienceDrillRecord key={s.id} record={s} />
            ))}
            {drill === "entities" && drillData.map((e: CortexEntity) => (
              <DrillRecord key={e.id} lines={[
                { label: dl('name'), value: `${e.name}${e.confidence === "provisional" ? dl('provisional') : ""}` },
                { label: dl('type'), value: e.entityType },
                { label: dl('status'), value: e.status },
                { label: dl('mentions'), value: e.mentionCount },
                { label: dl('salience'), value: `${((e.salienceAvg ?? 0) * 100).toFixed(0)}%` },
                { label: dl('facts'), value: `${(e.facts || []).length}${e.factExtractionStatus === "never" ? dl('needsExtraction') : e.factExtractionStatus === "attempted_empty" ? dl('retryPending') : ""}` },
                ...(e.lastMentionTimestamp ? [{ label: dl('lastSeen'), value: formatRelativeTime(e.lastMentionTimestamp) }] : []),
              ]} />
            ))}
          </div>
        )}

        {editingRelation && (
          <RelationEditorModal
            chatId={chatId}
            relation={editingRelation}
            sourceName={editingRelation.sourceName}
            targetName={editingRelation.targetName}
            onClose={() => setEditingRelation(null)}
            onSaved={() => { setEditingRelation(null); reloadDrill(); }}
          />
        )}
        {creatingRelation && (
          <RelationCreatorModal
            chatId={chatId}
            entities={entities}
            onClose={() => setCreatingRelation(false)}
            onSaved={() => { setCreatingRelation(false); reloadDrill(); }}
          />
        )}
        {deleteRelationId && (
          <ConfirmationModal
            isOpen={true}
            title={t('memoryCortexPanel.stats.deleteRelationTitle')}
            message={t('memoryCortexPanel.stats.deleteRelationConfirm')}
            variant="danger"
            confirmText={tc('actions.delete')}
            onConfirm={() => { void handleDeleteRelation(deleteRelationId) }}
            onCancel={() => setDeleteRelationId(null)}
          />
        )}
      </div>
    );
  }

  // Stats overview
  return (
    <div className={styles.statsGrid}>
      <StatCard icon={Brain} label={t('memoryCortexPanel.stats.cards.chunks')} value={stats.chunkCount} sub={t('memoryCortexPanel.stats.cards.chunksSub', { count: stats.vectorizedChunkCount })} desc={t('memoryCortexPanel.stats.cards.chunksDesc')} onClick={() => openDrill("chunks")} />
      <StatCard icon={Users} label={t('memoryCortexPanel.stats.cards.entities')} value={stats.activeEntityCount} sub={t('memoryCortexPanel.stats.cards.entitiesSub', { count: stats.entityCount - stats.activeEntityCount })} desc={t('memoryCortexPanel.stats.cards.entitiesDesc')} onClick={() => openDrill("entities")} />
      <StatCard icon={Network} label={t('memoryCortexPanel.stats.cards.relations')} value={stats.relationCount} desc={t('memoryCortexPanel.stats.cards.relationsDesc')} onClick={() => openDrill("relations")} />
      <StatCard icon={BookOpen} label={t('memoryCortexPanel.stats.cards.consolidations')} value={stats.consolidationCount} desc={t('memoryCortexPanel.stats.cards.consolidationsDesc')} onClick={() => openDrill("consolidations")} />
      <StatCard icon={Zap} label={t('memoryCortexPanel.stats.cards.embeddingCalls')} value={stats.estimatedEmbeddingCalls} sub={t('memoryCortexPanel.stats.cards.embeddingSub')} desc={t('memoryCortexPanel.stats.cards.embeddingDesc')} />
      <StatCard icon={Heart} label={t('memoryCortexPanel.stats.cards.salienceRecords')} value={stats.salienceRecordCount} desc={t('memoryCortexPanel.stats.cards.salienceDesc')} onClick={() => openDrill("salience")} />
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

// ─── Emotion Tag Colors ──────────────────────────────────────

const EMOTION_COLORS: Record<string, string> = {
  grief: "#6366f1",
  joy: "#22c55e",
  tension: "#f59e0b",
  dread: "#7c3aed",
  intimacy: "#ec4899",
  betrayal: "#dc2626",
  revelation: "#06b6d4",
  resolve: "#0ea5e9",
  humor: "#84cc16",
  melancholy: "#8b5cf6",
  awe: "#a855f7",
  fury: "#ef4444",
};

const RELATION_TYPE_COLORS: Record<string, string> = {
  ally: "#22c55e",
  enemy: "#ef4444",
  rival: "#f59e0b",
  lover: "#ec4899",
  mentor: "#06b6d4",
  fears: "#7c3aed",
  serves: "#0ea5e9",
  parent: "#8b5cf6",
  child: "#a855f7",
  sibling: "#6366f1",
  member_of: "#14b8a6",
  located_in: "#64748b",
  owns: "#d97706",
  custom: "#94a3b8",
};

// ─── Salience Drill Record ────────────────────────────────────

function SalienceDrillRecord({ record: s }: { record: any }) {
  const { t } = useTranslation('panels')
  const score = s.score ?? 0;
  const preview = (s.chunk_content || "").slice(0, 200) + ((s.chunk_content || "").length > 200 ? "..." : "");
  const emotionalTags: string[] = (() => { try { return JSON.parse(s.emotional_tags || "[]"); } catch { return []; } })();
  const narrativeFlags: string[] = (() => { try { return JSON.parse(s.narrative_flags || "[]"); } catch { return []; } })();
  const scoreColor = score >= 0.7 ? "#22c55e" : score >= 0.4 ? "#f59e0b" : "#94a3b8";

  return (
    <div className={styles.drillRecord}>
      {/* Score header bar */}
      <div className={styles.salienceRecordHeader}>
        <div className={styles.salienceScoreSection}>
          <div className={styles.salienceScoreBar}>
            <div
              className={styles.salienceScoreFill}
              style={{ width: `${Math.min(100, score * 100)}%`, background: scoreColor }}
            />
          </div>
          <span className={styles.salienceScoreValue} style={{ color: scoreColor }}>
            {(score * 100).toFixed(0)}%
          </span>
        </div>
        <span className={clsx(
          styles.sourceBadge,
          s.score_source === "sidecar" && styles.sourceBadgeSidecar,
        )}>
          {s.score_source || t('memoryCortexPanel.stats.salience.heuristic')}
        </span>
      </div>

      <div className={styles.salienceSignals}>
        {s.has_dialogue ? <span className={styles.signalActive}>{t('memoryCortexPanel.stats.salience.dialogue')}</span> : <span className={styles.signalDim}>{t('memoryCortexPanel.stats.salience.noDialogue')}</span>}
        {s.has_action ? <span className={styles.signalActive}>{t('memoryCortexPanel.stats.salience.action')}</span> : null}
        {s.has_internal_thought ? <span className={styles.signalActive}>{t('memoryCortexPanel.stats.salience.thought')}</span> : null}
        <span className={styles.signalDim}>{t('memoryCortexPanel.stats.salience.words', { count: s.word_count })}</span>
      </div>

      {/* Emotional tags */}
      {emotionalTags.length > 0 && (
        <div className={styles.salienceTagSection}>
          {emotionalTags.map((tag) => (
            <span
              key={tag}
              className={styles.emotionTagColored}
              style={{
                borderColor: `color-mix(in srgb, ${EMOTION_COLORS[tag] || "var(--lumiverse-primary)"} 35%, transparent)`,
                background: `color-mix(in srgb, ${EMOTION_COLORS[tag] || "var(--lumiverse-primary)"} 10%, transparent)`,
                color: EMOTION_COLORS[tag] || "var(--lumiverse-primary)",
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Narrative flags */}
      {narrativeFlags.length > 0 && (
        <div className={styles.salienceTagSection}>
          {narrativeFlags.map((flag) => (
            <span key={flag} className={styles.narrativeFlagTag}>
              {flag.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div className={styles.saliencePreview}>
          {preview}
        </div>
      )}
    </div>
  );
}

// ─── Relation Drill Record ────────────────────────────────────

function RelationDrillRecord({
  relation: r,
  onEdit,
  onDelete,
}: {
  relation: CortexRelation;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const RD = 'memoryCortexPanel.relationDrill';
  const contradictionFlag = r.contradictionFlag ?? "none";
  const hasContradiction = contradictionFlag !== "none";
  const edgeSalience = r.edgeSalience ?? r.strength ?? 0;
  const sentiment = r.sentiment ?? 0;
  const sentimentRange = r.sentimentRange;
  const aliases = r.labelAliases ?? [];
  const typeColor = RELATION_TYPE_COLORS[r.relationType] || "#94a3b8";
  const sentColor = sentiment > 0.2 ? "#22c55e" : sentiment < -0.2 ? "#ef4444" : "#94a3b8";
  // Sentiment bar: maps -1..+1 to 0%..100% (50% = neutral center)
  const sentBarPos = ((sentiment + 1) / 2) * 100;

  return (
    <div className={styles.drillRecord}>
      {/* Edge header with type badge */}
      <div className={styles.relationHeader}>
        <span className={styles.relationEdge}>
          <span className={styles.relationEntityName}>{r.sourceName || (r.sourceEntityId ?? "").slice(0, 8)}</span>
          <span className={styles.relationArrow}>→</span>
          <span className={styles.relationEntityName}>{r.targetName || (r.targetEntityId ?? "").slice(0, 8)}</span>
          {r.userEditedAt !== null && (
            <span className={styles.curatedBadge} title={t(`${RD}.curatedTitle`)} style={{ marginLeft: 6 }}>
              <CheckCircle2 size={9} /> {t(`${RD}.curated`)}
            </span>
          )}
        </span>
        <span
          className={styles.relationTypeBadge}
          style={{
            borderColor: `color-mix(in srgb, ${typeColor} 40%, transparent)`,
            background: `color-mix(in srgb, ${typeColor} 12%, transparent)`,
            color: typeColor,
          }}
        >
          {r.relationType}
        </span>
      </div>

      {/* Label + strength */}
      <div className={styles.relationBody}>
        {r.relationLabel && (
          <div className={styles.drillLine}>
            <span className={styles.drillLineLabel}>{t(`${RD}.label`)}</span>
            <span className={styles.drillLineValue}>{r.relationLabel}</span>
          </div>
        )}

        {/* Sentiment gradient bar */}
        <div className={styles.drillLine}>
          <span className={styles.drillLineLabel}>{t(`${RD}.sentiment`)}</span>
          <span className={styles.sentimentBarContainer}>
            <span className={styles.sentimentTrack}>
              <span className={styles.sentimentCenter} />
              <span
                className={styles.sentimentIndicator}
                style={{ left: `${sentBarPos}%`, background: sentColor }}
              />
            </span>
            <span className={styles.sentimentValue} style={{ color: sentColor }}>
              {sentiment > 0 ? "+" : ""}{sentiment.toFixed(2)}
            </span>
            {sentimentRange && (
              <span className={styles.sentimentRangeLabel}>
                [{sentimentRange[0].toFixed(1)}..{sentimentRange[1].toFixed(1)}]
              </span>
            )}
          </span>
        </div>

        {/* Strength + edge salience */}
        <div className={styles.drillLine}>
          <span className={styles.drillLineLabel}>{t(`${RD}.strength`)}</span>
          <span className={styles.edgeSalienceBar}>
            <span className={styles.edgeSalienceTrack}>
              <span className={styles.edgeSalienceFill} style={{ width: `${Math.min(100, edgeSalience * 100)}%` }} />
            </span>
            <span className={styles.edgeSalienceLabel}>{(edgeSalience * 100).toFixed(0)}%</span>
          </span>
        </div>

        <div className={styles.drillLine}>
          <span className={styles.drillLineLabel}>{t(`${RD}.evidence`)}</span>
          <span className={styles.drillLineValue}>
            {t(`${RD}.evidenceChunks`, { count: (r.evidenceChunkIds || []).length })}
          </span>
        </div>
      </div>

      {/* Footer: contradiction flags + aliases */}
      {(hasContradiction || aliases.length > 0) && (
        <div className={styles.relationFooter}>
          {hasContradiction && (
            <span className={clsx(
              styles.contradictionBadge,
              contradictionFlag === "complex" && styles.contradictionComplex,
              contradictionFlag === "suspect" && styles.contradictionSuspect,
              contradictionFlag === "temporal" && styles.contradictionTemporal,
            )}>
              <AlertTriangle size={9} />
              {contradictionFlag}
            </span>
          )}
          {aliases.length > 0 && (
            <>
              <span className={styles.drillLineLabel}>{t(`${RD}.alsoCalled`)}</span>
              <div className={styles.labelAliasList}>
                {aliases.map((a, i) => (
                  <span key={i} className={styles.labelAlias}>{a}</span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {(onEdit || onDelete) && (
        <div className={styles.relationActions}>
          {onEdit && (
            <button className={styles.editBtn} onClick={onEdit}>
              <Edit2 size={11} /> {t(`${RD}.edit`)}
            </button>
          )}
          {onDelete && (
            <button className={styles.dangerBtn} onClick={onDelete}>
              <Trash2 size={11} /> {tc('actions.delete')}
            </button>
          )}
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
