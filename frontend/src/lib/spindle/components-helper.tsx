import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import clsx from 'clsx'
import type {
  SpindleComponentTarget,
  SpindleComponentsHelper,
  SpindleConnectionRef,
  SpindleMountedComponent,
  SpindleTextInputOptions,
  SpindleTextInputHandle,
  SpindleTextAreaOptions,
  SpindleTextAreaHandle,
  SpindleNumericInputOptions,
  SpindleNumericInputHandle,
  SpindleNumberStepperOptions,
  SpindleNumberStepperHandle,
  SpindleRangeSliderOptions,
  SpindleRangeSliderHandle,
  SpindleRangeSliderFormat,
  SpindleCheckboxOptions,
  SpindleCheckboxHandle,
  SpindleSwitchOptions,
  SpindleSwitchHandle,
  SpindleSelectOption,
  SpindleSelectOptionLeading,
  SpindleSelectOptions,
  SpindleSelectHandle,
  SpindleMultiSelectOptions,
  SpindleMultiSelectHandle,
  SpindleModelComboboxOptions,
  SpindleModelComboboxHandle,
  SpindleFolderDropdownOptions,
  SpindleFolderDropdownHandle,
  SpindleBadgeOptions,
  SpindleBadgeHandle,
  SpindleSpinnerOptions,
  SpindleSpinnerHandle,
  SpindleCollapsibleSectionOptions,
  SpindleCollapsibleSectionHandle,
  SpindlePaginationOptions,
  SpindlePaginationHandle,
  SpindleCloseButtonOptions,
  SpindleCloseButtonHandle,
} from 'lumiverse-spindle-types'

import { TextInput, TextArea } from '@/components/shared/FormComponents'
import formStyles from '@/components/shared/FormComponents.module.css'
import NumericInput from '@/components/shared/NumericInput'
import NumberStepper from '@/components/shared/NumberStepper'
import { RangeSlider, LabeledRangeSlider } from '@/components/shared/RangeSlider'
import { Toggle } from '@/components/shared/Toggle'
import { Badge } from '@/components/shared/Badge'
import { Spinner } from '@/components/shared/Spinner'
import { CloseButton } from '@/components/shared/CloseButton'
import Pagination from '@/components/shared/Pagination'
import CollapsibleSection from '@/components/shared/CollapsibleSection'
import SearchableSelect, { type SearchableSelectOption } from '@/components/shared/SearchableSelect'
import FolderDropdown from '@/components/shared/FolderDropdown'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'

import { useStore } from '@/store'
import { connectionsApi } from '@/api/connections'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { ttsConnectionsApi } from '@/api/tts-connections'

// ── Tracking & lifecycle ──────────────────────────────────────────────────

interface TrackedMount {
  root: Root
  destroy(): void
}

const mountsByExtension = new Map<string, Set<TrackedMount>>()
let idCounter = 0

function nextId(extensionId: string, kind: string): string {
  return `spindle:${extensionId}:component:${kind}:${++idCounter}`
}

function track(extensionId: string, mount: TrackedMount): void {
  let set = mountsByExtension.get(extensionId)
  if (!set) {
    set = new Set()
    mountsByExtension.set(extensionId, set)
  }
  set.add(mount)
}

function untrack(extensionId: string, mount: TrackedMount): void {
  mountsByExtension.get(extensionId)?.delete(mount)
}

export function destroyAllComponentsForExtension(extensionId: string): void {
  const set = mountsByExtension.get(extensionId)
  if (!set) return
  for (const m of [...set]) {
    try { m.destroy() } catch { /* no-op */ }
  }
  mountsByExtension.delete(extensionId)
}

function resolveTarget(target: SpindleComponentTarget): HTMLElement {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (!(el instanceof HTMLElement)) {
    throw new Error('components.mount*(): target must resolve to an HTMLElement')
  }
  return el
}

// ── Generic bridge primitive ──────────────────────────────────────────────

interface BridgeAPI<TOptions, TValue> {
  update(patch: Partial<TOptions>): void
  getValue(): TValue
  focus?(): void
  blur?(): void
  refresh?(): void
  open?(): void
  close?(): void
  isExpanded?(): boolean
  body?: HTMLElement
}

