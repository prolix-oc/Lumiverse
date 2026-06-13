import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Marked } from 'marked'
import clsx from 'clsx'
import {
  X, Plus, Trash2, Sparkles, ArrowRight, ArrowLeft, RefreshCw, Pencil, Check,
  Shuffle, PenLine, BookOpen, ShieldCheck, AlertTriangle,
  Layers, User, Smile, Image as ImageIcon, Copy, Download, MessageSquare,
  PanelsTopLeft, ChevronRight, ChevronDown, Home, Globe, FileUp,
  SlidersHorizontal, type LucideIcon,
} from 'lucide-react'
import type { WeaverBibleEntry, WeaverBuildType, WeaverFieldKind, WeaverSession, WeaverStage } from '@/api/weaver'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import styles from './WeaverStudio.module.css'

export const STAGES: WeaverStage[] = ['dream', 'readback', 'interview', 'bible', 'render', 'finalize']

const fieldMarked = new Marked({ gfm: true, breaks: true })

const LITERAL_MARKER_KINDS: ReadonlySet<WeaverFieldKind> = new Set(['alichat'])

function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderFieldPreview(kind: WeaverFieldKind, text: string): string {
  const source = LITERAL_MARKER_KINDS.has(kind) ? escapeAngleBrackets(text) : text
  return sanitizeRichHtml(fieldMarked.parse(source, { async: false }) as string)
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.ceil(trimmed.length / 4)
}

