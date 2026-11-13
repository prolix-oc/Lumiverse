import { expect, test } from 'bun:test'
import { buildNanoGptSettingsMetadata, updateNanoGptModelRouting } from './nanogpt-routing'

test('routing changes remain scoped to the selected model and preserve other settings', () => {
  const settings = { billing_mode: 'paygo' as const, model_overrides: { 'first/model': { only: ['novita'], allow_fallbacks: false }, 'second/model': { sort: 'price' as const } } }
  const next = updateNanoGptModelRouting(settings, ' second/model ', { ignore: ['deepinfra'] })
  expect(next.model_overrides?.['first/model']).toEqual({ only: ['novita'], allow_fallbacks: false })
  expect(next.model_overrides?.['second/model']).toEqual({ sort: 'price', ignore: ['deepinfra'] })
  expect(next.billing_mode).toBe('paygo')
  expect(settings.model_overrides['second/model']).toEqual({ sort: 'price' })
})

test('clearing default controls removes the override so requests stay automatic', () => {
  const next = updateNanoGptModelRouting({ model_overrides: { model: { only: ['novita'], allow_fallbacks: false } } }, 'model', { only: [], allow_fallbacks: undefined })
  expect(next.model_overrides).toEqual({})
  expect(buildNanoGptSettingsMetadata(next)).toBeUndefined()
})

test('explicit auto and disabled fallback survive saving while an empty model does not create preferences', () => {
  const settings = updateNanoGptModelRouting({}, 'model', { sort: 'auto', allow_fallbacks: false })
  expect(buildNanoGptSettingsMetadata(settings)).toEqual({ model_overrides: { model: { sort: 'auto', allow_fallbacks: false } } })
  expect(updateNanoGptModelRouting(settings, ' ', { only: ['novita'] })).toBe(settings)
})
