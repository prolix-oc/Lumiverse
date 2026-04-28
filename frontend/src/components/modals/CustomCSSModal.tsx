import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Download, Upload, X, Paintbrush, Code2, ChevronDown, ChevronUp, ShieldAlert, Globe, RotateCcw, Package, Trash2, PanelRightOpen, PanelRightClose, Image as ImageIcon } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { themeAssetsApi } from '@/api/theme-assets'
import { useStore } from '@/store'
import { validateCSS, sanitizeCSS } from '@/lib/cssValidator'
import { validateTSX } from '@/lib/componentTranspiler'
import { CSS_MODULE_REGISTRY, generateSelector, type CSSModuleEntry } from '@/lib/cssModuleRegistry'
import { getComponentTemplate, type PropDoc } from '@/lib/componentTemplates'
import { createThemePack, exportThemePack, importThemePack, packSummary, type ThemePackAsset } from '@/lib/themePack'
import { disableImportedThemePackTsx } from '@/lib/componentOverrideSecurity'
import { toast } from '@/lib/toast'
import { generateUUID } from '@/lib/uuid'
import { css, cssLanguage } from '@codemirror/lang-css'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import CodeEditor, { type CodeEditorHandle } from '@/components/panels/custom-css/CSSEditor'
import ThemeAssetsPanel from '@/components/panels/custom-css/ThemeAssetsPanel'
import PropsReference from './PropsReference'
import CssVariablesReference from './CssVariablesReference'
import ComponentCssReference from './ComponentCssReference'
import styles from './CustomCSSModal.module.css'
import clsx from 'clsx'

type EditorTab = 'css' | 'tsx'

const GLOBAL_KEY = '__global__'
const cssLang = css()
const tsxLang = javascript({ jsx: true, typescript: true })

function createPropsCompletionSource(props: PropDoc[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match any sequence of word characters and dots
    const matchPrefix = context.matchBefore(/[\w.]+/)
    if (!matchPrefix && !context.explicit) return null

    const text = matchPrefix ? matchPrefix.text : ''
    
    // Find the word we are currently completing (after the last dot)
    const lastDotIndex = text.lastIndexOf('.')
    const currentWord = lastDotIndex !== -1 ? text.slice(lastDotIndex + 1) : text
    const from = context.pos - currentWord.length

    // Determine the path of properties to traverse
    // E.g., if text is "props.message.isU", path is "props.message"
    // If text is "message.isU", path is "message"
    const pathText = lastDotIndex !== -1 ? text.slice(0, lastDotIndex) : ''
    const parts = pathText.split('.').filter(Boolean)

    // Optional: strip leading 'props' so 'props.message' and 'message' act the same
    if (parts[0] === 'props') {
      parts.shift()
    }

    let targetProps = props
    for (const part of parts) {
      const found = targetProps.find(p => p.name === part)
      if (found && found.children) {
        targetProps = found.children
      } else {
        targetProps = []
        break
      }
    }

    const options = targetProps.map((p) => {
      return {
        label: p.name,
        type: 'property',
        info: p.description,
        detail: p.type,
      }
    })

    return {
      from,
      options,
    }
  }
}

function createCssPropsCompletionSource(props: PropDoc[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/--[\w-]*|data-[\w-]*/)
    if (!word) return null
    if (word.from === word.to && !context.explicit) return null

    const text = word.text
    const isVar = text.startsWith('--')
    const isData = text.startsWith('data-')
    
    if (!isVar && !isData) return null

    const options = props.flatMap((p) => {
      const opts = []
      if (isData) {
        opts.push({ label: `data-${p.name}`, type: 'property', info: p.description })
      }
      if (p.children) {
        for (const c of p.children) {
          if (isData) {
            opts.push({ label: `data-${p.name}-${c.name}`, type: 'property', info: c.description })
          }
        }
      }
      return opts
    })

    return {
      from: word.from,
      options,
    }
  }
}

import GENERATED_VARS from '@/lib/generatedCssVariables'
import GENERATED_COMPONENT_CSS from '@/lib/generatedComponentCss'

