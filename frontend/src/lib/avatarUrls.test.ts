import { describe, expect, test } from 'bun:test'
import {
  getPersonaAvatarLargeUrl,
  getPersonaAvatarThumbUrlById,
  getPersonaAvatarThumbUrl,
  getPersonaAvatarUrl,
  pickPersonaOriginalImageId,
  pickPersonaThumbImageId,
} from './avatarUrls'

describe('persona avatar URL helpers', () => {
  test('prefer the stored square crop for avatar-sized persona surfaces', () => {
    const persona = {
      id: 'persona-new',
      image_id: 'persona-original',
      metadata: { avatar_crop_image_id: 'persona-crop' },
    }

    expect(pickPersonaThumbImageId(persona)).toBe('persona-crop')
    expect(getPersonaAvatarThumbUrl(persona)).toBe('/api/v1/images/persona-crop?size=sm')
    expect(getPersonaAvatarLargeUrl(persona)).toBe('/api/v1/images/persona-crop?size=lg')
    expect(getPersonaAvatarUrl(persona)).toBe('/api/v1/images/persona-original')
  })

  test('use legacy original_image_id for full-size persona views', () => {
    const persona = {
      id: 'persona-legacy',
      image_id: 'legacy-crop',
      metadata: { original_image_id: 'legacy-original' },
    }

    expect(pickPersonaThumbImageId(persona)).toBe('legacy-crop')
    expect(pickPersonaOriginalImageId(persona)).toBe('legacy-original')
    expect(getPersonaAvatarUrl(persona)).toBe('/api/v1/images/legacy-original')
  })

  test('fall back to image_id when no persona avatar metadata exists', () => {
    const persona = {
      id: 'persona-basic',
      image_id: 'persona-image',
      metadata: {},
    }

    expect(pickPersonaThumbImageId(persona)).toBe('persona-image')
    expect(pickPersonaOriginalImageId(persona)).toBe('persona-image')
    expect(getPersonaAvatarThumbUrl(persona)).toBe('/api/v1/images/persona-image?size=sm')
    expect(getPersonaAvatarUrl(persona)).toBe('/api/v1/images/persona-image')
  })

  test('uses the chat-scoped resolver and toggle version for active persona art', () => {
    expect(
      getPersonaAvatarThumbUrlById('persona-mode', 'base-image', {
        chatId: 'chat-1',
        version: 'toggle-2',
      }),
    ).toBe('/api/v1/personas/persona-mode/avatar?chat_id=chat-1&size=sm&v=toggle-2')
  })
})
