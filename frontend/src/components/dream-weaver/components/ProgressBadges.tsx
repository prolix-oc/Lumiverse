import { Check } from "lucide-react";
import type { DreamWeaverSession } from "@/api/dream-weaver";
import type { FieldStatus } from "../hooks/useProgressTracker";
import styles from "./ProgressBadges.module.css";

interface Props {
  fields: FieldStatus[];
  workspaceKind: DreamWeaverSession["workspace_kind"];
}

export function ProgressBadges({ fields, workspaceKind }: Props) {
  const complete = fields.filter((f) => f.complete).length;
  const total = fields.length;
  const allDone = complete === total;

  return (
    <div className={styles.bar} data-done={allDone || undefined} role="status" aria-live="polite" aria-label={`${workspaceKind === "scenario" ? "Scenario" : "Character"} completion status`}>
      <span className={styles.label}>{workspaceKind === "scenario" ? "Scenario" : "Character"} Progress</span>
      <div className={styles.fields}>
        {fields.map((field) => (
          <span
            key={field.key}
            className={styles.field}
            data-complete={field.complete || undefined}
            data-required={(!field.complete && field.required) || undefined}
            title={field.complete ? `${field.label}: complete` : `${field.label}: missing`}
            aria-label={field.complete ? `${field.label} complete` : `${field.label} missing`}
          >
            {field.complete ? <Check size={9} /> : null}
            {field.label}
          </span>
        ))}
      </div>
      <span className={styles.count} title={`${complete} of ${total} fields complete`}>
        {complete}<span className={styles.countSep}>/</span>{total}
      </span>
    </div>
  );
}
