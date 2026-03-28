export enum EventType {
  CONNECTED = 'CONNECTED',
  SETTINGS_UPDATED = 'SETTINGS_UPDATED',
  CHARACTER_EDITED = 'CHARACTER_EDITED',
  CHARACTER_DELETED = 'CHARACTER_DELETED',
  PERSONA_CHANGED = 'PERSONA_CHANGED',
  MESSAGE_SENT = 'MESSAGE_SENT',
  MESSAGE_EDITED = 'MESSAGE_EDITED',
  MESSAGE_DELETED = 'MESSAGE_DELETED',
  MESSAGE_SWIPED = 'MESSAGE_SWIPED',
  GENERATION_STARTED = 'GENERATION_STARTED',
  STREAM_TOKEN_RECEIVED = 'STREAM_TOKEN_RECEIVED',
  GENERATION_ENDED = 'GENERATION_ENDED',
  GENERATION_STOPPED = 'GENERATION_STOPPED',
  GENERATION_ERROR = 'GENERATION_ERROR',
  CHAT_CREATED = 'CHAT_CREATED',
  CHAT_DELETED = 'CHAT_DELETED',
  CHAT_UPDATED = 'CHAT_UPDATED',

  // Council
  COUNCIL_STARTED = 'COUNCIL_STARTED',
  COUNCIL_MEMBER_DONE = 'COUNCIL_MEMBER_DONE',
  COUNCIL_COMPLETED = 'COUNCIL_COMPLETED',

  // Lumi Pipeline
  LUMI_PIPELINE_STARTED = 'LUMI_PIPELINE_STARTED',
  LUMI_MODULE_DONE = 'LUMI_MODULE_DONE',
  LUMI_PIPELINE_COMPLETED = 'LUMI_PIPELINE_COMPLETED',

  // Group Chat
  GROUP_TURN_STARTED = 'GROUP_TURN_STARTED',
  GROUP_ROUND_COMPLETE = 'GROUP_ROUND_COMPLETE',

  // World Info
  WORLD_INFO_ACTIVATED = 'WORLD_INFO_ACTIVATED',

  // Spindle extension events
  SPINDLE_EXTENSION_LOADED = 'SPINDLE_EXTENSION_LOADED',
  SPINDLE_EXTENSION_UNLOADED = 'SPINDLE_EXTENSION_UNLOADED',
  SPINDLE_EXTENSION_ERROR = 'SPINDLE_EXTENSION_ERROR',
  SPINDLE_EXTENSION_STATUS = 'SPINDLE_EXTENSION_STATUS',
  SPINDLE_FRONTEND_MSG = 'SPINDLE_FRONTEND_MSG',
  SPINDLE_TOAST = 'SPINDLE_TOAST',
  MESSAGE_TAG_INTERCEPTED = 'MESSAGE_TAG_INTERCEPTED',

  // Spindle theme overrides
  SPINDLE_THEME_OVERRIDES = 'SPINDLE_THEME_OVERRIDES',

  // Spindle text editor
  SPINDLE_TEXT_EDITOR_OPEN = 'SPINDLE_TEXT_EDITOR_OPEN',
  SPINDLE_TEXT_EDITOR_RESULT = 'SPINDLE_TEXT_EDITOR_RESULT',

  // Spindle modal
  SPINDLE_MODAL_OPEN = 'SPINDLE_MODAL_OPEN',
  SPINDLE_MODAL_RESULT = 'SPINDLE_MODAL_RESULT',
  SPINDLE_CONFIRM_OPEN = 'SPINDLE_CONFIRM_OPEN',
  SPINDLE_CONFIRM_RESULT = 'SPINDLE_CONFIRM_RESULT',

  // Tool invocation (Spindle extension tools)
  TOOL_INVOCATION = 'TOOL_INVOCATION',

  // Regex Scripts
  REGEX_SCRIPT_CHANGED = 'REGEX_SCRIPT_CHANGED',
  REGEX_SCRIPT_DELETED = 'REGEX_SCRIPT_DELETED',

  // Expressions
  EXPRESSION_CHANGED = 'EXPRESSION_CHANGED',

  // Avatar
  CHARACTER_AVATAR_CHANGED = 'CHARACTER_AVATAR_CHANGED',

  // Import progress
  IMPORT_GALLERY_PROGRESS = 'IMPORT_GALLERY_PROGRESS',

  // LumiHub remote install
  LUMIHUB_INSTALL_STARTED = 'LUMIHUB_INSTALL_STARTED',
  LUMIHUB_INSTALL_COMPLETED = 'LUMIHUB_INSTALL_COMPLETED',
  LUMIHUB_INSTALL_FAILED = 'LUMIHUB_INSTALL_FAILED',
  LUMIHUB_CONNECTION_CHANGED = 'LUMIHUB_CONNECTION_CHANGED',

  // SillyTavern Migration
  MIGRATION_PROGRESS = 'MIGRATION_PROGRESS',
  MIGRATION_LOG = 'MIGRATION_LOG',
  MIGRATION_COMPLETED = 'MIGRATION_COMPLETED',
  MIGRATION_FAILED = 'MIGRATION_FAILED',

  // Operator panel
  OPERATOR_LOG = 'OPERATOR_LOG',
  OPERATOR_STATUS = 'OPERATOR_STATUS',
  OPERATOR_PROGRESS = 'OPERATOR_PROGRESS',
}

