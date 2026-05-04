import { useState } from "react";
import styles from "./ToolCard.module.css";

interface Props { onSubmit: (text: string) => void; onCancel: () => void; }

export function NudgeInline({ onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("");
  return (
    <div className={styles.nudge}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSubmit(value); if (e.key === "Escape") onCancel(); }}
        placeholder="What should change?"
      />
      <button onClick={() => onSubmit(value)} className={styles.acceptBtn}>Run adjusted</button>
      <button onClick={onCancel} className={styles.btn}>Cancel</button>
    </div>
  );
}
