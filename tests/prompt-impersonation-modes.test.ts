import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'path'

import { closeDatabase, getDb, initDatabase } from '../src/db/connection'
import * as charactersSvc from '../src/services/characters.service'
import * as chatsSvc from '../src/services/chats.service'
import * as presetsSvc from '../src/services/presets.service'
import { assemblePrompt } from '../src/services/prompt-assembly.service'
import type { ImpersonateMode } from '../src/llm/types'
import type { PromptBlock } from '../src/types/preset'

const USER_ID = 'prompt-impersonation-modes-user'

function makeBlock(overrides: Partial<PromptBlock>): PromptBlock {
  return {
    id: crypto.randomUUID(),
    name: 'block',
    content: '',
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...overrides,
  }
}

describe('prompt impersonation modes', () => {
  let chatId: string
  let presetId: string

  beforeEach(async () => {
    closeDatabase()
    initDatabase(':memory:')
    const db = getDb()
    db.run('PRAGMA foreign_keys = OFF')
    db.run(await Bun.file(join(import.meta.dir, '..', 'src', 'db', 'baseline.sql')).text())

    const character = charactersSvc.createCharacter(USER_ID, { name: 'Nyra' })
    const chat = chatsSvc.createChat(USER_ID, { character_id: character.id })
    chatId = chat.id
    chatsSvc.createMessage(chat.id, {
      is_user: true,
      name: 'User',
      content: 'HISTORY_USER_LINE',
    }, USER_ID)
    chatsSvc.createMessage(chat.id, {
      is_user: false,
      name: 'Nyra',
      content: 'HISTORY_ASSISTANT_LINE',
    }, USER_ID)

    const preset = presetsSvc.createPreset(USER_ID, {
      name: 'Dedicated Impersonation Preset',
      provider: 'openai',
      engine: 'chat',
      parameters: {},
      prompts: {
        promptBehavior: { impersonationPrompt: 'IMPERSONATION_NUDGE' },
        completionSettings: {
          assistantImpersonation: 'IMPERSONATION_PREFILL',
          continuePrefill: true,
        },
      },
      metadata: {},
      prompt_order: [
        makeBlock({ name: 'Full preset block', content: 'FULL_PRESET_BLOCK' }),
        makeBlock({
          name: 'Impersonate-only block',
          content: 'IMPERSONATE_ONLY_BLOCK',
          injectionTrigger: ['impersonate'],
        }),
        makeBlock({ name: 'Chat History', marker: 'chat_history' }),
      ],
    })
    presetId = preset.id
  })

  afterEach(() => closeDatabase())

  async function assemble(mode: ImpersonateMode) {
    return assemblePrompt({
      userId: USER_ID,
      chatId,
      generationType: 'impersonate',
      impersonateMode: mode,
      presetId,
    })
  }

  test('dedicated preset mode combines full assembly, history, and impersonation prompts', async () => {
    const result = await assemble('preset')
    const serialized = JSON.stringify(result.messages)
    const request = result.messages.find((message) => message.content === 'IMPERSONATION_NUDGE')

    expect(serialized).toContain('FULL_PRESET_BLOCK')
    expect(serialized).toContain('IMPERSONATE_ONLY_BLOCK')
    expect(serialized).toContain('HISTORY_USER_LINE')
    expect(serialized).toContain('HISTORY_ASSISTANT_LINE')
    expect(serialized).toContain('IMPERSONATION_NUDGE')
    expect(serialized).toContain('IMPERSONATION_PREFILL')
    expect(request?.role).toBe('system')
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'IMPERSONATION_PREFILL',
      partial: true,
    })
  })

  test('remains equivalent to full Preset Prompts assembly', async () => {
    const [presetResult, promptsResult] = await Promise.all([
      assemble('preset'),
      assemble('prompts'),
    ])

    expect(presetResult.messages).toEqual(promptsResult.messages)
    expect(presetResult.breakdown).toEqual(promptsResult.breakdown)
    expect(presetResult.parameters).toEqual(promptsResult.parameters)
  })

  test('does not change the one-liner block-skipping behavior', async () => {
    const result = await assemble('oneliner')
    const serialized = JSON.stringify(result.messages)

    expect(serialized).not.toContain('FULL_PRESET_BLOCK')
    expect(serialized).not.toContain('IMPERSONATE_ONLY_BLOCK')
    expect(serialized).toContain('HISTORY_USER_LINE')
    expect(serialized).toContain('HISTORY_ASSISTANT_LINE')
    expect(serialized).toContain('IMPERSONATION_NUDGE')
    expect(serialized).toContain('IMPERSONATION_PREFILL')
  })

  test.each(['preset', 'oneliner'] as const)(
    '%s suppresses prefills unless the preset checkbox is enabled',
    async (mode) => {
      const preset = presetsSvc.getPreset(USER_ID, presetId)!
      presetsSvc.updatePreset(USER_ID, presetId, {
        prompts: {
          ...preset.prompts,
          completionSettings: {
            ...preset.prompts.completionSettings,
            continuePrefill: false,
          },
        },
      })

      const result = await assemble(mode)
      const request = result.messages.find((message) => message.content === 'IMPERSONATION_NUDGE')
      expect(JSON.stringify(result.messages)).not.toContain('IMPERSONATION_PREFILL')
      expect(result.assistantPrefill).toBeUndefined()
      expect(result.assistantReasoningPrefill).toBeUndefined()
      expect(request?.role).toBe('user')
      expect(result.messages.at(-1)?.role).toBe('user')
    },
  )
})
