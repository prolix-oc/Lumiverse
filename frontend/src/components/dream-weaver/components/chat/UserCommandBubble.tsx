import styles from './UserCommandBubble.module.css'

export function UserCommandBubble({ raw }: { raw: string }) {
  return (
    <div className={styles.bubble}>{raw}</div>
  );
}
