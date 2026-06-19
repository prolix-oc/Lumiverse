import { useEffect, useRef, useState } from "react";
import { useTranslation } from 'react-i18next'

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

const E = 'memoryCortexPanel.editors';

// Commit-on-Enter for single-line inputs that stays reliable on Android.
//
// Gboard (and other Android IMEs) commit the Enter key on a single-line input
// as a `beforeinput` event with `inputType === "insertLineBreak"`. The matching
// `keydown` arrives mid-composition as `keyCode 229` / `key "Unidentified"`, so a
// handler that only checks `e.key === "Enter"` never fires — which is why Termux
// users couldn't add aliases/facts by pressing Enter. We listen to the native
// `beforeinput` event (React's synthetic `onBeforeInput` doesn't reliably expose
// `inputType`) and treat a line-break insertion as a commit. Desktop keeps using
// the existing `onKeyDown` path; the `onEnter` callbacks no-op on an empty draft,
// so a double-fire is harmless.
function useEnterCommit(onEnter: () => void) {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(onEnter);
  cb.current = onEnter;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const inputType = (e as InputEvent).inputType;
      if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
        e.preventDefault();
        cb.current();
      }
    };
    el.addEventListener("beforeinput", handler);
    return () => el.removeEventListener("beforeinput", handler);
  }, []);
  return ref;
}

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
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
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

  // Android/Gboard-safe Enter handling for the single-line chip inputs below.
  const aliasInputRef = useEnterCommit(addAlias);
  const factInputRef = useEnterCommit(addFact);

  const handleSave = async () => {
    if (!name.trim()) {
      addToast({ type: "error", message: t(`${E}.entity.nameRequired`) });
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
      addToast({ type: "success", message: t(`${E}.entity.saved`) });
      onSaved();
    } catch (err: any) {
      addToast({ type: "error", message: t(`${E}.saveFailed`, { error: err.message }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={640}>
      <div className={styles.modalHeader}>
        <Edit2 size={16} />
        <span className={styles.modalTitle}>{t(`${E}.entity.title`)}</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.helperText}>
          {t(`${E}.entity.helper`)}
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.entity.name`)}</label>
          <input className={styles.textInput} value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.entity.type`)}</label>
            <select className={styles.selectInput} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              {ENTITY_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.entity.status`)}</label>
            <select className={styles.selectInput} value={status} onChange={(e) => setStatus(e.target.value)}>
              {ENTITY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.entity.aliases`)}</label>
          <div className={styles.chipContainer}>
            {aliases.map((a, idx) => (
              <span key={`${a}-${idx}`} className={styles.chip}>
                {a}
                <button className={styles.chipRemove} onClick={() => setAliases(aliases.filter((x) => x !== a))} title={tc('actions.delete')}>
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              ref={aliasInputRef}
              className={styles.chipInput}
              value={aliasDraft}
              onChange={(e) => {
                const val = e.target.value;
                if (val.includes(",")) {
                  const parts = val.split(",");
                  for (const part of parts.slice(0, -1)) {
                    const a = part.trim();
                    if (a && !aliases.some((x) => x.toLowerCase() === a.toLowerCase())) {
                      setAliases((prev) => [...prev, a]);
                    }
                  }
                  setAliasDraft(parts[parts.length - 1]);
                  return;
                }
                setAliasDraft(val);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addAlias(); }
                if (e.key === "Backspace" && !aliasDraft && aliases.length > 0) {
                  setAliases(aliases.slice(0, -1));
                }
              }}
              onBlur={() => { if (aliasDraft.trim()) addAlias(); }}
              placeholder={aliases.length === 0 ? t(`${E}.entity.aliasPlaceholder`) : ""}
            />
            <button className={styles.addBtn} onClick={addAlias} disabled={!aliasDraft.trim()} type="button" title="Add alias">
              <Plus size={12} />
            </button>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.entity.description`)}</label>
          <textarea
            className={styles.textArea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.entity.facts`, { count: facts.length })}</label>
          <div className={styles.factList}>
            {facts.map((f, idx) => (
              <div key={idx} className={styles.factRow}>
                <div className={styles.factText}>{f.replace(/^\[branch:[^\]]+\]\s*/, "")}</div>
                <button className={styles.factRemove} onClick={() => setFacts(facts.filter((_, i) => i !== idx))} title={t(`${E}.entity.removeFact`)}>
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className={styles.addFactRow}>
              <input
                ref={factInputRef}
                className={styles.textInput}
                value={factDraft}
                onChange={(e) => setFactDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFact(); } }}
                placeholder={t(`${E}.entity.factPlaceholder`)}
              />
              <button className={styles.addBtn} onClick={addFact} disabled={!factDraft.trim()}>
                <Plus size={12} />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>{t(`${E}.cancel`)}</button>
        <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
          {saving ? t(`${E}.saving`) : t(`${E}.save`)}
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
  const { t } = useTranslation('panels')
  const addToast = useStore((s) => s.addToast);
  const [relationType, setRelationType] = useState<CortexRelationType>(relation.relationType as CortexRelationType);
  const [relationLabel, setRelationLabel] = useState(relation.relationLabel || "");
  const [strength, setStrength] = useState(relation.strength);
  const [sentiment, setSentiment] = useState(relation.sentiment);
  const [status, setStatus] = useState<CortexRelationStatus>(relation.status as CortexRelationStatus);
  const [saving, setSaving] = useState(false);

  const evidenceCount = relation.evidenceChunkIds.length;

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
      addToast({ type: "success", message: t(`${E}.relation.saved`) });
      onSaved();
    } catch (err: any) {
      addToast({ type: "error", message: t(`${E}.saveFailed`, { error: err.message }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={560}>
      <div className={styles.modalHeader}>
        <Edit2 size={16} />
        <span className={styles.modalTitle}>{t(`${E}.relation.title`)}</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.helperText}>
          {t(`${E}.relation.endpoints`, { source: sourceName ?? "?", target: targetName ?? "?" })}
          {evidenceCount > 0 && (
            <> · {t(`${E}.relation.evidenceChunks`, { count: evidenceCount })}</>
          )}
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.relation.type`)}</label>
            <select className={styles.selectInput} value={relationType} onChange={(e) => setRelationType(e.target.value as CortexRelationType)}>
              {RELATION_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.relation.status`)}</label>
            <select className={styles.selectInput} value={status} onChange={(e) => setStatus(e.target.value as CortexRelationStatus)}>
              {RELATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.relation.labelOptional`)}</label>
          <input className={styles.textInput} value={relationLabel} onChange={(e) => setRelationLabel(e.target.value)} placeholder={t(`${E}.relation.labelPlaceholder`)} />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.relation.strength`, { value: strength.toFixed(2) })}</label>
          <input type="range" min={0} max={1} step={0.01} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} />
          <div className={styles.helperText}>{t(`${E}.relation.strengthHint`)}</div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.relation.sentiment`, { value: sentiment.toFixed(2) })}</label>
          <input type="range" min={-1} max={1} step={0.01} value={sentiment} onChange={(e) => setSentiment(parseFloat(e.target.value))} />
          <div className={styles.helperText}>{t(`${E}.relation.sentimentHint`)}</div>
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>{t(`${E}.cancel`)}</button>
        <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
          {saving ? t(`${E}.saving`) : t(`${E}.save`)}
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
  const { t } = useTranslation('panels')
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
      addToast({ type: "error", message: t(`${E}.relationCreator.pickBoth`) });
      return;
    }
    if (sourceId === targetId) {
      addToast({ type: "error", message: t(`${E}.relationCreator.mustDiffer`) });
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
      addToast({ type: "success", message: t(`${E}.relationCreator.created`) });
      onSaved();
    } catch (err: any) {
      const msg = err.message || t(`${E}.relationCreator.createFailed`);
      addToast({ type: "error", message: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={560}>
      <div className={styles.modalHeader}>
        <Plus size={16} />
        <span className={styles.modalTitle}>{t(`${E}.relationCreator.title`)}</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.relationCreator.source`)}</label>
            <select className={styles.selectInput} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {entities.map((ent) => <option key={ent.id} value={ent.id}>{ent.name}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.relationCreator.target`)}</label>
            <select className={styles.selectInput} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {entities.map((ent) => <option key={ent.id} value={ent.id}>{ent.name}</option>)}
            </select>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.relationCreator.relationType`)}</label>
          <select className={styles.selectInput} value={relationType} onChange={(e) => setRelationType(e.target.value as CortexRelationType)}>
            {RELATION_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.relation.labelOptional`)}</label>
          <input className={styles.textInput} value={relationLabel} onChange={(e) => setRelationLabel(e.target.value)} />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.relation.strength`, { value: strength.toFixed(2) })}</label>
          <input type="range" min={0} max={1} step={0.01} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.relation.sentiment`, { value: sentiment.toFixed(2) })}</label>
          <input type="range" min={-1} max={1} step={0.01} value={sentiment} onChange={(e) => setSentiment(parseFloat(e.target.value))} />
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>{t(`${E}.cancel`)}</button>
        <button className={styles.primaryBtn} onClick={handleCreate} disabled={saving}>
          {saving ? t(`${E}.creating`) : t(`${E}.create`)}
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
  const { t } = useTranslation('panels')
  const addToast = useStore((s) => s.addToast);
  const [entityId, setEntityId] = useState<string | null>(color.entityId);
  const [usageType, setUsageType] = useState(color.usageType || "unknown");
  const [hexColor, setHexColor] = useState(color.hexColor);
  const [confidence, setConfidence] = useState(color.confidence ?? 0.5);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const hex = hexColor.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) {
      addToast({ type: "error", message: t(`${E}.color.invalidHex`) });
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
      addToast({ type: "success", message: t(`${E}.color.saved`) });
      onSaved();
    } catch (err: any) {
      addToast({ type: "error", message: t(`${E}.saveFailed`, { error: err.message }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={520}>
      <div className={styles.modalHeader}>
        <div className={styles.colorSwatch} style={{ background: hexColor, width: 22, height: 22 }} />
        <span className={styles.modalTitle}>{t(`${E}.color.title`)}</span>
        <button className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div className={styles.modalBody}>
        <div className={styles.helperText}>
          {t(`${E}.color.helper`)}
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.color.attributedTo`)}</label>
          <select
            className={styles.selectInput}
            value={entityId ?? ""}
            onChange={(e) => setEntityId(e.target.value || null)}
            disabled={entities.length === 0}
          >
            <option value="">{t(`${E}.color.noAttribution`)}</option>
            {entities.map((ent) => (
              <option key={ent.id} value={ent.id}>
                {t(`${E}.color.entityOption`, { name: ent.name, type: ent.entityType })}
              </option>
            ))}
          </select>
          {entities.length === 0 && (
            <div className={styles.helperText}>
              {t(`${E}.color.noEntitiesHint`)}
            </div>
          )}
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.color.usageType`)}</label>
            <select
              className={styles.selectInput}
              value={usageType}
              onChange={(e) => setUsageType(e.target.value)}
            >
              {COLOR_USAGE_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t(`${E}.color.hexColor`)}</label>
            <input
              className={styles.textInput}
              value={hexColor}
              onChange={(e) => setHexColor(e.target.value)}
              placeholder={t(`${E}.color.hexPlaceholder`)}
              maxLength={7}
              style={{ fontFamily: "var(--lumiverse-font-mono, monospace)" }}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t(`${E}.color.confidence`, { value: confidence.toFixed(2) })}</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={confidence}
            onChange={(e) => setConfidence(parseFloat(e.target.value))}
          />
          <div className={styles.helperText}>
            {t(`${E}.color.confidenceHint`)}
          </div>
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.secondaryBtn} onClick={onClose} disabled={saving}>{t(`${E}.cancel`)}</button>
        <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
          {saving ? t(`${E}.saving`) : t(`${E}.save`)}
        </button>
      </div>
    </ModalShell>
  );
}
