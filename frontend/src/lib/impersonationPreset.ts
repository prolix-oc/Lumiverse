import type { ImpersonateMode } from '@/api/generate'

export type ImpersonationPreference = Extract<ImpersonateMode, 'prompts' | 'preset' | 'oneliner'>

export const DEFAULT_IMPERSONATION_MODE: ImpersonationPreference = 'oneliner'

export interface ImpersonationPresetSelection {
  presetId: string | undefined
  forcePresetId: boolean
}

export function isImpersonationPreference(value: unknown): value is ImpersonationPreference {
  return value === 'prompts' || value === 'preset' || value === 'oneliner'
}

/** Safely read a persisted mode, falling back to the supplied account default. */
export function resolveImpersonationMode(
  value: unknown,
  fallback: ImpersonationPreference = DEFAULT_IMPERSONATION_MODE,
): ImpersonationPreference {
  return isImpersonationPreference(value) ? value : fallback
}

/** Preserve an unset per-chat value so it can continue inheriting the account default. */
export function resolveImpersonationModeOverride(value: unknown): ImpersonationPreference | null {
  return isImpersonationPreference(value) ? value : null
}

/**
 * The dedicated chat impersonation preset is shared by the full-preset and
 * one-liner actions. Preset Prompts intentionally keeps using the chat's
 * active preset so adding the new action cannot change existing behavior.
 */
export function resolveImpersonationPresetSelection(
  mode: ImpersonateMode,
  impersonationPresetId: string | null | undefined,
  activePresetId: string | null | undefined,
): ImpersonationPresetSelection {
  const dedicatedPresetId =
    mode === 'preset' || mode === 'oneliner'
      ? impersonationPresetId || undefined
      : undefined

  return {
    presetId: dedicatedPresetId || activePresetId || undefined,
    forcePresetId: !!dedicatedPresetId,
  }
}
