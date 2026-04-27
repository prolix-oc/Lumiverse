import { Check, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import styles from "./ToolCard.module.css";

interface Props {
  hasError: boolean;
  onAccept: () => void;
  onReject: () => void;
  onRetry: () => void;
  onNudge: () => void;
}

export function ToolCardActions({ hasError, onAccept, onReject, onRetry, onNudge }: Props) {
  return (
    <div className={styles.actions}>
      {!hasError && <button className={styles.acceptBtn} onClick={onAccept}><Check size={13} /> Use result</button>}
      <button className={styles.btn} onClick={onRetry}><RotateCcw size={13} /> Run again</button>
      <button className={styles.btn} onClick={onNudge}><SlidersHorizontal size={13} /> Adjust</button>
      <button className={styles.rejectBtn} onClick={onReject}><X size={13} /> Discard</button>
    </div>
  );
}
