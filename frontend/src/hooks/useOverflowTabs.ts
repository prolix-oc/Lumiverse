import { useState, useEffect, useRef, useCallback, RefObject } from 'react'

const TAB_SLOT = 48
const BOTTOM_RESERVED = 92

interface Tab {
  id: string
  [key: string]: any
}

export default function useOverflowTabs(
  tabs: Tab[],
  isMobile: boolean,
  containerRef: RefObject<HTMLElement | null>
) {
  const [splitIndex, setSplitIndex] = useState(tabs.length)
  const tabsLenRef = useRef(tabs.length)
  tabsLenRef.current = tabs.length

  const computeSplit = useCallback((height: number) => {
    const maxVisible = Math.floor((height - BOTTOM_RESERVED) / TAB_SLOT)
    const clamped = Math.max(1, Math.min(tabsLenRef.current, maxVisible))
    setSplitIndex((prev) => (prev !== clamped ? clamped : prev))
  }, [])

  useEffect(() => {
    if (!isMobile || !containerRef.current) {
      setSplitIndex(tabs.length)
      return
    }

    const el = containerRef.current
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        computeSplit(entry.contentRect.height)
      }
    })
    ro.observe(el)
    computeSplit(el.clientHeight)

    return () => ro.disconnect()
  }, [isMobile, containerRef, computeSplit, tabs.length])

  useEffect(() => {
    if (!isMobile || !containerRef.current) {
      setSplitIndex(tabs.length)
      return
    }
    computeSplit(containerRef.current.clientHeight)
  }, [tabs.length, isMobile, containerRef, computeSplit])

  const needsOverflow = isMobile && splitIndex < tabs.length

  return {
    directTabs: needsOverflow ? tabs.slice(0, splitIndex) : tabs,
    overflowTabs: needsOverflow ? tabs.slice(splitIndex) : [],
    needsOverflow,
  }
}
