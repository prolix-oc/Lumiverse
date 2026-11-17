import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft, ArrowLeftRight, BookOpen, ChevronsUp, GripVertical, Maximize2, Minus, PanelLeft, PanelRight,
  Plus, Search, Square, X,
} from 'lucide-react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

import type { GuideCatalogEntry, GuideDefinition, SpindleGuidePage } from '@/lib/guides/types'
import { indexGuides, rankGuides } from '@/lib/guides/search'
import { ModalShell } from '@/components/shared/ModalShell'

import styles from './GuideViewer.module.css'
import { useGuidePlacement } from './useGuidePlacement'

interface GuideViewerProps {
  isOpen: boolean
  onClose: () => void
  guide: GuideDefinition
  title: string
  activation?: number
}

// Above standard dialogs and popovers, below native window chrome.
const guideLayer = 11100
type ReaderMode = 'modal' | 'dock' | 'widget'
type GuideTab = { path: string; title: string }
type PageError = { path: string; message: string }

function transformAdmonitions(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const output: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(
      /^!!!\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?\s*$/,
    )

    if (!match) {
      output.push(lines[i])
      continue
    }

    const [, type, customTitle] = match
    const body: string[] = []

    i += 1

    while (i < lines.length) {
      const line = lines[i]

      if (/^( {4}|\t)/.test(line)) {
        body.push(line.replace(/^( {4}|\t)/, ''))
        i += 1
        continue
      }

      if (line.trim() === '' && body.length > 0) {
        body.push('')
        i += 1
        continue
      }

      break
    }

    i -= 1

    const title = customTitle || type.charAt(0).toUpperCase() + type.slice(1)

    output.push(
      `<div class="guide-admonition guide-admonition-${type}">`,
      `<div class="guide-admonition-title">${title}</div>`,
      '',
      body.join('\n'),
      '',
      '</div>',
      '',
    )
  }

  return output.join('\n')
}

function transformContentTabs(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const output: string[] = []
  const tabPattern = /^===\s+"([^"]+)"\s*$/

  let i = 0

  while (i < lines.length) {
    const firstMatch = lines[i].match(tabPattern)

    if (!firstMatch) {
      output.push(lines[i])
      i += 1
      continue
    }

    const tabs: Array<{
      label: string
      body: string
    }> = []

    while (i < lines.length) {
      const headerMatch = lines[i].match(tabPattern)

      if (!headerMatch) break

      const label = headerMatch[1]

      i += 1

      // Zensical normally leaves a blank line after === "Label".
      if (i < lines.length && lines[i].trim() === '') {
        i += 1
      }

      const bodyLines: string[] = []

      while (i < lines.length) {
        const line = lines[i]

        // Next sibling tab starts here.
        if (tabPattern.test(line)) {
          break
        }

        // Blank lines belong to the current tab body.
        if (line.trim() === '') {
          bodyLines.push('')
          i += 1
          continue
        }

        // Tab contents are indented one Markdown level.
        if (/^( {4}|\t)/.test(line)) {
          bodyLines.push(
            line.replace(/^( {4}|\t)/, ''),
          )
          i += 1
          continue
        }

        // Non-indented content means the tab group is over.
        break
      }

      tabs.push({
        label,
        body: bodyLines.join('\n').trimEnd(),
      })

      if (
        i >= lines.length ||
        !tabPattern.test(lines[i])
      ) {
        break
      }
    }

    const buttons = tabs
      .map((tab, index) => {
        const labelHtml = marked.parseInline(
          tab.label,
          { async: false },
        ) as string

        return `
<button
  type="button"
  class="guide-content-tab"
  data-guide-tab-button="${index}"
  aria-pressed="${index === 0 ? 'true' : 'false'}"
>
  ${labelHtml}
</button>`
      })
      .join('')

    const panels = tabs
      .map((tab, index) => {
        /*
         * The tab body has now been dedented by four spaces.
         * This turns nested constructs like:
         *
         *     !!! warning
         *         body
         *
         * into normal top-level admonition syntax for our
         * existing transformer.
         */
        const bodyHtml = marked.parse(
          transformAdmonitions(tab.body),
          { async: false },
        ) as string

        return `
<div
  class="guide-content-tab-panel"
  data-guide-tab-panel="${index}"
  data-active="${index === 0 ? 'true' : 'false'}"
>
  ${bodyHtml}
</div>`
      })
      .join('')

    output.push(
      '',
      '<div class="guide-content-tabs" data-guide-tab-group>',
      `<div class="guide-content-tab-list">${buttons}</div>`,
      `<div class="guide-content-tab-panels">${panels}</div>`,
      '</div>',
      '',
    )
  }

  return output.join('\n')
}

