import { create } from 'zustand'
import type { AppStore } from '@/types/store'
import { createChatSlice } from './slices/chat'
import { createCharactersSlice } from './slices/characters'
import { createPersonasSlice } from './slices/personas'
import { createUISlice } from './slices/ui'
import { createSettingsSlice } from './slices/settings'
import { createPresetsSlice } from './slices/presets'
import { createLumiSlice } from './slices/lumi'
import { createConnectionsSlice } from './slices/connections'
import { createPacksSlice } from './slices/packs'
import { createCouncilSlice } from './slices/council'
import { createGenerationSlice } from './slices/generation'
import { createSummarySlice } from './slices/summary'
import { createSpindleSlice } from './slices/spindle'
import { createAuthSlice } from './slices/auth'
import { createWorldInfoSlice } from './slices/world-info'
import { createGroupChatSlice } from './slices/group-chat'
import { createSpindlePlacementSlice } from './slices/spindle-placement'
import { createPromptBreakdownSlice } from './slices/prompt-breakdown'
import { createRegexSlice } from './slices/regex'
import { createExpressionSlice } from './slices/expressions'
import { createImageGenConnectionsSlice } from './slices/image-gen-connections'
import { createLoadoutsSlice } from './slices/loadouts'
import { createMigrationSlice } from './slices/migration'
import { createOperatorSlice } from './slices/operator'

export const useStore = create<AppStore>()((...a) => ({
  ...createChatSlice(...a),
  ...createCharactersSlice(...a),
  ...createPersonasSlice(...a),
  ...createUISlice(...a),
  ...createSettingsSlice(...a),
  ...createPresetsSlice(...a),
  ...createLumiSlice(...a),
  ...createConnectionsSlice(...a),
  ...createPacksSlice(...a),
  ...createCouncilSlice(...a),
  ...createGenerationSlice(...a),
  ...createSummarySlice(...a),
  ...createSpindleSlice(...a),
  ...createAuthSlice(...a),
  ...createWorldInfoSlice(...a),
  ...createGroupChatSlice(...a),
  ...createSpindlePlacementSlice(...a),
  ...createPromptBreakdownSlice(...a),
  ...createRegexSlice(...a),
  ...createExpressionSlice(...a),
  ...createImageGenConnectionsSlice(...a),
  ...createLoadoutsSlice(...a),
  ...createMigrationSlice(...a),
  ...createOperatorSlice(...a),
}))