// ---- Operator ----
export interface OperatorLogEntry {
  timestamp: number
  source: 'stdout' | 'stderr'
  text: string
}

export interface OperatorLogPayload {
  entries: OperatorLogEntry[]
}

export interface OperatorStatusPayload {
  port: number
  pid: number
  uptime: number
  branch: string
  version: string
  commit: string
  remoteMode: boolean
  ipcAvailable: boolean
  updateAvailable: boolean
  commitsBehind: number
  latestUpdateMessage: string
}

export interface OperatorProgressPayload {
  operation: string
  status: 'in_progress' | 'complete' | 'error'
  message: string
}

export interface WSEvent<T = any> {
  type: EventType
  payload: T
}

export interface StreamTokenPayload {
  generationId: string
  token: string
  type?: 'text' | 'reasoning'
}

export interface GenerationStartedPayload {
  generationId: string
  chatId: string
  targetMessageId?: string
  characterId?: string
  characterName?: string
}

export interface GenerationEndedPayload {
  generationId: string
  chatId: string
  messageId: string
  error?: string
}

export interface MessageSentPayload {
  chatId: string
  message: import('./api').Message
}

export interface MessageEditedPayload {
  chatId: string
  message: import('./api').Message
}

export interface MessageDeletedPayload {
  chatId: string
  messageId: string
}

export interface MessageSwipedPayload {
  chatId: string
  message: import('./api').Message
}

export interface GroupTurnStartedPayload {
  chatId: string
  characterId: string
  characterName: string
  generationId: string
  turnIndex: number
  totalExpected: number
}

export interface GroupRoundCompletePayload {
  chatId: string
  round: number
  charactersSpoken: string[]
}

export interface LumiPipelineStartedPayload {
  chatId: string
  moduleCount: number
}

export interface LumiModuleDonePayload {
  chatId: string
  moduleKey: string
  moduleName: string
  success: boolean
  content?: string
  error?: string
  durationMs: number
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface LumiPipelineCompletedPayload {
  chatId: string
  status: 'success' | 'skipped' | 'error' | 'aborted'
  reason?: string
  totalDurationMs?: number
  totalUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface SpindleThemeOverridesPayload {
  extensionId: string
  extensionName: string
  overrides: { variables?: Record<string, string> } | null
}

export interface SpindleToastPayload {
  extensionId: string
  extensionName: string
  type: 'success' | 'warning' | 'error' | 'info'
  message: string
  title?: string
  duration?: number
}

// ---- Migration ----
export interface MigrationProgressPayload {
  migrationId: string
  phase: 'characters' | 'worldBooks' | 'personas' | 'chats' | 'groupChats'
  label: string
  current: number
  total: number
}

export interface MigrationLogPayload {
  migrationId: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface MigrationCompletedPayload {
  migrationId: string
  durationMs: number
  results: Record<string, any>
}

export interface MigrationFailedPayload {
  migrationId: string
  error: string
}