interface MountResult<TOptions, TValue> {
  bridge: BridgeAPI<TOptions, TValue>
  root: Root
}

function mountBridge<TOptions, TValue>(
  target: HTMLElement,
  render: (bridge: BridgeAPI<TOptions, TValue>) => ReactElement,
): MountResult<TOptions, TValue> {
  const bridge: BridgeAPI<TOptions, TValue> = {
    update: () => {},
    getValue: () => undefined as unknown as TValue,
  }
  const root = createRoot(target)
  flushSync(() => {
    root.render(render(bridge))
  })
  return { bridge, root }
}

function buildHandle<TOptions, TValue>(
  extensionId: string,
  componentId: string,
  target: HTMLElement,
  mount: MountResult<TOptions, TValue>,
): SpindleMountedComponent<TOptions> & { getValue(): TValue } & Omit<BridgeAPI<TOptions, TValue>, 'update' | 'getValue'> {
  const tracked: TrackedMount = {
    root: mount.root,
    destroy() {
      try {
        mount.root.unmount()
      } catch { /* no-op */ }
      untrack(extensionId, tracked)
    },
  }
  track(extensionId, tracked)
  const handle = {
    componentId,
    element: target,
    update: (patch: Partial<TOptions>) => mount.bridge.update(patch),
    destroy: () => tracked.destroy(),
    getValue: () => mount.bridge.getValue(),
    focus: () => mount.bridge.focus?.(),
    blur: () => mount.bridge.blur?.(),
    refresh: () => mount.bridge.refresh?.(),
    open: () => mount.bridge.open?.(),
    close: () => mount.bridge.close?.(),
    isExpanded: () => mount.bridge.isExpanded?.() ?? false,
    get body() { return mount.bridge.body as HTMLElement },
  }
  return handle as SpindleMountedComponent<TOptions> & { getValue(): TValue } & Omit<BridgeAPI<TOptions, TValue>, 'update' | 'getValue'>
}

