import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown } from 'lucide-react'
import styles from './ScrollToBottom.module.css'

const CHAT_SCROLL_TO_BOTTOM_EVENT = 'lumiverse:chat-scroll-bottom'

interface ScrollToBottomProps {
  displayReady: boolean
}

export default function ScrollToBottom({ displayReady }: ScrollToBottomProps) {
  const { t } = useTranslation('chat')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!displayReady) return

    const list = document.querySelector('[data-chat-scroll="true"]') as HTMLElement | null
    if (!list) return

    const handleScroll = () => {
      const threshold = 300
      const isNearBottom =
        list.scrollHeight - list.scrollTop - list.clientHeight < threshold
      setVisible(!isNearBottom)
    }

    const resizeObserver = new ResizeObserver(handleScroll)
    resizeObserver.observe(list)
    list.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()

    return () => {
      resizeObserver.disconnect()
      list.removeEventListener('scroll', handleScroll)
    }
  }, [displayReady])

  const scrollDown = useCallback(() => {
    window.dispatchEvent(new Event(CHAT_SCROLL_TO_BOTTOM_EVENT))
  }, [])

  // The list intentionally changes height while its cold/warm virtual ranges
  // and async display replacements settle. Do not expose those programmatic
  // corrections as a rapidly toggling user control before the chat reveals.
  if (!displayReady || !visible) return null

  return (
    <button type="button" className={styles.btn} data-component="ScrollToBottom" onClick={scrollDown} aria-label={t('scrollToBottom')}>
      <ArrowDown size={18} />
    </button>
  )
}