function createCssThemeVarsCompletionSource() {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/--lumiverse-[\w-]*/)
    if (!word) return null
    if (word.from === word.to && !context.explicit) return null

    const options = Object.entries(GENERATED_VARS).map(([name, value]) => ({
      label: name,
      type: 'variable',
      info: value,
    }))

    return {
      from: word.from,
      options,
    }
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToFile(dataBase64: string, filename: string, mimeType: string): File {
  const binary = atob(dataBase64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new File([bytes], filename, { type: mimeType })
}

export default function CustomCSSModal() {
  const closeModal = useStore((s) => s.closeModal)
  const customCSS = useStore((s) => s.customCSS)
  const setCustomCSS = useStore((s) => s.setCustomCSS)
  const ensureThemeBundleId = useStore((s) => s.ensureThemeBundleId)
  const toggleCustomCSS = useStore((s) => s.toggleCustomCSS)
  const componentOverrides = useStore((s) => s.componentOverrides)
  const setComponentCSS = useStore((s) => s.setComponentCSS)
  const setComponentTSX = useStore((s) => s.setComponentTSX)
  const toggleComponentOverride = useStore((s) => s.toggleComponentOverride)
  const resetAllOverrides = useStore((s) => s.resetAllOverrides)
  const applyThemePack = useStore((s) => s.applyThemePack)
  const theme = useStore((s) => s.theme)
  const openModal = useStore((s) => s.openModal)

  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string>(GLOBAL_KEY)
  const [activeTab, setActiveTab] = useState<EditorTab>('css')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showReference, setShowReference] = useState(false)
  const [showAssets, setShowAssets] = useState(false)
  const cssEditorRef = useRef<CodeEditorHandle | null>(null)

  const isGlobal = selected === GLOBAL_KEY

  useEffect(() => {
    if (activeTab === 'css' && !customCSS.bundleId) {
      ensureThemeBundleId()
    }
  }, [activeTab, customCSS.bundleId, ensureThemeBundleId])

  // ── Filtered + grouped component list ──
  const filtered = useMemo(() => {
    if (!search.trim()) return CSS_MODULE_REGISTRY
    const q = search.toLowerCase()
    return CSS_MODULE_REGISTRY.filter(
      (e) => e.component.toLowerCase().includes(q) || e.category.toLowerCase().includes(q),
    )
  }, [search])

  const grouped = useMemo(() => {
    const map = new Map<string, CSSModuleEntry[]>()
    for (const entry of filtered) {
      const existing = map.get(entry.category)
      if (existing) existing.push(entry)
      else map.set(entry.category, [entry])
    }
    return map
  }, [filtered])

  // ── Current values for selected component ──
  const override = isGlobal ? null : componentOverrides[selected]
  const currentCSS = isGlobal ? customCSS.css : (override?.css ?? '')
  const currentTSX = isGlobal ? '' : (override?.tsx ?? '')
  const isEnabled = isGlobal ? customCSS.enabled : (override?.enabled ?? false)

  // ── Handlers ──
  const handleToggle = useCallback(() => {
    if (isGlobal) {
      toggleCustomCSS(!customCSS.enabled)
    } else {
      toggleComponentOverride(selected, !isEnabled)
    }
  }, [isGlobal, selected, isEnabled, customCSS.enabled, toggleCustomCSS, toggleComponentOverride])

  const handleCSSChange = useCallback((v: string) => {
    if (isGlobal) setCustomCSS(v)
    else setComponentCSS(selected, v)
  }, [isGlobal, selected, setCustomCSS, setComponentCSS])

  const handleTSXChange = useCallback((v: string) => {
    if (!isGlobal) setComponentTSX(selected, v)
  }, [isGlobal, selected, setComponentTSX])

  const handleSelect = useCallback((key: string) => {
    setSelected(key)
    // Auto-switch to CSS tab when selecting Global (no TSX for global)
    if (key === GLOBAL_KEY && activeTab === 'tsx') setActiveTab('css')
  }, [activeTab])

  // ── Validation ──
  const validation = useMemo(() => {
    if (activeTab === 'css') {
      const src = currentCSS.trim()
      if (!src) return { status: 'empty' as const }
      const result = validateCSS(sanitizeCSS(src))
      return result.valid ? { status: 'valid' as const } : { status: 'error' as const, error: result.error }
    }
    const src = currentTSX.trim()
    if (!src) return { status: 'empty' as const }
    const result = validateTSX(src)
    return result.valid ? { status: 'valid' as const } : { status: 'error' as const, error: result.error }
  }, [activeTab, currentCSS, currentTSX])

  const byteCount = useMemo(
    () => new Blob([activeTab === 'css' ? currentCSS : currentTSX]).size,
    [activeTab, currentCSS, currentTSX],
  )

  const assetBundleId = customCSS.bundleId

  const buildPackAssets = useCallback(async (): Promise<ThemePackAsset[]> => {
    const bundleId = customCSS.bundleId
    if (!bundleId) return []
    const assets = await themeAssetsApi.list(bundleId)
    return Promise.all(assets.map(async (asset) => {
      const blob = await themeAssetsApi.getBlob(asset.id)
      return {
        slug: asset.slug,
        originalFilename: asset.original_filename,
        mimeType: asset.mime_type,
        tags: asset.tags,
        metadata: asset.metadata || {},
        dataBase64: await blobToBase64(blob),
      }
    }))
  }, [customCSS.bundleId])

  // ── Export / Import ──
  const handleExport = useCallback(() => {
    const content = activeTab === 'css' ? currentCSS : currentTSX
    if (!content.trim()) return
    const ext = activeTab === 'css' ? 'css' : 'tsx'
    const name = isGlobal ? `lumiverse-global.${ext}` : `${selected}.${ext}`
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }, [activeTab, currentCSS, currentTSX, isGlobal, selected])

  const handleImport = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = activeTab === 'css' ? '.css' : '.tsx,.ts,.jsx,.js'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const text = await file.text()
      if (activeTab === 'css') handleCSSChange(text)
      else handleTSXChange(text)
    }
    input.click()
  }, [activeTab, handleCSSChange, handleTSXChange])

  // ── Pack-level export / import / reset ──
  const handleExportPack = useCallback(async () => {
    try {
      const assets = await buildPackAssets()
      const pack = createThemePack(theme, customCSS, componentOverrides, assets, {
        name: theme?.name || 'Custom Theme',
      })
      exportThemePack(pack)
      toast.success('Theme bundle exported as .lumitheme')
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || 'Failed to export .lumitheme bundle')
    }
  }, [buildPackAssets, theme, customCSS, componentOverrides])

  const handleImportPack = useCallback(async () => {
    const result = await importThemePack()
    if (!result) {
      toast.info('Theme import cancelled')
      return
    }
    if (result.error) {
      toast.error(result.error.message)
      return
    }
    const imported = disableImportedThemePackTsx(result.pack)
    const pack = imported.pack
    const localBundleId = generateUUID()
    const localizedPack = { ...pack, bundleId: localBundleId }
    try {
      for (const asset of localizedPack.assets) {
        const file = base64ToFile(asset.dataBase64, asset.originalFilename, asset.mimeType)
        await themeAssetsApi.upload(file, {
          bundleId: localBundleId,
          slug: asset.slug,
          tags: asset.tags,
          metadata: asset.metadata,
        })
      }
      const summary = packSummary(localizedPack)
      applyThemePack(localizedPack)
      const disabledNote = imported.disabledCount > 0
        ? ` TSX overrides were imported disabled for manual review (${imported.disabledCount}).`
        : ''
      toast.success(`Applied "${pack.name}" from theme bundle: ${summary.join(', ')}.${disabledNote}`)
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || 'Failed to import bundled theme assets')
    }
  }, [applyThemePack])

  const handleResetAll = useCallback(() => {
    openModal('confirm', {
      title: 'Reset All Overrides',
      message: 'This will clear all custom CSS and component overrides. Your theme colors will be kept. This cannot be undone.',
      variant: 'destructive',
      confirmText: 'Reset All',
      onConfirm: () => {
        resetAllOverrides()
        setSelected(GLOBAL_KEY)
        setActiveTab('css')
        toast.info('All overrides cleared')
      },
    })
  }, [openModal, resetAllOverrides])

  // ── Template for selected component ──
  const componentTemplate = useMemo(
    () => isGlobal ? null : getComponentTemplate(selected),
    [isGlobal, selected],
  )

  const handleInsertTemplate = useCallback(() => {
    if (componentTemplate) {
      setComponentTSX(selected, componentTemplate.template)
    }
  }, [selected, componentTemplate, setComponentTSX])

  // Auto-insert template when switching to an empty TSX editor
  const effectiveTSX = useMemo(() => {
    if (activeTab !== 'tsx' || isGlobal) return currentTSX
    if (!currentTSX.trim() && componentTemplate) return componentTemplate.template
    return currentTSX
  }, [activeTab, isGlobal, currentTSX, componentTemplate])

  // Check if a component has any overrides
  const hasOverride = useCallback((name: string) => {
    const o = componentOverrides[name]
    return o && (o.css?.trim() || o.tsx?.trim())
  }, [componentOverrides])

  const handleInsertAssetReference = useCallback((text: string) => {
    cssEditorRef.current?.replaceSelection(text)
  }, [])

  const editorExtensions = useMemo(() => {
    const extensions = []
    
    if (activeTab === 'css') {
      extensions.push(cssLanguage.data.of({ autocomplete: createCssThemeVarsCompletionSource() }))
    }

    if (!isGlobal && componentTemplate?.props) {
      if (activeTab === 'tsx') {
        extensions.push(javascriptLanguage.data.of({ autocomplete: createPropsCompletionSource(componentTemplate.props) }))
      } else if (activeTab === 'css') {
        extensions.push(cssLanguage.data.of({ autocomplete: createCssPropsCompletionSource(componentTemplate.props) }))
      }
    }
    return extensions
  }, [activeTab, isGlobal, componentTemplate])

  return (
    <ModalShell
      isOpen
      onClose={closeModal}
      maxWidth="92vw"
      maxHeight="88vh"
      style={{ width: '1100px', height: '720px', padding: 0, overflow: 'hidden' }}
    >
      <div className={styles.shell}>
        {/* ── Unified header ──────────────────────────────────── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerTitle}>Theme Editor</span>
            <span className={styles.headerCount}>{CSS_MODULE_REGISTRY.length} components</span>
          </div>
          <div className={styles.headerRight}>
            <div className={styles.toggleRow}>
              <span className={styles.toggleLabel}>
                {isGlobal ? 'Global' : selected}
              </span>
              <button
                type="button"
                className={clsx(styles.toggleSwitch, isEnabled && styles.toggleSwitchOn)}
                onClick={handleToggle}
                aria-label={isEnabled ? 'Disable' : 'Enable'}
              />
            </div>
            {activeTab === 'tsx' && !isGlobal && componentTemplate && (
              <button type="button" className={styles.actionBtn} onClick={handleInsertTemplate} title="Reset to starter template">
                <RotateCcw size={12} /> Template
              </button>
            )}
            <button type="button" className={styles.actionBtn} onClick={handleExport} title="Export current file">
              <Download size={12} /> Export
            </button>
            <button type="button" className={styles.actionBtn} onClick={handleImport} title="Import file">
              <Upload size={12} /> Import
            </button>
            <span className={styles.headerDivider} />
            <button type="button" className={styles.actionBtn} onClick={() => { void handleExportPack() }} title="Export .lumitheme bundle">
              <Package size={12} /> Export .lumitheme
            </button>
            <button type="button" className={styles.actionBtn} onClick={() => { void handleImportPack() }} title="Import .lumitheme bundle or legacy JSON pack">
              <Package size={12} /> Import Theme
            </button>
            <button type="button" className={clsx(styles.actionBtn, styles.dangerBtn)} onClick={handleResetAll} title="Reset all overrides">
              <Trash2 size={12} />
            </button>
            <button type="button" className={styles.closeBtn} onClick={closeModal} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Mobile sidebar toggle ──────────────────────────── */}
        <button
          type="button"
          className={styles.mobileToggle}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {sidebarOpen ? 'Hide components' : `Show components (${CSS_MODULE_REGISTRY.length})`}
        </button>

        {/* ── Body ────────────────────────────────────────────── */}
        <div className={styles.body}>
          {/* ── Sidebar ────────────────────────────────────────── */}
          <div className={clsx(styles.sidebar, !sidebarOpen && styles.sidebarCollapsed)}>
            <input
              className={styles.searchInput}
              placeholder="Search components..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className={styles.componentList}>
              {/* Global entry */}
              {(!search.trim() || 'global'.includes(search.toLowerCase())) && (
                <div
                  className={clsx(
                    styles.componentItem,
                    styles.globalItem,
                    selected === GLOBAL_KEY && styles.componentItemActive,
                  )}
                  onClick={() => handleSelect(GLOBAL_KEY)}
                >
                  <div className={styles.componentLeft}>
                    <span className={styles.componentName}>
                      <Globe size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
                      Global
                    </span>
                    <span className={styles.componentDesc}>Non-component CSS overrides</span>
                  </div>
                  <div className={styles.pathIndicators}>
                    <span className={styles.pathBadge}>css</span>
                  </div>
                </div>
              )}

              {[...grouped.entries()].map(([category, entries]) => (
                <div key={category}>
                  <div className={styles.categoryLabel}>{category}</div>
                  {entries.map((entry) => (
                    <div
                      key={entry.cssPath}
                      className={clsx(
                        styles.componentItem,
                        selected === entry.component && styles.componentItemActive,
                        hasOverride(entry.component) && styles.componentItemHasOverride,
                      )}
                      onClick={() => handleSelect(entry.component)}
                    >
                      <div className={styles.componentLeft}>
                        <span className={styles.componentName}>{entry.component}</span>
                        <span className={styles.componentDesc}>{entry.category}</span>
                      </div>
                      <div className={styles.pathIndicators}>
                        <span className={styles.pathBadge}>css</span>
                        {entry.tsxPath && <span className={clsx(styles.pathBadge, styles.pathBadgeTsx)}>tsx</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className={styles.componentDesc} style={{ padding: '12px' }}>No matching components</div>
              )}
            </div>
          </div>

          {/* ── Main: tabs + editor ──────────────────────────── */}
          <div className={styles.main}>
            <div className={styles.tabBar}>
              <div className={styles.tabsLeft}>
                <button
                  type="button"
                  className={clsx(styles.tab, activeTab === 'css' && styles.tabActive)}
                  onClick={() => setActiveTab('css')}
                >
                  <Paintbrush size={13} className={styles.tabIcon} />
                  CSS
                </button>
                {!isGlobal && (
                  <button
                    type="button"
                    className={clsx(styles.tab, activeTab === 'tsx' && styles.tabActive)}
                    onClick={() => setActiveTab('tsx')}
                  >
                    <Code2 size={13} className={styles.tabIcon} />
                    Component
                  </button>
                )}
              </div>
              <div className={styles.tabsRight}>
                {activeTab === 'css' && assetBundleId && (
                  <button 
                    type="button" 
                    className={clsx(styles.panelToggleBtn, showAssets && styles.panelToggleBtnActive)}
                    onClick={() => setShowAssets(!showAssets)}
                  >
                    <ImageIcon size={13} /> Assets
                  </button>
                )}
                <button 
                  type="button" 
                  className={clsx(styles.panelToggleBtn, showReference && styles.panelToggleBtnActive)}
                  onClick={() => setShowReference(!showReference)}
                >
                  {showReference ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
                  Reference
                </button>
              </div>
            </div>

            {/* TSX sandbox notice */}
            {activeTab === 'tsx' && !isGlobal && (
              <div className={styles.tsxNotice}>
                <ShieldAlert size={14} className={styles.tsxNoticeIcon} />
                <span>
                  Editing <span className={styles.tsxComponentLabel}>{selected}</span> — network, storage, and navigation are blocked.
                </span>
              </div>
            )}

            <div className={styles.editorContentRow}>
              <div className={styles.editorMain}>
                <div className={styles.editorContainer}>
                  {activeTab === 'css' ? (
                    <CodeEditor ref={cssEditorRef} key={`css:${selected}`} value={currentCSS} onChange={handleCSSChange} language={cssLang} extensions={editorExtensions} />
                  ) : !isGlobal ? (
                    <CodeEditor key={`tsx:${selected}`} value={effectiveTSX} onChange={handleTSXChange} language={tsxLang} extensions={editorExtensions} />
                  ) : null}
                </div>

                {showAssets && activeTab === 'css' && assetBundleId && (
                  <ThemeAssetsPanel bundleId={assetBundleId} onInsertReference={handleInsertAssetReference} />
                )}
              </div>

              {/* Reference panel — shown based on tab and selection */}
              {showReference && isGlobal && activeTab === 'css' && (
                <div className={styles.editorSidebar}>
                  <CssVariablesReference />
                </div>
              )}
              {showReference && !isGlobal && componentTemplate && (
                <div className={styles.editorSidebar}>
                  {activeTab === 'css' ? <ComponentCssReference componentName={selected} cssContent={GENERATED_COMPONENT_CSS[selected] || ''} /> : <PropsReference props={componentTemplate.props} componentName={selected} />}
                </div>
              )}
            </div>

            <div className={styles.statusBar}>
              <span>
                {validation.status === 'valid' && <span className={styles.statusValid}>Valid {activeTab === 'css' ? 'CSS' : 'TSX'}</span>}
                {validation.status === 'error' && (
                  <span className={styles.statusError} title={validation.error}>Error: {validation.error}</span>
                )}
                {validation.status === 'empty' && <span className={styles.statusEmpty}>Empty</span>}
              </span>
              <div className={styles.statusRight}>
                {byteCount > 0 && <span>{byteCount.toLocaleString()} bytes</span>}
                <span>
                  Emergency disable: <span className={styles.shortcutHint}>Ctrl+Shift+U</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