function stripFrontMatter(markdown: string): string {
  return markdown.replace(
    /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/,
    '',
  )
}

function getFrontMatterTitle(markdown: string): string | null {
  const frontMatter = markdown.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
  )

  if (!frontMatter) return null

  const title = frontMatter[1].match(/^title:\s*(.+?)\s*$/m)

  if (!title) return null

  return title[1]
    .trim()
    .replace(/^["']|["']$/g, '')
}

function encodeDocumentKey(path: string): string {
  const bytes = new TextEncoder().encode(path)

  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function documentUrl(path: string): string {
  return `/api/v1/docs/file/${encodeDocumentKey(path)}`
}

function guidePageUrl(
  path: string,
  hash = '',
): string {
  const pagePath = path
    .replace(/(?:^|\/)index\.md$/i, '')
    .replace(/\.md$/i, '')

  return `/guides/${pagePath ? `${pagePath}/` : ''}${hash}`
}

function isRelative(href: string): boolean {
  return !/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(href)
}

function resolveGuideLink(basePath: string, href: string) {
  try {
    const url = new URL(href, 'https://lumiverse.guide/' + basePath.split('/').map(encodeURIComponent).join('/'))
    if (url.origin !== 'https://lumiverse.guide') return null
    return { path: decodeURIComponent(url.pathname.slice(1)), hash: url.hash }
  } catch {
    return null
  }
}

function extensionPages(guide: GuideDefinition, title: string) {
  const pages = new Map<string, SpindleGuidePage>()
  if (guide.kind !== 'markdown') return pages

  pages.set('index.md', { path: 'index.md', title: guide.title ?? title, markdown: guide.markdown })
  for (const page of guide.pages ?? []) {
    if (!/^[^?#%:\\]+\.md$/i.test(page.path) ||
        page.path.split('/').some((segment) => !segment || segment === '..' || segment === '.')) continue
    if (!pages.has(page.path)) pages.set(page.path, page)
  }
  return pages
}

function pageTitle(markdown: string, path: string) {
  return getFrontMatterTitle(markdown) ??
    stripFrontMatter(markdown).match(/^# +(.+)$/m)?.[1]?.trim() ??
    path.split('/').at(-1)?.replace(/\.md$/i, '').replace(/[-_]/g, ' ') ??
    path
}

function renderGuide(markdown: string, path: string, pages: ReadonlyMap<string, SpindleGuidePage>) {
  const prepared = transformAdmonitions(transformContentTabs(stripFrontMatter(markdown)))
  const sanitized = DOMPurify.sanitize(marked.parse(prepared, { async: false }) as string)
  // Use a detached template so relative image sources are rewritten before loading.
  const template = document.createElement('template')
  template.innerHTML = sanitized
  const builtin = pages.size === 0

  const headingIds = new Set<string>()
  for (const heading of template.content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const slug = heading.id || (heading.textContent ?? '').trim().toLowerCase()
      .normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-')
    if (!slug) continue
    let id = slug
    for (let suffix = 1; headingIds.has(id); suffix++) id = slug + '_' + suffix
    heading.id = id
    headingIds.add(id)
  }

  if (builtin) {
    for (const image of template.content.querySelectorAll('img[src]')) {
      const src = image.getAttribute('src')!
      const resolved = src && !src.startsWith('#') && isRelative(src) && resolveGuideLink(path, src)
      if (resolved) image.setAttribute('src', documentUrl(resolved.path))
    }
  }

  for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    // Only links resolved by the host may invoke the guide navigator.
    anchor.removeAttribute('data-guide-path')
    anchor.removeAttribute('data-guide-hash')
    const href = anchor.getAttribute('href')!
    if (!href || href.startsWith('#') || !isRelative(href)) continue

    const resolved = resolveGuideLink(path, href)
    if (!resolved || !/\.md$/i.test(resolved.path)) continue
    if (!builtin && !pages.has(resolved.path)) {
      anchor.removeAttribute('href')
      continue
    }

    anchor.dataset.guidePath = resolved.path
    anchor.dataset.guideHash = resolved.hash
    anchor.setAttribute('href', builtin ? guidePageUrl(resolved.path, resolved.hash) : resolved.hash || '#')
  }
  return template.innerHTML
}

function revealAnchor(prose: HTMLDivElement | null, hash: string) {
  if (!prose) return
  try {
    const id = decodeURIComponent(hash.slice(1))
    const target = Array.from(prose.querySelectorAll<HTMLElement>('[id]')).find((element) => element.id === id)
    if (target) {
      const panel = target.closest<HTMLElement>('[data-guide-tab-panel]')
      if (panel) activateContentTab(panel, panel.dataset.guideTabPanel!)
      target.scrollIntoView?.({ block: 'start' })
    }
  } catch {
    // A malformed fragment should leave the reader on the current page.
  }
}

function activateContentTab(element: Element, index: string) {
  const group = element.closest('[data-guide-tab-group]')
  if (!group) return
  for (const button of group.querySelectorAll<HTMLElement>('[data-guide-tab-button]')) {
    button.setAttribute('aria-pressed', String(button.dataset.guideTabButton === index))
  }
  for (const panel of group.querySelectorAll<HTMLElement>('[data-guide-tab-panel]')) {
    panel.dataset.active = String(panel.dataset.guideTabPanel === index)
  }
}

function ReaderButton({ label, onClick, children, pressed, disabled }: {
  label: string
  onClick: () => void
  children: React.ReactNode
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <button type="button" className={styles.iconButton} aria-label={label} title={label}
      aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <span aria-hidden="true">{children}</span>
    </button>
  )
}

export function GuideViewer(props: GuideViewerProps) {
  const key = props.guide.kind === 'builtin'
    ? 'builtin:' + props.guide.path
    : 'markdown:' + JSON.stringify([props.title, props.guide.title, props.guide.markdown, props.guide.pages])
  return <GuideReader key={key} {...props} />
}

function GuideReader({ isOpen, onClose, guide, title, activation = 0 }: GuideViewerProps) {
  const rootPath = guide.kind === 'builtin' ? guide.path : 'index.md'
  const [tabs, setTabs] = useState<GuideTab[]>([{ path: rootPath, title: guide.title ?? title }])
  const [activePath, setActivePath] = useState(rootPath)
  const [mode, setMode] = useState<ReaderMode>('modal')
  const [dockSide, setDockSide] = useState<'left' | 'right'>('left')
  const [minimizedAt, setMinimizedAt] = useState<number | null>(null)
  const minimized = minimizedAt === activation
  const placement = useGuidePlacement(isOpen && !minimized && mode !== 'modal' ? mode : null, dockSide)
  const { widget, dockSize } = placement
  const panelStyle = mode === 'dock' ? {
    '--guide-dock-width': dockSize.width === undefined ? undefined : dockSize.width + 'px',
    '--guide-dock-height': dockSize.height === undefined ? undefined : dockSize.height + 'px',
  } : widget && {
    '--guide-widget-x': widget.x + 'px',
    '--guide-widget-y': widget.y + 'px',
    '--guide-widget-width': widget.width + 'px',
    '--guide-widget-height': widget.height + 'px',
  }
  const [navigationOpen, setNavigationOpen] = useState(true)
  const [zoom, setZoom] = useState(100)
  const [query, setQuery] = useState('')
  const [builtinCatalog, setBuiltinCatalog] = useState<GuideCatalogEntry[] | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [pageError, setPageError] = useState<PageError | null>(null)
  const [pageAttempt, setPageAttempt] = useState(0)
  const pages = useMemo(() => extensionPages(guide, title), [guide, title])
  const [history, setHistory] = useState<string[]>([])
  const scrollPositions = useRef(new Map<string, number>())
  const [cache, setCache] = useState(() => new Map<string, string>())
  const pendingAnchor = useRef<{ path: string; hash: string } | null>(null)
  const reader = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const prose = useRef<HTMLDivElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const modalTitle = useId()
  const navigationId = useId()
  const readerId = useId()

  useLayoutEffect(() => {
    if (!isOpen) return
    if (minimized) launcher.current?.focus()
    else reader.current?.focus()
  }, [isOpen, mode, minimized, activation])

  useEffect(() => {
    if (!isOpen || guide.kind !== 'builtin' || builtinCatalog) return
    const controller = new AbortController()
    void fetch('/api/v1/docs/catalog', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Unable to load guide index')
        return response.json() as Promise<GuideCatalogEntry[]>
      })
      .then((entries) => {
        if (controller.signal.aborted) return
        setBuiltinCatalog(entries)
        setCatalogError(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogError(true)
      })
    return () => controller.abort()
  }, [isOpen, guide.kind, builtinCatalog, catalogAttempt])

  useEffect(() => {
    if (!isOpen || guide.kind !== 'builtin' || cache.has(activePath)) return
    const controller = new AbortController()
    void fetch(documentUrl(activePath), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Unable to load this guide (' + response.status + ').')
        return response.text()
      })
      .then((markdown) => {
        if (controller.signal.aborted) return
        setCache((current) => new Map(current).set(activePath, markdown))
        setPageError(null)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPageError({ path: activePath, message: error instanceof Error ? error.message : 'Unable to load this guide.' })
        }
      })
    return () => controller.abort()
  }, [isOpen, guide.kind, activePath, pageAttempt, cache])

  const localPage = pages.get(activePath)
  const markdown = localPage?.markdown ?? cache.get(activePath)
  const html = useMemo(() => markdown === undefined ? '' : renderGuide(markdown, activePath, pages), [markdown, activePath, pages])
  const catalog = useMemo(() => {
    if (guide.kind === 'builtin') return builtinCatalog ?? []
    return Array.from(pages.values(), (page): GuideCatalogEntry => ({
      path: page.path,
      title: page.title ?? pageTitle(page.markdown, page.path),
      searchText: stripFrontMatter(page.markdown),
    }))
  }, [builtinCatalog, guide.kind, pages])
  const searchIndex = useMemo(() => indexGuides(catalog), [catalog])
  const results = useMemo(() => rankGuides(searchIndex, query), [searchIndex, query])
  const catalogByPath = useMemo(() => new Map(catalog.map((page) => [page.path, page])), [catalog])
  const sections = useMemo(() => {
    const groups = new Map<string, GuideCatalogEntry[]>()
    for (const page of catalog) {
      const group = page.path.includes('/') ? page.path.split('/')[0].replace(/[-_]/g, ' ') : ''
      const entries = groups.get(group) ?? []
      entries.push(page)
      groups.set(group, entries)
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b))
  }, [catalog])

  useLayoutEffect(() => {
    if (!isOpen || minimized || !body.current || markdown === undefined) return
    body.current.scrollTop = scrollPositions.current.get(activePath) ?? 0
    if (pendingAnchor.current?.path === activePath) {
      revealAnchor(prose.current, pendingAnchor.current.hash)
      pendingAnchor.current = null
    }
  }, [activePath, html, isOpen, markdown, minimized, mode])

  function tabTitle(tab: GuideTab) {
    const known = catalogByPath.get(tab.path)?.title
    const content = cache.get(tab.path)
    return known ?? (content && tab.path !== rootPath ? pageTitle(content, tab.path) : tab.title)
  }

  function openPage(path: string, hash = '') {
    if (path !== activePath) {
      setHistory((current) => [...current, activePath])
      setActivePath(path)
    }
    if (!tabs.some((tab) => tab.path === path)) {
      const fallback = pageTitle('', path)
      setTabs((current) => [...current, { path, title: fallback }])
    }
    if (hash && path === activePath && markdown !== undefined) revealAnchor(prose.current, hash)
    else pendingAnchor.current = hash ? { path, hash } : null
    if (query) setQuery('')
  }

  function back() {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((current) => current.slice(0, -1))
    pendingAnchor.current = null
    setActivePath(previous)
  }

  function closeTab(path: string) {
    const index = tabs.findIndex((tab) => tab.path === path)
    const remaining = tabs.filter((tab) => tab.path !== path)
    if (!remaining.length) return
    const nextPath = path === activePath ? remaining[Math.max(0, index - 1)].path : activePath
    setHistory((current) => {
      const visited = current.filter((entry) => entry !== path)
      return visited.slice(0, visited.findLastIndex((entry) => entry !== nextPath) + 1)
    })
    scrollPositions.current.delete(path)
    setTabs(remaining)
    setActivePath(nextPath)
    reader.current?.focus()
  }

  function handleContentClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return
    const contentTab = event.target.closest<HTMLElement>('[data-guide-tab-button]')
    if (contentTab) activateContentTab(contentTab, contentTab.dataset.guideTabButton!)

    const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const href = anchor.getAttribute('href')!
    if (anchor.dataset.guidePath) {
      event.preventDefault()
      openPage(anchor.dataset.guidePath, anchor.dataset.guideHash)
    } else if (href.startsWith('#')) {
      event.preventDefault()
      revealAnchor(prose.current, href)
    }
  }

  function handleReaderKeys(event: KeyboardEvent<HTMLElement>) {
    // The reader owns its keyboard interaction. Chat editing and generation
    // cancellation also listen on document, including handlers that do not
    // inspect defaultPrevented. Keep F1 available to the global help host.
    if (event.key === 'F1') return
    event.stopPropagation()
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      if (query) {
        setQuery('')
      } else {
        closeReader()
      }
    }
    if (event.defaultPrevented || event.key !== 'Tab' || mode !== 'modal') return
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
    )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    // WebKit can skip buttons in its native Tab order. Own each step so both
    // directions stay in the modal and every reader control stays reachable.
    event.preventDefault()
    const index = focusable.findIndex((element) => element === document.activeElement)
    const next = event.shiftKey
      ? index <= 0 ? focusable.length - 1 : index - 1
      : (index + 1) % focusable.length
    ;(focusable[next] ?? reader.current)?.focus()
  }

  if (!isOpen) return null

  if (minimized) {
    return createPortal(
      <button ref={launcher} type="button" className={styles.launcher} style={{ zIndex: guideLayer }} onClick={() => setMinimizedAt(null)}
        onKeyDown={handleReaderKeys}
        aria-label={'Expand guide reader: ' + title}>
        <BookOpen size={17} aria-hidden="true" />
        <span>{title}</span>
        <ChevronsUp size={15} aria-hidden="true" />
      </button>,
      document.body,
    )
  }

  function closeReader() {
    setQuery('')
    onClose()
  }

  const canBrowse = guide.kind === 'builtin' || pages.size > 1
  const showNavigation = canBrowse && (navigationOpen || query.trim() !== '')
  const loadError = markdown === undefined && pageError?.path === activePath ? pageError.message : undefined
  const catalogButton = (page: GuideCatalogEntry, description?: string) => (
    <button type="button" key={page.path} className={styles.pageLink}
      aria-current={page.path === activePath ? 'page' : undefined}
      onClick={() => { openPage(page.path); reader.current?.focus() }}>
      <span>{page.title}</span>
      {description && <small>{description}</small>}
    </button>
  )

  const content = (
    <div ref={reader} tabIndex={-1} role={mode === 'modal' ? 'dialog' : 'region'}
      aria-modal={mode === 'modal' || undefined} aria-labelledby={modalTitle}
      className={styles.reader} onKeyDown={handleReaderKeys}>
      <header className={styles.header}>
        <div className={styles.headerTitle} id={modalTitle}
          data-drag={mode === 'widget' || undefined}
          {...(mode === 'widget' ? {
            tabIndex: 0,
            role: 'group',
            'aria-description': 'Move with arrow keys or pinch to resize',
            title: 'Drag to move or pinch to resize',
            ...placement.controls('move'),
          } : {})}>
          {mode === 'widget' ? <GripVertical size={18} aria-hidden="true" /> : <BookOpen size={18} aria-hidden="true" />}
          <span>{title}</span>
        </div>
        <div className={styles.toolbar} role="group" aria-label="Guide display">
          <ReaderButton label="Modal view" pressed={mode === 'modal'} onClick={() => setMode('modal')}>
            <Maximize2 size={16} />
          </ReaderButton>
          <ReaderButton label="Half-dock view" pressed={mode === 'dock'} onClick={() => setMode('dock')}>
            <PanelRight size={17} />
          </ReaderButton>
          <ReaderButton label="Widget view" pressed={mode === 'widget'} onClick={() => setMode('widget')}>
            <Square size={16} />
          </ReaderButton>
          {mode === 'dock' && (
            <span className={styles.dockSideControl}>
              <ReaderButton label={'Move guide dock to the ' + (dockSide === 'left' ? 'right' : 'left')}
                onClick={() => setDockSide(dockSide === 'left' ? 'right' : 'left')}>
                <ArrowLeftRight size={16} />
              </ReaderButton>
            </span>
          )}
          {mode === 'widget' && (
            <ReaderButton label="Minimize guide widget" onClick={() => setMinimizedAt(activation)}><Minus size={17} /></ReaderButton>
          )}
          <ReaderButton label="Close guide reader" onClick={closeReader}><X size={18} /></ReaderButton>
        </div>
      </header>
      <div className={styles.tools}>
        <ReaderButton label="Back to previous guide" disabled={!history.length} onClick={back}>
          <ArrowLeft size={17} />
        </ReaderButton>
        {canBrowse && (
          <>
            <button type="button" className={styles.iconButton} aria-controls={navigationId}
              aria-expanded={showNavigation} title="Guide navigation" aria-label="Guide navigation"
              onClick={() => {
                if (showNavigation) setQuery('')
                setNavigationOpen(!showNavigation)
              }}>
              <PanelLeft size={17} />
            </button>
            <form role="search" className={styles.search} onSubmit={(event) => {
              event.preventDefault()
              if (results[0]) {
                openPage(results[0].path)
                reader.current?.focus()
              }
            }}>
              <Search size={15} aria-hidden="true" />
              <input ref={searchInput} type="search" aria-label="Search guides" placeholder="Search guides..."
                value={query} onChange={(event) => setQuery(event.target.value)} />
              {query && (
                <ReaderButton label="Clear guide search" onClick={() => {
                  setQuery('')
                  searchInput.current?.focus()
                }}><X size={14} /></ReaderButton>
              )}
            </form>
          </>
        )}
        <div className={styles.zoom} role="group" aria-label="Reading zoom">
          <ReaderButton label="Zoom out" disabled={zoom <= 80} onClick={() => setZoom(zoom - 10)}><Minus size={15} /></ReaderButton>
          <button type="button" className={styles.zoomReset} onClick={() => setZoom(100)}
            aria-label={'Reset reading zoom, currently ' + zoom + '%'} title="Reset zoom">{zoom}%</button>
          <ReaderButton label="Zoom in" disabled={zoom >= 160} onClick={() => setZoom(zoom + 10)}><Plus size={15} /></ReaderButton>
        </div>
      </div>
      <div className={styles.tabs} aria-label="Open guide pages" role="group">
        {tabs.map((tab) => (
          <div key={tab.path} className={styles.tab} data-active={tab.path === activePath}>
            <button type="button" title={tabTitle(tab)} aria-controls={readerId}
              aria-current={tab.path === activePath ? 'page' : undefined}
              onClick={() => openPage(tab.path)}>{tabTitle(tab)}</button>
            {tabs.length > 1 && (
              <ReaderButton label={'Close ' + tabTitle(tab) + ' tab'} onClick={() => closeTab(tab.path)}>
                <X size={13} />
              </ReaderButton>
            )}
          </div>
        ))}
      </div>
      <div className={styles.workspace}>
        {canBrowse && (
          <nav className={styles.navigation} aria-label="Guide pages" id={navigationId} hidden={!showNavigation}>
            {catalogError ? (
              <div className={styles.navigationStatus} role="status">
                Guide index unavailable. <button type="button" onClick={() => {
                  setCatalogError(false)
                  setCatalogAttempt(catalogAttempt + 1)
                }}>Retry</button>
              </div>
            ) : query.trim() ? (
              <>
                <h2>Search results</h2>
                {results.map((result) => catalogButton(result, result.snippet ?? result.path.replace(/\.md$/i, '')))}
                {!results.length && <p className={styles.navigationStatus} role="status">
                  {guide.kind === 'builtin' && !builtinCatalog ? 'Loading guides...' : 'No matching guides'}
                </p>}
              </>
            ) : (
              <>
                <h2>Browse guides</h2>
                {sections.map(([group, entries]) => group ? (
                  <details key={group} open={entries.some((entry) => entry.path === activePath)}>
                    <summary>{group}</summary>
                    {entries.map((page) => catalogButton(page))}
                  </details>
                ) : entries.map((page) => catalogButton(page)))}
                {!catalog.length && <p className={styles.navigationStatus} role="status">
                  {builtinCatalog ? 'No guides available' : 'Loading guides...'}
                </p>}
              </>
            )}
          </nav>
        )}
        <div ref={body} id={readerId} className={styles.body}
          onScroll={(event) => scrollPositions.current.set(activePath, event.currentTarget.scrollTop)}>
          {loadError ? (
            <div className={styles.status} role="alert">
              {loadError} <button type="button" onClick={() => {
                setPageError(null)
                setPageAttempt(pageAttempt + 1)
              }}>Retry</button>
            </div>
          ) : markdown === undefined ? (
            <div className={styles.status} role="status">Loading guide...</div>
          ) : (
            <div key={activePath} ref={prose} tabIndex={-1} className={styles.prose}
              style={{ '--guide-reading-zoom': zoom / 100 } as CSSProperties}
              onClick={handleContentClick} dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>
    </div>
  )

  return mode === 'modal' ? (
    <ModalShell isOpen onClose={closeReader} zIndex={guideLayer} maxWidth={1060} maxHeight="92dvh"
      mobilePresentation="fullscreen" className={styles.modal} modalId="guide-viewer" data-component="guide-viewer">
      {content}
    </ModalShell>
  ) : createPortal(
    <div ref={placement.shell} className={mode === 'dock' ? styles.dock : styles.widget}
      onKeyDown={handleReaderKeys}
      style={{ ...panelStyle, zIndex: guideLayer } as CSSProperties} data-positioned={mode === 'widget' && !!widget || undefined}
      data-side={mode === 'dock' ? dockSide : undefined} data-component="guide-viewer">
      {content}
      {mode === 'dock' ? (
        <div className={styles.dockHandle} role="separator" tabIndex={0} aria-label="Resize guide dock"
          aria-orientation={placement.compact ? 'horizontal' : 'vertical'} aria-valuenow={placement.dockPercent}
          aria-controls={readerId} {...placement.controls('dock')} />
      ) : (
        <div className={styles.widgetHandle} role="group" tabIndex={0}
          aria-label="Resize guide widget with arrow keys" {...placement.controls('resize')} />
      )}
    </div>,
    document.body,
  )
}
