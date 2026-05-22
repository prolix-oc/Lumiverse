import { useState, useRef, useEffect } from "react";
import { Sparkles, Pencil, Check, X, ChevronDown, ChevronUp } from "lucide-react";
import styles from "./DreamSummary.module.css";

const COLLAPSED_LINES = 4;

interface Props {
  messageId: string;
  title?: string;
  dreamText: string;
  tone: string | null;
  dislikes: string | null;
  onSave?: (messageId: string, newText: string) => Promise<void>;
}

export function DreamSummary({ messageId, title = "Dream", dreamText, tone, dislikes, onSave }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(dreamText);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setEditValue(dreamText);
  }, [dreamText]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [dreamText, expanded]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const handleEdit = () => {
    setEditValue(dreamText);
    setEditing(true);
    setExpanded(true);
    setErrorMessage(null);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditValue(dreamText);
    setErrorMessage(null);
  };

  const handleSave = async () => {
    const nextValue = editValue.trim();
    if (!nextValue) {
      setErrorMessage("Dream source text is required.");
      return;
    }
    if (!onSave || nextValue === dreamText.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      await onSave(messageId, nextValue);
      setEditing(false);
    } catch {
      setErrorMessage("Could not save dream source. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.accentBar} />
      <div className={styles.inner}>
        <div className={styles.header}>
          <span className={styles.iconWrap} aria-hidden>
            <Sparkles size={12} />
          </span>
          <span className={styles.title}>{title}</span>
          <span className={styles.activePill}>Source Active</span>
          {onSave && !editing && (
            <button className={styles.editButton} onClick={handleEdit} title="Edit dream" aria-label="Edit dream">
              <Pencil size={11} />
            </button>
          )}
          {editing && (
            <div className={styles.editActions}>
              <button className={styles.editActionBtn} data-confirm onClick={handleSave} disabled={saving} title="Save" aria-label="Save dream">
                <Check size={11} />
              </button>
              <button className={styles.editActionBtn} onClick={handleCancel} disabled={saving} title="Cancel" aria-label="Cancel edit">
                <X size={11} />
              </button>
            </div>
          )}
        </div>

        {editing ? (
          <textarea
            ref={textareaRef}
            className={styles.editTextarea}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            rows={6}
            disabled={saving}
            aria-label="Dream source"
            aria-invalid={Boolean(errorMessage) || undefined}
          />
        ) : (
          <>
            <p
              ref={bodyRef}
              className={styles.body}
              data-collapsed={!expanded || undefined}
            >
              {dreamText}
            </p>
            {(overflows || expanded) && (
              <button className={styles.toggleBtn} onClick={() => setExpanded((v) => !v)}>
                {expanded ? <><ChevronUp size={11} /> Show less</> : <><ChevronDown size={11} /> Show more</>}
              </button>
            )}
          </>
        )}

        {errorMessage && <div className={styles.errorText} role="alert">{errorMessage}</div>}

        {(tone || dislikes) && (
          <div className={styles.meta}>
            {tone && (
              <span className={styles.metaChip}>
                <span className={styles.metaLabel}>Tone</span>
                {tone}
              </span>
            )}
            {dislikes && (
              <span className={styles.metaChip}>
                <span className={styles.metaLabel}>Avoid</span>
                {dislikes}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