// Hook that wires a bridge's update/getValue to local state.
function useBridgeBinding<TOptions, TValue>(
  bridge: BridgeAPI<TOptions, TValue>,
  props: TOptions,
  setProps: (next: TOptions | ((prev: TOptions) => TOptions)) => void,
  value: TValue,
  setValue: (next: TValue) => void,
  valueKey?: keyof TOptions,
): void {
  const valueRef = useRef(value)
  valueRef.current = value
  useLayoutEffect(() => {
    bridge.update = (patch) => {
      setProps((prev) => ({ ...prev, ...patch }))
      if (valueKey && patch[valueKey] !== undefined) {
        setValue(patch[valueKey] as unknown as TValue)
      }
    }
    bridge.getValue = () => valueRef.current
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Sync valueKey patches that arrive via update — already handled in setProps callback.
  // Nothing else needed here.
  void props
}

// ── Connection binding (LLM / Image / TTS) ────────────────────────────────

interface NormalizedModelList {
  models: string[]
  modelLabels: Record<string, string>
}

function useConnectionModels(connection: SpindleConnectionRef | undefined): {
  models: string[]
  modelLabels: Record<string, string>
  loading: boolean
  refresh: () => void
} {
  const activeId = useStore((s) => {
    if (!connection) return null
    if (connection.id) return connection.id
    if (connection.kind === 'llm') return s.activeProfileId ?? null
    if (connection.kind === 'image') return s.activeImageGenConnectionId ?? null
    if (connection.kind === 'tts') return s.voiceSettings?.ttsConnectionId ?? null
    return null
  })

  const [data, setData] = useState<NormalizedModelList>({ models: [], modelLabels: {} })
  const [loading, setLoading] = useState(false)
  const inflight = useRef(0)

  const refresh = useMemo(() => {
    return async () => {
      if (!connection || !activeId) {
        setData({ models: [], modelLabels: {} })
        return
      }
      const token = ++inflight.current
      setLoading(true)
      try {
        if (connection.kind === 'llm') {
          const r = await connectionsApi.models(activeId)
          if (token !== inflight.current) return
          setData({ models: r.models ?? [], modelLabels: r.model_labels ?? {} })
        } else if (connection.kind === 'image') {
          const r = await imageGenConnectionsApi.models(activeId)
          if (token !== inflight.current) return
          const ids = (r.models ?? []).map((m) => m.id)
          const labels: Record<string, string> = {}
          for (const m of r.models ?? []) labels[m.id] = m.label
          setData({ models: ids, modelLabels: labels })
        } else if (connection.kind === 'tts') {
          const r = await ttsConnectionsApi.models(activeId)
          if (token !== inflight.current) return
          const ids = (r.models ?? []).map((m) => m.id)
          const labels: Record<string, string> = {}
          for (const m of r.models ?? []) labels[m.id] = m.label
          setData({ models: ids, modelLabels: labels })
        } else if (connection.kind === 'embedding') {
          throw new Error(
            'mountModelCombobox: connection.kind "embedding" is not yet supported in connection-bound mode. Use manual `models` instead.',
          )
        }
      } catch (err) {
        if (token === inflight.current) {
          setData({ models: [], modelLabels: {} })
          console.warn('[spindle:components] connection model fetch failed', err)
        }
      } finally {
        if (token === inflight.current) setLoading(false)
      }
    }
  }, [connection?.kind, connection?.id, activeId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { models: data.models, modelLabels: data.modelLabels, loading, refresh: () => { void refresh() } }
}

// ── Leading-cell renderer for select options ──────────────────────────────

function LeadingInitial({ text, background, color }: { text: string; background?: string; color?: string }) {
  return (
    <span
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        background: background ?? 'var(--surface-2, rgba(255,255,255,0.08))',
        color: color ?? 'var(--text-2, currentColor)',
        fontSize: '11px',
        fontWeight: 600,
        lineHeight: 1,
        overflow: 'hidden',
      }}
    >
      {text}
    </span>
  )
}

function LeadingImage({
  src,
  alt,
  rounded,
  fallback,
}: {
  src: string
  alt?: string
  rounded?: boolean
  fallback?: { text: string; background?: string; color?: string }
}) {
  const [errored, setErrored] = useState(false)
  if (!src || errored) {
    if (fallback) return <LeadingInitial {...fallback} />
    return null
  }
  return (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      onError={() => setErrored(true)}
      style={{ borderRadius: rounded === false ? '4px' : '50%' }}
    />
  )
}

function renderLeading(leading: SpindleSelectOptionLeading | undefined): ReactElement | null {
  if (!leading) return null
  switch (leading.type) {
    case 'image':
      return (
        <LeadingImage
          src={leading.src}
          alt={leading.alt}
          rounded={leading.rounded}
          fallback={leading.fallback}
        />
      )
    case 'icon-url':
      return <img src={leading.url} alt={leading.alt ?? ''} loading="lazy" />
    case 'icon-svg':
      return (
        <span
          aria-hidden
          dangerouslySetInnerHTML={{ __html: leading.svg }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            color: leading.color ?? 'currentColor',
          }}
        />
      )
    case 'swatch':
      return (
        <span
          aria-hidden
          style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            background: leading.color,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.2) inset',
          }}
        />
      )
    case 'initial':
      return <LeadingInitial text={leading.text} background={leading.background} color={leading.color} />
    default:
      return null
  }
}

function adaptSelectOptions(options: SpindleSelectOption[] | undefined): SearchableSelectOption[] {
  if (!options) return []
  return options.map((o) => ({
    value: o.value,
    label: o.label,
    sublabel: o.sublabel,
    group: o.group,
    disabled: o.disabled,
    leading: renderLeading(o.leading),
  }))
}

// ── Bridge components (one per mountable component) ───────────────────────

function TextInputBridge({ initial, bridge }: { initial: SpindleTextInputOptions; bridge: BridgeAPI<SpindleTextInputOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState(initial.value ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  useLayoutEffect(() => {
    bridge.focus = () => inputRef.current?.focus()
    bridge.blur = () => inputRef.current?.blur()
  }, [bridge])

  return (
    <TextInput
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v) }}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      className={props.className}
      aria-label={props.ariaLabel}
      ref={inputRef}
    />
  )
}

function TextAreaBridge({ initial, bridge }: { initial: SpindleTextAreaOptions; bridge: BridgeAPI<SpindleTextAreaOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState(initial.value ?? '')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  useLayoutEffect(() => {
    bridge.focus = () => taRef.current?.focus()
    bridge.blur = () => taRef.current?.blur()
  }, [bridge])

  return (
    <TextArea
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v) }}
      placeholder={props.placeholder}
      rows={props.rows}
      disabled={props.disabled}
      className={props.className}
      aria-label={props.ariaLabel}
      ref={taRef}
    />
  )
}

