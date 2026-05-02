import styles from './DreamSummary.module.css'

export function DreamSummary({
  title = "Dream",
  dreamText,
  tone,
  dislikes,
}: {
  title?: string;
  dreamText: string;
  tone: string | null;
  dislikes: string | null;
}) {
  return (
    <div className={styles.summary}>
      <div className={styles.title}>{title}</div>
      <div className={styles.body}>{dreamText}</div>
      {(tone || dislikes) && (
        <div className={styles.meta}>
          {tone && <span><b>Tone:</b> {tone}</span>}{tone && dislikes && " · "}
          {dislikes && <span><b>Avoid:</b> {dislikes}</span>}
        </div>
      )}
    </div>
  );
}
