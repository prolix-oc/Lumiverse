import { FRONTEND_AUTHORITY_MAP } from './frontend-authority-map'

/** Exact function/accessor leaves intentionally outside the authority map. */
export const NO_AUTHORITY_CTX_MEMBERS = [
  'ctx.ready', 'ctx.deferReady', 'ctx.host.surfaces.list', 'ctx.host.surfaces.subscribe',
  'ctx.host.surfaces.invoke', 'ctx.host.surfaces.registerDeepLinkTarget',
  'ctx.locale.get', 'ctx.locale.subscribe',
  'ctx.dom.inject', 'ctx.dom.uninject', 'ctx.dom.addStyle', 'ctx.dom.createElement',
  'ctx.dom.createSandboxFrame', 'ctx.dom.query', 'ctx.dom.queryAll', 'ctx.dom.getMessageId',
  'ctx.dom.findMessageElement', 'ctx.dom.listMessageElements', 'ctx.dom.cleanup',
  'ctx.events.on', 'ctx.events.emit',
  'ctx.state.get', 'ctx.state.subscribe', 'ctx.state.list', 'ctx.state.revokePermissions', 'ctx.state.dispose',
  'ctx.ui.events.getKeyboardState', 'ctx.ui.events.onKeyboardChange',
  'ctx.ui.events.bindActionHandlers',
  'ctx.ui.mount', 'ctx.ui.registerDrawerTab', 'ctx.ui.registerSettingsTab', 'ctx.ui.registerInputBarAction',
  'ctx.ui.registerCssComponent', 'ctx.ui.registerComponentOverride', 'ctx.ui.registerHostIntentHandler',
  'ctx.ui.getBuiltInTabTitle', 'ctx.ui.getTabLocation', 'ctx.ui.showContextMenu',
  'ctx.ui.showModal', 'ctx.ui.showConfirm',
  'ctx.components.mountTextInput', 'ctx.components.mountTextArea', 'ctx.components.mountNumericInput',
  'ctx.components.mountNumberStepper', 'ctx.components.mountRangeSlider', 'ctx.components.mountCheckbox',
  'ctx.components.mountSwitch', 'ctx.components.mountSelect', 'ctx.components.mountMultiSelect',
  'ctx.components.mountModelCombobox', 'ctx.components.mountFolderDropdown', 'ctx.components.mountBadge',
  'ctx.components.mountSpinner', 'ctx.components.mountCollapsibleSection', 'ctx.components.mountPagination',
  'ctx.components.mountCloseButton', 'ctx.components.mountLoomBlockEditor',
  'ctx.uploads.pickFile', 'ctx.permissions.getGranted', 'ctx.permissions.request',
  'ctx.sendToBackend', 'ctx.onBackendMessage', 'ctx.onTeardown',
  'ctx.processes.register', 'ctx.messages.registerTagInterceptor', 'ctx.messages.renderWidget',
  'ctx.messages.removeWidget', 'ctx.display.registerResolver', 'ctx.display.invalidate', 'ctx.display.setExpression',
  'ctx.containers.registerContainer', 'ctx.containers.unregisterContainer',
] as const

type LegacyCtxMember = { id: string; permission: string | null }

const legacyMembers = FRONTEND_AUTHORITY_MAP.filter(
  (row): row is typeof row & { permission: string | null } => row.surface === 'legacy_ctx_member',
)

const legacyById = new Map<string, LegacyCtxMember>()
for (const row of legacyMembers) {
  if (legacyById.has(row.id)) throw new Error(`Duplicate legacy ctx authority member: ${row.id}`)
  legacyById.set(row.id, { id: row.id, permission: row.permission })
}

export const LEGACY_CTX_MEMBERS: readonly LegacyCtxMember[] = Object.freeze([...legacyById.values()])

export function legacyCtxPermission(id: string): string {
  const member = legacyById.get(id)
  if (!member) throw new Error(`Unknown legacy ctx authority member: ${id}`)
  if (member.permission === null) throw new Error(`Legacy ctx authority member is not permission-gated: ${id}`)
  return member.permission
}