function NumericInputBridge({ initial, bridge }: { initial: SpindleNumericInputOptions; bridge: BridgeAPI<SpindleNumericInputOptions, number | null> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<number | null>(initial.value ?? null)
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <NumericInput
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v) }}
      allowEmpty={props.allowEmpty}
      integer={props.integer}
      min={props.min}
      max={props.max}
      step={props.step}
      placeholder={props.placeholder}
      disabled={props.disabled}
      className={clsx(formStyles.input, props.className)}
      aria-label={props.ariaLabel}
    />
  )
}

function NumberStepperBridge({ initial, bridge }: { initial: SpindleNumberStepperOptions; bridge: BridgeAPI<SpindleNumberStepperOptions, number | null> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<number | null>(initial.value ?? null)
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <NumberStepper
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v) }}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      allowEmpty={props.allowEmpty}
      placeholder={props.placeholder}
      className={props.className}
    />
  )
}

function buildRangeSliderFormatter(
  format: SpindleRangeSliderFormat | undefined,
  step: number,
  integer: boolean,
): (val: number) => string {
  const decimals = format?.decimals ?? (integer ? 0 : (String(step).split('.')[1] || '').length)
  const prefix = format?.prefix ?? ''
  const suffix = format?.suffix ?? ''
  return (val) => {
    const num = decimals === 0 ? String(Math.round(val)) : val.toFixed(decimals)
    return `${prefix}${num}${suffix}`
  }
}

function RangeSliderBridge({ initial, bridge }: { initial: SpindleRangeSliderOptions; bridge: BridgeAPI<SpindleRangeSliderOptions, number> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<number>(initial.value ?? initial.min)
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')

  const handleCommit = (v: number) => {
    setValue(v)
    props.onCommit?.(v)
  }

  const handleDragValue = (v: number | null) => {
    props.onDragValue?.(v)
  }

  const sharedProps = {
    min: props.min,
    max: props.max,
    step: props.step,
    integer: props.integer,
    value,
    disabled: props.disabled,
    className: props.className,
    onCommit: handleCommit,
    onDragValue: handleDragValue,
  }

  if (props.label !== undefined) {
    const formatValue = buildRangeSliderFormatter(props.format, props.step ?? 1, props.integer ?? false)
    return (
      <LabeledRangeSlider
        label={props.label}
        hint={props.hint}
        formatValue={formatValue}
        {...sharedProps}
      />
    )
  }

  return <RangeSlider {...sharedProps} />
}

function CheckboxBridge({ initial, bridge }: { initial: SpindleCheckboxOptions; bridge: BridgeAPI<SpindleCheckboxOptions, boolean> }) {
  const [props, setProps] = useState(initial)
  const [checked, setChecked] = useState<boolean>(initial.checked ?? false)
  useBridgeBinding(bridge, props, setProps, checked, setChecked, 'checked')
  return (
    <Toggle.Checkbox
      checked={checked}
      onChange={(b) => { setChecked(b); props.onChange?.(b) }}
      label={props.label}
      hint={props.hint}
      disabled={props.disabled}
      className={props.className}
    />
  )
}

function SwitchBridge({ initial, bridge }: { initial: SpindleSwitchOptions; bridge: BridgeAPI<SpindleSwitchOptions, boolean> }) {
  const [props, setProps] = useState(initial)
  const [checked, setChecked] = useState<boolean>(initial.checked ?? false)
  useBridgeBinding(bridge, props, setProps, checked, setChecked, 'checked')
  return (
    <Toggle.Switch
      checked={checked}
      onChange={(b) => { setChecked(b); props.onChange?.(b) }}
      size={props.size}
      disabled={props.disabled}
      className={props.className}
    />
  )
}

function SelectBridge({ initial, bridge }: { initial: SpindleSelectOptions; bridge: BridgeAPI<SpindleSelectOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string>(initial.value ?? '')
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <SearchableSelect
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v) }}
      options={adaptSelectOptions(props.options)}
      placeholder={props.placeholder}
      searchPlaceholder={props.searchPlaceholder}
      searchThreshold={props.searchThreshold}
      emptyMessage={props.emptyMessage}
      noResultsMessage={props.noResultsMessage}
      triggerLabel={props.triggerLabel}
      triggerIcon={renderLeading(props.triggerIcon)}
      triggerClassName={props.triggerClassName}
      ariaLabel={props.ariaLabel}
      portal={props.portal}
      align={props.align}
      maxHeight={props.maxHeight}
      minWidth={props.minWidth}
      disabled={props.disabled}
      className={props.className}
      clearable={props.clearable}
      clearLabel={props.clearLabel}
    />
  )
}

