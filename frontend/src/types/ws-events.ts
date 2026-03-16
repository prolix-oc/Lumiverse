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
  SPINDLE_FRONTEND_MSG = 'SPINDLE_FRONTEND_MSG',
  MESSAGE_TAG_INTERCEPTED = 'MESSAGE_TAG_INTERCEPTED',

  // Tool invocation (Spindle extension tools)
  TOOL_INVOCATION = 'TOOL_INVOCATION',
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
