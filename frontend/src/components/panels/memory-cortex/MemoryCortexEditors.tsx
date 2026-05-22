import { useState } from "react";
import { Edit2, Plus, X } from "lucide-react";
import { ModalShell } from "@/components/shared/ModalShell";
import { useStore } from "@/store";
import {
  memoryCortexApi,
  type CortexEntity,
  type CortexRelation,
  type CortexFontColor,
  type CortexRelationType,
  type CortexRelationStatus,
} from "@/api/memory-cortex";
import styles from "./MemoryCortexEditors.module.css";

const ENTITY_TYPES = ["character", "location", "item", "faction", "concept", "event"] as const;
const ENTITY_STATUSES = ["active", "inactive", "deceased", "destroyed", "unknown"] as const;
const RELATION_TYPES: CortexRelationType[] = [
  "ally", "enemy", "lover", "parent", "child", "sibling",
  "mentor", "rival", "owns", "member_of", "located_in", "fears", "serves", "custom",
];
const RELATION_STATUSES: CortexRelationStatus[] = ["active", "broken", "dormant", "former"];
const COLOR_USAGE_TYPES = ["speech", "thought", "narration", "unknown"] as const;

// ─── Entity editor modal ──────────────────────────────────────

export function EntityEditorModal({
  chatId,
  entity,
  onClose,
  onSaved,
}: {
  chatId: string;
  entity: CortexEntity;
  onClose: () => void;
  onSaved: () => void;
}) {
  const addToast = useStore((s) => s.addToast);
  const [name, setName] = useState(entity.name);
  const [entityType, setEntityType] = useState(entity.entityType);
  const [aliases, setAliases] = useState<string[]>([...entity.aliases]);
  const [description, setDescription] = useState(entity.description || "");
  const [facts, setFacts] = useState<string[]>([...entity.facts]);
  const [status, setStatus] = useState(entity.status);
  const [aliasDraft, setAliasDraft] = useState("");
  const [factDraft, setFactDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const addAlias = () => {
    const a = aliasDraft.trim();
    if (!a) return;
    if (aliases.some((x) => x.toLowerCase() === a.toLowerCase())) {
      setAliasDraft("");
      return;
    }
    setAliases([...aliases, a]);
    setAliasDraft("");
  };

  const addFact = () => {
    const f = factDraft.trim();
    if (!f) return;
    setFacts([...facts, f]);
    setFactDraft("");
  };

  const handleSave = async () => {
    if (!name.trim()) {
      addToast({ type: "error", message: "Name is required" });
      return;
    }
    setSaving(true);
    try {
      await memoryCortexApi.updateEntity(chatId, entity.id, {
        name: name.trim(),
        entityType,
        aliases,
        description,
        facts,
        status,
      });
      addToast({ type: "success", message: "Entity updated — will be preserved through rebuilds" });
      onSaved();
    } catch (err: any) {
      addToast({ type: "error", message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={640}>
      <div className={styles.modalHeader}>
        <Edit2 size={16} />
        <span className={styles.modalTitle}>Edit entity</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.helperText}>
          Manual edits are preserved through rebuilds. Curated fields (name, type, aliases, description, facts) won't be overwritten by extraction.
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Name</label>
          <input className={styles.textInput} value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Type</label>
            <select className={styles.selectInput} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Status</label>
            <select className={styles.selectInput} value={status} onChange={(e) => setStatus(e.target.value)}>
              {ENTITY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Aliases / Nicknames</label>
          <div className={styles.chipContainer}>
            {aliases.map((a, idx) => (
              <span key={`${a}-${idx}`} className={styles.chip}>
                {a}
                <button className={styles.chipRemove} onClick={() => setAliases(aliases.filter((x) => x !== a))} title="Remove">
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              className={styles.chipInput}
              value={aliasDraft}
              onChange={(e) => setAliasDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addAlias(); }
                if (e.key === "Backspace" && !aliasDraft && aliases.length > 0) {
                  setAliases(aliases.slice(0, -1));
                }
              }}
              placeholder={aliases.length === 0 ? "Type and press Enter to add" : ""}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Description</label>
          <textarea
            className={styles.textArea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Facts ({facts.length})</label>
          <div className={styles.factList}>
            {facts.map((f, idx) => (
              <div key={idx} className={styles.factRow}>
                <div className={styles.factText}>{f.replace(/^\[branch:[^\]]+\]\s*/, "")}</div>
                <button className={styles.factRemove} onClick={() => setFacts(facts.filter((_, i) => i !== idx))} title="Remove fact">
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className={styles.addFactRow}>
              <input
                className={styles.textInput}
                value={factDraft}
                onChange={(e) => setFactDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFact(); } }}
                placeholder="Add a fact and press Enter"
              />
              <button className={styles.addBtn} onClick={addFact} disabled={!factDraft.trim()}>
                <Plus size={12} />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>Cancel</button>
        <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Relation editor modal ────────────────────────────────────

export function RelationEditorModal({
  chatId,
  relation,
  sourceName,
  targetName,
  onClose,
  onSaved,
}: {
  chatId: string;
  relation: CortexRelation;
  sourceName?: string;
  targetName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const addToast = useStore((s) => s.addToast);
  const [relationType, setRelationType] = useState<CortexRelationType>(relation.relationType as CortexRelationType);
  const [relationLabel, setRelationLabel] = useState(relation.relationLabel || "");
  const [strength, setStrength] = useState(relation.strength);
  const [sentiment, setSentiment] = useState(relation.sentiment);
  const [status, setStatus] = useState<CortexRelationStatus>(relation.status as CortexRelationStatus);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await memoryCortexApi.updateRelation(chatId, relation.id, {
        relationType,
        relationLabel: relationLabel || null,
        strength,
        sentiment,
        status,
      });
      addToast({ type: "success", message: "Relation updated — will be preserved through rebuilds" });
      onSaved();
    } catch (err: any) {
      addToast({ type: "error", message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={560}>
      <div className={styles.modalHeader}>
        <Edit2 size={16} />
        <span className={styles.modalTitle}>Edit relation</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.helperText}>
          <strong>{sourceName ?? "?"}</strong> → <strong>{targetName ?? "?"}</strong>
          {relation.evidenceChunkIds.length > 0 && <> · {relation.evidenceChunkIds.length} evidence chunk{relation.evidenceChunkIds.length === 1 ? "" : "s"}</>}
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Type</label>
            <select className={styles.selectInput} value={relationType} onChange={(e) => setRelationType(e.target.value as CortexRelationType)}>
              {RELATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Status</label>
            <select className={styles.selectInput} value={status} onChange={(e) => setStatus(e.target.value as CortexRelationStatus)}>
              {RELATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Label (optional)</label>
          <input className={styles.textInput} value={relationLabel} onChange={(e) => setRelationLabel(e.target.value)} placeholder="e.g. 'sworn brothers', 'estranged'" />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Strength: {strength.toFixed(2)}</label>
          <input type="range" min={0} max={1} step={0.01} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} />
          <div className={styles.helperText}>How tightly bound the relation is (0 = weak, 1 = central).</div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Sentiment: {sentiment.toFixed(2)}</label>
          <input type="range" min={-1} max={1} step={0.01} value={sentiment} onChange={(e) => setSentiment(parseFloat(e.target.value))} />
          <div className={styles.helperText}>Emotional charge (-1 = hostile, 0 = neutral, +1 = warm).</div>
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>Cancel</button>
        <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Relation creator modal ───────────────────────────────────

export function RelationCreatorModal({
  chatId,
  entities,
  onClose,
  onSaved,
}: {
  chatId: string;
  entities: CortexEntity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const addToast = useStore((s) => s.addToast);
  const [sourceId, setSourceId] = useState(entities[0]?.id ?? "");
  const [targetId, setTargetId] = useState(entities[1]?.id ?? "");
  const [relationType, setRelationType] = useState<CortexRelationType>("ally");
  const [relationLabel, setRelationLabel] = useState("");
  const [strength, setStrength] = useState(0.5);
  const [sentiment, setSentiment] = useState(0);
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!sourceId || !targetId) {
      addToast({ type: "error", message: "Pick both endpoints" });
      return;
    }
    if (sourceId === targetId) {
      addToast({ type: "error", message: "Source and target must differ" });
      return;
    }
    setSaving(true);
    try {
      await memoryCortexApi.createRelation(chatId, {
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        relationType,
        relationLabel: relationLabel || null,
        strength,
        sentiment,
      });
      addToast({ type: "success", message: "Relation created" });
      onSaved();
    } catch (err: any) {
      const msg = err.message || "Create failed";
      addToast({ type: "error", message: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={560}>
      <div className={styles.modalHeader}>
        <Plus size={16} />
        <span className={styles.modalTitle}>Add relation</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Source</label>
            <select className={styles.selectInput} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Target</label>
            <select className={styles.selectInput} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Relation type</label>
          <select className={styles.selectInput} value={relationType} onChange={(e) => setRelationType(e.target.value as CortexRelationType)}>
            {RELATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Label (optional)</label>
          <input className={styles.textInput} value={relationLabel} onChange={(e) => setRelationLabel(e.target.value)} />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Strength: {strength.toFixed(2)}</label>
          <input type="range" min={0} max={1} step={0.01} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Sentiment: {sentiment.toFixed(2)}</label>
          <input type="range" min={-1} max={1} step={0.01} value={sentiment} onChange={(e) => setSentiment(parseFloat(e.target.value))} />
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>Cancel</button>
        <button className={styles.primaryBtn} onClick={handleCreate} disabled={saving}>
          {saving ? "Creating…" : "Create"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Color editor modal ───────────────────────────────────────

export function ColorEditorModal({
  chatId,
  color,
  entities,
  onClose,
  onSaved,
}: {
  chatId: string;
  color: CortexFontColor;
  entities: CortexEntity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const addToast = useStore((s) => s.addToast);
  const [entityId, setEntityId] = useState<string | null>(color.entityId);
  const [usageType, setUsageType] = useState(color.usageType || "unknown");
  const [hexColor, setHexColor] = useState(color.hexColor);
  const [confidence, setConfidence] = useState(color.confidence ?? 0.5);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const hex = hexColor.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) {
      addToast({ type: "error", message: "Hex color must be in #RRGGBB format" });
      return;
    }
    setSaving(true);
    try {
      await memoryCortexApi.updateColor(chatId, color.id, {
        entityId,
        usageType,
        hexColor: hex,
        confidence,
      });
      addToast({ type: "success", message: "Color attribution updated" });
      onSaved();
    } catch (err: any) {
      addToast({ type: "error", message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={520}>
      <div className={styles.modalHeader}>
        <div className={styles.colorSwatch} style={{ background: hexColor, width: 22, height: 22 }} />
        <span className={styles.modalTitle}>Edit color attribution</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.helperText}>
          Reassign which character this color belongs to, change its usage type, or correct a mis-detected hex.
          Manual edits stick — the cortex won't overwrite them during ingestion.
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Attributed to</label>
          <select
            className={styles.selectInput}
            value={entityId ?? ""}
            onChange={(e) => setEntityId(e.target.value || null)}
            disabled={entities.length === 0}
          >
            <option value="">(no attribution)</option>
            {entities.map((ent) => (
              <option key={ent.id} value={ent.id}>{ent.name} — {ent.entityType}</option>
            ))}
          </select>
          {entities.length === 0 && (
            <div className={styles.helperText}>
              No entities exist in this chat yet. Generate or rebuild memory first, then come back to attribute.
            </div>
          )}
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Usage type</label>
            <select
              className={styles.selectInput}
              value={usageType}
              onChange={(e) => setUsageType(e.target.value)}
            >
              {COLOR_USAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Hex color</label>
            <input
              className={styles.textInput}
              value={hexColor}
              onChange={(e) => setHexColor(e.target.value)}
              placeholder="#aabbcc"
              maxLength={7}
              style={{ fontFamily: "var(--lumiverse-font-mono, monospace)" }}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>Confidence: {confidence.toFixed(2)}</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={confidence}
            onChange={(e) => setConfidence(parseFloat(e.target.value))}
          />
          <div className={styles.helperText}>
            Higher confidence makes this attribution win against weaker auto-detected mappings.
          </div>
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>Cancel</button>
        <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}
