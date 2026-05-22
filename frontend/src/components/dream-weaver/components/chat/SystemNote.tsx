import styles from "./SystemNote.module.css";

export function SystemNote({ text }: { text: string }) {
  const lines = text.split("\n");
  const detailed = lines.length > 1;

  if (detailed) {
    const [title, ...body] = lines;
    return (
      <div className={styles.panel}>
        <div className={styles.title}>{title}</div>
        <div className={styles.body}>
          {body.map((line, index) => (
            <p key={index} data-empty={!line.trim() || undefined}>{line}</p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.note}>— {text} —</div>
  );
}