export function monogram(name: string): string {
  const words = name.replace(/^the\s+/i, '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return '·'
  if (words.length === 1) return words[0].slice(0, 2)
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function stageIndexOf(session: WeaverSession): number {
  if (session.status === 'finalized') return STAGES.length
  const idx = STAGES.indexOf(session.stage)
  return idx < 0 ? 0 : idx
}

export function timeAgo(ts: number): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  const minutes = Math.floor((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatFinalized(ts: number): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

export function deriveTitle(seedText: string): string {
  const line = seedText.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  if (!line) return ''
  if (line.length <= 44) return line
  const cut = line.slice(0, 44)
  const at = cut.lastIndexOf(' ')
  return `${at > 20 ? cut.slice(0, at) : cut}…`
}

export const ICONS: Record<string, LucideIcon> = {
  x: X, plus: Plus, trash: Trash2, sparkles: Sparkles, arrowRight: ArrowRight,
  arrowLeft: ArrowLeft, refresh: RefreshCw, pencil: Pencil, check: Check,
  shuffle: Shuffle, penLine: PenLine, bookOpen: BookOpen, shield: ShieldCheck,
  alert: AlertTriangle,
  layers: Layers, user: User, smile: Smile, image: ImageIcon, copy: Copy,
  download: Download, chat: MessageSquare, build: PanelsTopLeft,
  chevronRight: ChevronRight, chevronDown: ChevronDown,
  home: Home, globe: Globe, fileUp: FileUp, settings: SlidersHorizontal,
}

export const BUILD_TYPE_ICONS: Record<string, string> = {
  character: 'user', world: 'globe', import: 'fileUp',
}

export function tileIconFor(buildType: WeaverBuildType | undefined): string | null {
  if (!buildType?.hub) return null
  return BUILD_TYPE_ICONS[buildType.id] ?? 'sparkles'
}

export function Icon({ name, size = 16, className, spin }: { name: string; size?: number; className?: string; spin?: boolean }) {
  const C = ICONS[name]
  if (!C) return null
  return <C size={size} className={spin ? clsx(styles.spin, className) : className} />
}

const TILE_CLS: Record<number, string> = { 40: styles.tile40, 32: styles.tile32, 24: styles.tile24 }
const TILE_ICON_SIZE: Record<number, number> = { 40: 17, 32: 15, 24: 12 }

export function Tile({ name, icon, size = 40, empty }: { name: string; icon?: string | null; size?: 40 | 32 | 24; empty?: boolean }) {
  if (empty) {
    return (
      <span className={clsx(styles.tile, TILE_CLS[size], styles.tileEmpty)} aria-hidden="true">
        <Icon name="plus" size={12} />
      </span>
    )
  }
  return (
    <span className={clsx(styles.tile, TILE_CLS[size])} aria-hidden="true">
      {icon ? <Icon name={icon} size={TILE_ICON_SIZE[size]} /> : monogram(name)}
    </span>
  )
}

export function StageTicks({ stage, word, compact, stretch }: { stage: number; word?: boolean; compact?: boolean; stretch?: boolean }) {
  const { t } = useTranslation('weaver')
  return (
    <span className={clsx(styles.ticksWrap, compact && styles.ticksWrapCompact, stretch && styles.ticksStretch)}>
      <span className={styles.ticks}>
        {STAGES.map((s, i) => (
          <span
            key={s}
            title={t(`stages.${s}`)}
            className={clsx(styles.tick, i < stage && styles.tickDone, i === stage && styles.tickActive)}
          />
        ))}
      </span>
      {word && (
        <span className={clsx(styles.ticksWord, stage > 0 && styles.ticksWordOn)}>
          {stage >= STAGES.length ? t('stages.finalize') : t(`stages.${STAGES[stage]}`)}
        </span>
      )}
    </span>
  )
}

export function KindChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return <span className={styles.kindChip} title={title}>{children}</span>
}

interface BtnProps {
  variant?: 'primary' | 'ghost'
  icon?: string | null
  iconRight?: string | null
  spin?: boolean
  children?: React.ReactNode
  className?: string
  disabled?: boolean
  title?: string
  onClick?: () => void
}
export function Btn({ variant = 'ghost', icon, iconRight, spin, children, className, disabled, title, onClick }: BtnProps) {
  return (
    <button
      type="button"
      className={clsx(styles.btn, variant === 'primary' ? styles.btnPrimary : styles.btnGhost, className)}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon && <Icon name={spin ? 'refresh' : icon} size={15} spin={spin} />}
      {children && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={15} />}
    </button>
  )
}

interface IconBtnProps {
  icon: string
  size?: number
  cls?: string
  spin?: boolean
  title: string
  disabled?: boolean
  onClick?: (e: React.MouseEvent) => void
  onMouseDown?: (e: React.MouseEvent) => void
}
export function IconBtn({ icon, size = 15, cls, spin, title, disabled, onClick, onMouseDown }: IconBtnProps) {
  return (
    <button
      type="button"
      className={clsx(styles.iconBtn, cls)}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      <Icon name={icon} size={size} spin={spin} />
    </button>
  )
}

const TAG_KIND: Record<string, string> = {
  neutral: styles.tagNeutral,
  warning: styles.tagWarning,
  success: styles.tagSuccess,
}
export function Tag({ kind = 'neutral', icon, children }: { kind?: 'neutral' | 'warning' | 'success'; icon?: string; children: React.ReactNode }) {
  return (
    <span className={clsx(styles.tag, TAG_KIND[kind])}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  )
}

const SDOT_CLS: Record<string, string> = {
  passed: styles.sdotPassed,
  flagged: styles.sdotFlagged,
  rendering: styles.sdotRendering,
  stale: styles.sdotStale,
  committed: styles.sdotCommitted,
  elicit: styles.sdotElicit,
  mixed: styles.sdotMixed,
  generate: styles.sdotGenerate,
  none: styles.sdotNone,
}
export function SDot({ status }: { status: string }) {
  return <span className={clsx(styles.sdot, SDOT_CLS[status] ?? styles.sdotNone)} />
}

export function Band({ label, count, hint, children }: {
  label: string
  count?: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className={styles.bandLabel}>
        <span>{label}</span>
        {count != null && <span className={styles.bandCount}>{count}</span>}
        {hint != null && <span className={styles.bandHint}>{hint}</span>}
      </div>
      {children}
    </section>
  )
}

export function Placeholder({ icon, spin, children }: { icon: string; spin?: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.placeholder}>
      <Icon name={icon} size={26} spin={spin} />
      <p>{children}</p>
    </div>
  )
}

export function StageRunning({ label, icon = 'refresh', onBack, backLabel }: { label: string; icon?: string; onBack: () => void; backLabel: string }) {
  return (
    <>
      <div className={styles.panel}>
        <Placeholder icon={icon} spin={icon === 'refresh'}>{label}</Placeholder>
      </div>
      <div className={styles.footer}>
        <Btn icon="arrowLeft" onClick={onBack}>{backLabel}</Btn>
        <div className={styles.spacer} />
      </div>
    </>
  )
}

interface FlagBandProps {
  subject?: string
  criteria?: string[]
  detail?: string
  fix?: string
  fixSteps?: string[]
  note: string
  inField?: boolean
  compact?: boolean
  action?: { label: string; onClick: () => void }
}
export function FlagBand({ subject, criteria, detail, fix, fixSteps, note, inField, compact, action }: FlagBandProps) {
  const { t } = useTranslation('weaver')
  const title = subject
    ? <><b>{subject}</b> {t('render.flag.needsPass')}</>
    : t('render.flag.needsPass')

  if (compact) {
    return (
      <div className={clsx(styles.flagband, styles.flagbandCompact)}>
        <div className={styles.flagbandHead}>
          <Icon name="alert" size={16} />
          <span className={styles.flagbandTitle}>{title}</span>
          {criteria?.map((c) => <Tag key={c} kind="warning">{c}</Tag>)}
        </div>
        {detail && <div className={styles.flagbandBody}>{detail}</div>}
        <div className={styles.flagbandFoot}>
          <span className={styles.flagbandNoteInline}><Icon name="shield" size={13} /> {note}</span>
          {action && <Btn className={styles.btnTiny} iconRight="arrowRight" onClick={action.onClick}>{action.label}</Btn>}
        </div>
      </div>
    )
  }

  return (
    <div className={clsx(styles.flagband, inField && styles.flagbandInField)}>
      <div className={styles.flagbandHead}>
        <Icon name="alert" size={16} />
        <span className={styles.flagbandTitle}>{title}</span>
      </div>
      {criteria && criteria.length > 0 && (
        <div className={styles.flagbandCrit}>
          {criteria.map((c) => <Tag key={c} kind="warning">{c}</Tag>)}
        </div>
      )}
      {detail && <div className={styles.flagbandBody}>{detail}</div>}
      {fix && (
        <div className={styles.flagbandSection}>
          <div className={styles.flagbandSectionLabel}>{t('render.flag.whatToDo')}</div>
          <div className={styles.flagbandBody}>{fix}</div>
        </div>
      )}
      {fixSteps && fixSteps.length > 0 && (
        <div className={styles.flagbandSection}>
          <div className={styles.flagbandSectionLabel}>{t('render.flag.tryNext')}</div>
          <div className={clsx(styles.flagbandBody, styles.flagbandSteps)}>
            {fixSteps.map((s, i) => <div key={i}>· {s}</div>)}
          </div>
        </div>
      )}
      <div className={styles.flagbandNote}>
        <Icon name="shield" size={14} />
        <span>{note}</span>
      </div>
    </div>
  )
}

export function FactLine({ value, empty, onChange, onDelete }: { value: string; empty?: boolean; onChange: (v: string) => void; onDelete?: () => void }) {
  const { t } = useTranslation('weaver')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(draft.length, draft.length)
    }
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => { setEditing(false); if (draft !== value) onChange(draft) }

  if (editing) {
    return (
      <div className={styles.factEdit}>
        <div className={styles.factEditRow}>
          <textarea
            ref={ref}
            className={styles.factarea}
            rows={Math.max(2, Math.ceil((draft.length || 1) / 52))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
              if (e.key === 'Escape') { setDraft(value); setEditing(false) }
            }}
            onBlur={commit}
          />
          {onDelete && (
            <IconBtn icon="trash" cls={styles.sq28} title={t('readback.delete')} onMouseDown={(e) => { e.preventDefault(); onDelete() }} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={clsx(styles.factline, empty && styles.factlineEmpty)}
      tabIndex={0}
      onClick={() => { setDraft(value); setEditing(true) }}
      onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(value); setEditing(true) } }}
    >
      {empty ? t('readback.emptyFact') : value}
      <span className={styles.factEditCue}><Icon name="pencil" size={13} /></span>
    </div>
  )
}

export function EditableProse({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('weaver')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (editing && ref.current) ref.current.focus() }, [editing])
  const commit = () => { setEditing(false); if (draft !== value) onChange(draft) }

  if (editing) {
    return (
      <textarea
        ref={ref}
        className={styles.factarea}
        rows={Math.max(3, Math.ceil((draft.length || 1) / 64))}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
        }}
      />
    )
  }

  return (
    <div
      className={styles.factline}
      style={{ maxWidth: '70ch' }}
      tabIndex={0}
      onClick={() => { setDraft(value); setEditing(true) }}
      onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(value); setEditing(true) } }}
    >
      <span className={styles.originProse}>{value || t('bible.emptyEntry')}</span>
      <span className={styles.factEditCue}><Icon name="pencil" size={13} /></span>
    </div>
  )
}

export function OriginTag({ origin }: { origin: WeaverBibleEntry['origin'] }) {
  const { t } = useTranslation('weaver')
  if (origin === 'authored') return <Tag kind="neutral">{t('bible.origin.authored')}</Tag>
  if (origin === 'inferred') return <Tag kind="warning">{t('bible.origin.inferred')}</Tag>
  if (origin === 'established') return <Tag kind="success">{t('bible.origin.established')}</Tag>
  return null
}