function MultiSelectBridge({ initial, bridge }: { initial: SpindleMultiSelectOptions; bridge: BridgeAPI<SpindleMultiSelectOptions, string[]> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string[]>(initial.value ?? [])
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <SearchableSelect
      multi
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v) }}
      options={adaptSelectOptions(props.options)}
      placeholder={props.placeholder}
      searchPlaceholder={props.searchPlaceholder}
      searchThreshold={props.searchThreshold}
      emptyMessage={props.emptyMessage}
      noResultsMessage={props.noResultsMessage}
      triggerLabel={props.triggerLabel}
      triggerIcon={renderLeading(props.triggerIcon)}
      triggerClassName={props.triggerClassName}
      ariaLabel={props.ariaLabel}
      portal={props.portal}
      align={props.align}
      maxHeight={props.maxHeight}
      minWidth={props.minWidth}
      disabled={props.disabled}
      className={props.className}
    />
  )
}

function ModelComboboxBridge({ initial, bridge }: { initial: SpindleModelComboboxOptions; bridge: BridgeAPI<SpindleModelComboboxOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string>(initial.value ?? '')
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')

  const bound = useConnectionModels(props.connection)
  const usingConnection = !!props.connection
  const models = usingConnection ? bound.models : (props.models ?? [])
  const modelLabels = usingConnection ? bound.modelLabels : (props.modelLabels ?? {})
  const loading = usingConnection ? bound.loading : !!props.loading
  const onRefresh = usingConnection ? bound.refresh : props.onRefresh

  useLayoutEffect(() => {
    bridge.refresh = () => onRefresh?.()
  }, [bridge, onRefresh])

  return (
    <ModelCombobox
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v) }}
      models={models}
      modelLabels={modelLabels}
      loading={loading}
      onRefresh={onRefresh}
      disabled={props.disabled}
      placeholder={props.placeholder}
      autoRefreshOnFocus={props.autoRefreshOnFocus}
      refreshKey={props.refreshKey}
      emptyMessage={props.emptyMessage}
      loadingMessage={props.loadingMessage}
      browseHint={props.browseHint}
      appearance={props.appearance ?? 'compact'}
    />
  )
}

function FolderDropdownBridge({ initial, bridge }: { initial: SpindleFolderDropdownOptions; bridge: BridgeAPI<SpindleFolderDropdownOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string>(initial.value ?? '')
  useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <FolderDropdown
      folders={props.folders ?? []}
      selectedFolder={value}
      onSelect={(f) => { setValue(f); props.onChange?.(f) }}
      onCreateFolder={(name) => props.onCreateFolder?.(name)}
      placeholder={props.placeholder}
      className={props.className}
    />
  )
}

function BadgeBridge({ initial, bridge }: { initial: SpindleBadgeOptions; bridge: BridgeAPI<SpindleBadgeOptions, string> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, props.text ?? '', () => {}, undefined)
  return (
    <Badge color={props.color ?? 'neutral'} size={props.size ?? 'md'} className={props.className}>
      {props.text ?? ''}
    </Badge>
  )
}

function SpinnerBridge({ initial, bridge }: { initial: SpindleSpinnerOptions; bridge: BridgeAPI<SpindleSpinnerOptions, void> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, undefined as void, () => {}, undefined)
  return <Spinner size={props.size} fast={props.fast} className={props.className} />
}

function CloseButtonBridge({ initial, bridge }: { initial: SpindleCloseButtonOptions; bridge: BridgeAPI<SpindleCloseButtonOptions, void> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, undefined as void, () => {}, undefined)
  return (
    <CloseButton
      onClick={() => props.onClick?.()}
      size={props.size}
      variant={props.variant}
      position={props.position}
      iconSize={props.iconSize}
      className={props.className}
    />
  )
}

