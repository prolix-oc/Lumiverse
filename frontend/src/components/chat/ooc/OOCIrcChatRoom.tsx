import { useState, useMemo } from 'react'
import clsx from 'clsx'
import styles from './OOCStyles.module.css'

export interface IrcEntry {
  name: string
  content: string
}

interface OOCIrcChatRoomProps {
  entries: IrcEntry[]
}

/** Wrap @Handle mentions in styled spans */
function highlightMentions(text: string): string {
  return text.replace(
    /@(\w+)/g,
    `<span class="${styles.ircMention}">@$1</span>`,
  )
}

function buildTimestamps(count: number): string[] {
  const now = new Date()
  const baseMinute = now.getMinutes()
  const baseHour = now.getHours()
  return Array.from({ length: count }, (_, i) => {
    const m = (baseMinute + i) % 60
    const h = (baseHour + Math.floor((baseMinute + i) / 60)) % 24
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  })
}

export default function OOCIrcChatRoom({ entries }: OOCIrcChatRoomProps) {
  const [collapsed, setCollapsed] = useState(false)
  const timestamps = useMemo(() => buildTimestamps(entries.length), [entries.length])

  return (
    <div className={styles.ircContainer}>
      <div
        className={styles.ircHeader}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span>#LumiaCouncil</span>
        <button
          className={clsx(styles.ircToggleBtn, collapsed && styles.ircToggleBtnCollapsed)}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          &#9660;
        </button>
      </div>
      <div className={clsx(styles.ircBodyWrapper, collapsed && styles.ircBodyWrapperCollapsed)}>
        <div className={styles.ircMessages}>
          {entries.map((entry, i) => (
            <div
              key={i}
              className={clsx(styles.ircMsg, i % 2 === 1 && styles.ircMsgAlt)}
              dangerouslySetInnerHTML={{
                __html:
                  `<span class="${styles.ircTimestamp}">[${timestamps[i]}]</span>` +
                  `<span class="${styles.ircNick}">&lt;${entry.name || 'Lumia'}&gt;</span>` +
                  `<span class="${styles.ircText}">${highlightMentions(entry.content)}</span>`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
