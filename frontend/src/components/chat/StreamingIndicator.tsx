import styles from './StreamingIndicator.module.css'

export default function StreamingIndicator() {
  return (
    <div className={styles.indicator}>
      <span className={styles.dot} />
      <span className={styles.dot} />
      <span className={styles.dot} />
    </div>
  )
}