function PaginationBridge({ initial, bridge }: { initial: SpindlePaginationOptions; bridge: BridgeAPI<SpindlePaginationOptions, number> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, props.currentPage, () => {}, undefined)
  return (
    <Pagination
      currentPage={props.currentPage}
      totalPages={props.totalPages}
      onPageChange={(p) => props.onPageChange(p)}
      perPage={props.perPage}
      perPageOptions={props.perPageOptions}
      onPerPageChange={(n) => props.onPerPageChange?.(n)}
      totalItems={props.totalItems}
    />
  )
}

function CollapsibleSectionBridge({
  initial,
  bridge,
  bodyEl,
}: {
  initial: SpindleCollapsibleSectionOptions
  bridge: BridgeAPI<SpindleCollapsibleSectionOptions, boolean>
  bodyEl: HTMLElement
}) {
  const [props, setProps] = useState(initial)
  const [expanded, setExpanded] = useState<boolean>(initial.defaultExpanded ?? true)
  useBridgeBinding(bridge, props, setProps, expanded, setExpanded, undefined)
  useLayoutEffect(() => {
    bridge.isExpanded = () => expanded
    bridge.open = () => setExpanded(true)
    bridge.close = () => setExpanded(false)
    bridge.body = bodyEl
  }, [bridge, expanded, bodyEl])

  // Compose icon from svg/url prop into ReactNode
  const icon: ReactElement | null = props.iconSvg
    ? <span dangerouslySetInnerHTML={{ __html: props.iconSvg }} />
    : props.iconUrl
      ? <img src={props.iconUrl} alt="" />
      : null

  return (
    <CollapsibleSection
      title={props.title}
      icon={icon}
      badge={props.badge}
      expanded={expanded}
      onToggle={(next) => { setExpanded(next); props.onToggle?.(next) }}
      className={props.className}
    >
      <Slot el={bodyEl} />
    </CollapsibleSection>
  )
}

/** Renders a host-managed element into the React tree without React owning its children. */
function Slot({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const wrap = ref.current
    if (!wrap) return
    if (el.parentElement !== wrap) wrap.appendChild(el)
    return () => {
      if (el.parentElement === wrap) wrap.removeChild(el)
    }
  }, [el])
  return <div ref={ref} />
}

// ── Public factory ────────────────────────────────────────────────────────

