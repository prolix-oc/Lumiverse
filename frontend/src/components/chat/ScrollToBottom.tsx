import { useState, useEffect, useCallback } from 'react'
import { ArrowDown } from 'lucide-react'
import styles from './ScrollToBottom.module.css'

export default function ScrollToBottom() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
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
  }, [])

  const scrollDown = useCallback(() => {
    const list = document.querySelector('[data-chat-scroll="true"]') as HTMLElement | null
    if (list) {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  if (!visible) return null

  return (
    <button type="button" className={styles.btn} onClick={scrollDown} aria-label="Scroll to bottom">
      <ArrowDown size={18} />
    </button>
  )
}
