import styles from './DesktopPwaTitlebar.module.css'

export default function DesktopPwaTitlebar() {
  return (
    <div className={styles.titlebar} aria-hidden="true">
      <div className={styles.dragRegion}>
        <div className={styles.brandMark} />
        <span className={styles.title}>Lumiverse</span>
      </div>
    </div>
  )
}