export function createComponentsHelper(extensionId: string): SpindleComponentsHelper {
  function mountText(target: SpindleComponentTarget, options?: SpindleTextInputOptions): SpindleTextInputHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'text-input')
    const result = mountBridge<SpindleTextInputOptions, string>(el, (b) => (
      <TextInputBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleTextInputHandle
  }
  function mountTextArea(target: SpindleComponentTarget, options?: SpindleTextAreaOptions): SpindleTextAreaHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'text-area')
    const result = mountBridge<SpindleTextAreaOptions, string>(el, (b) => (
      <TextAreaBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleTextAreaHandle
  }
  function mountNumericInput(target: SpindleComponentTarget, options?: SpindleNumericInputOptions): SpindleNumericInputHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'numeric-input')
    const result = mountBridge<SpindleNumericInputOptions, number | null>(el, (b) => (
      <NumericInputBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleNumericInputHandle
  }
  function mountNumberStepper(target: SpindleComponentTarget, options?: SpindleNumberStepperOptions): SpindleNumberStepperHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'number-stepper')
    const result = mountBridge<SpindleNumberStepperOptions, number | null>(el, (b) => (
      <NumberStepperBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleNumberStepperHandle
  }
  function mountRangeSlider(target: SpindleComponentTarget, options: SpindleRangeSliderOptions): SpindleRangeSliderHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'range-slider')
    const result = mountBridge<SpindleRangeSliderOptions, number>(el, (b) => (
      <RangeSliderBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleRangeSliderHandle
  }
  function mountCheckbox(target: SpindleComponentTarget, options?: SpindleCheckboxOptions): SpindleCheckboxHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'checkbox')
    const result = mountBridge<SpindleCheckboxOptions, boolean>(el, (b) => (
      <CheckboxBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleCheckboxHandle
  }
  function mountSwitch(target: SpindleComponentTarget, options?: SpindleSwitchOptions): SpindleSwitchHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'switch')
    const result = mountBridge<SpindleSwitchOptions, boolean>(el, (b) => (
      <SwitchBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleSwitchHandle
  }
  function mountSelect(target: SpindleComponentTarget, options: SpindleSelectOptions): SpindleSelectHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'select')
    const result = mountBridge<SpindleSelectOptions, string>(el, (b) => (
      <SelectBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleSelectHandle
  }
  function mountMultiSelect(target: SpindleComponentTarget, options: SpindleMultiSelectOptions): SpindleMultiSelectHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'multi-select')
    const result = mountBridge<SpindleMultiSelectOptions, string[]>(el, (b) => (
      <MultiSelectBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleMultiSelectHandle
  }
  function mountModelCombobox(target: SpindleComponentTarget, options: SpindleModelComboboxOptions): SpindleModelComboboxHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'model-combobox')
    const result = mountBridge<SpindleModelComboboxOptions, string>(el, (b) => (
      <ModelComboboxBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleModelComboboxHandle
  }
  function mountFolderDropdown(target: SpindleComponentTarget, options: SpindleFolderDropdownOptions): SpindleFolderDropdownHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'folder-dropdown')
    const result = mountBridge<SpindleFolderDropdownOptions, string>(el, (b) => (
      <FolderDropdownBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleFolderDropdownHandle
  }
  function mountBadge(target: SpindleComponentTarget, options: SpindleBadgeOptions): SpindleBadgeHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'badge')
    const result = mountBridge<SpindleBadgeOptions, string>(el, (b) => (
      <BadgeBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleBadgeHandle
  }
  function mountSpinner(target: SpindleComponentTarget, options?: SpindleSpinnerOptions): SpindleSpinnerHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'spinner')
    const result = mountBridge<SpindleSpinnerOptions, void>(el, (b) => (
      <SpinnerBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleSpinnerHandle
  }
  function mountCollapsibleSection(target: SpindleComponentTarget, options: SpindleCollapsibleSectionOptions): SpindleCollapsibleSectionHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'collapsible')
    const bodyEl = document.createElement('div')
    bodyEl.setAttribute('data-spindle-collapsible-body', id)
    const result = mountBridge<SpindleCollapsibleSectionOptions, boolean>(el, (b) => (
      <CollapsibleSectionBridge initial={options} bridge={b} bodyEl={bodyEl} />
    ))
    const base = buildHandle(extensionId, id, el, result)
    const handle: SpindleCollapsibleSectionHandle = {
      componentId: base.componentId,
      element: base.element,
      update: base.update,
      destroy: base.destroy,
      body: bodyEl,
      isExpanded: () => result.bridge.isExpanded?.() ?? false,
      expand: () => result.bridge.open?.(),
      collapse: () => result.bridge.close?.(),
      toggle: () => {
        const expanded = result.bridge.isExpanded?.() ?? false
        if (expanded) result.bridge.close?.()
        else result.bridge.open?.()
      },
    }
    return handle
  }
  function mountPagination(target: SpindleComponentTarget, options: SpindlePaginationOptions): SpindlePaginationHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'pagination')
    const result = mountBridge<SpindlePaginationOptions, number>(el, (b) => (
      <PaginationBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindlePaginationHandle
  }
  function mountCloseButton(target: SpindleComponentTarget, options?: SpindleCloseButtonOptions): SpindleCloseButtonHandle {
    const el = resolveTarget(target)
    const id = nextId(extensionId, 'close-button')
    const result = mountBridge<SpindleCloseButtonOptions, void>(el, (b) => (
      <CloseButtonBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result) as SpindleCloseButtonHandle
  }

  return {
    mountTextInput: mountText,
    mountTextArea,
    mountNumericInput,
    mountNumberStepper,
    mountRangeSlider,
    mountCheckbox,
    mountSwitch,
    mountSelect,
    mountMultiSelect,
    mountModelCombobox,
    mountFolderDropdown,
    mountBadge,
    mountSpinner,
    mountCollapsibleSection,
    mountPagination,
    mountCloseButton,
  }
}
