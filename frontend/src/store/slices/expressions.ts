import type { StateCreator } from 'zustand'
import type { ExpressionSlice } from '@/types/store'
import type { ExpressionDisplaySettings } from '@/types/expressions'
import { DEFAULT_EXPRESSION_DISPLAY } from '@/types/expressions'
import { settingsApi } from '@/api/settings'

export const createExpressionSlice: StateCreator<ExpressionSlice> = (set) => ({
  currentExpression: null,
  currentExpressionImageId: null,
  previousExpressionImageId: null,
  expressionCharacterId: null,
  expressionDisplay: { ...DEFAULT_EXPRESSION_DISPLAY },

  setActiveExpression: (label, imageId, characterId) =>
    set((state) => ({
      previousExpressionImageId: state.currentExpressionImageId,
      currentExpression: label,
      currentExpressionImageId: imageId,
      expressionCharacterId: characterId,
    })),

  setExpressionDisplay: (partial) =>
    set((state) => {
      const expressionDisplay: ExpressionDisplaySettings = { ...state.expressionDisplay, ...partial }
      settingsApi.put('expressionDisplay', expressionDisplay).catch(() => {})
      return { expressionDisplay }
    }),

  toggleExpressionMinimized: () =>
    set((state) => {
      const expressionDisplay: ExpressionDisplaySettings = {
        ...state.expressionDisplay,
        minimized: !state.expressionDisplay.minimized,
      }
      settingsApi.put('expressionDisplay', expressionDisplay).catch(() => {})
      return { expressionDisplay }
    }),
})
