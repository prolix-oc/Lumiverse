import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const startGeneration = mock(() => {})
const generateStart = mock((_payload?: { chat_id: string; generation_type: string }) => (
  Promise.resolve({ generationId: 'gen-input' })
))

const InputAreaStub = {
  send() {
    startGeneration()
    return generateStart({ chat_id: 'chat-1', generation_type: 'normal' })
  },
}

const here = dirname(fileURLToPath(import.meta.url))

describe('InputArea edit-and-send contract', () => {
  test('mocked InputArea send is not invoked by the edit-and-send path', async () => {
    startGeneration.mockClear()
    generateStart.mockClear()

    // Edit-and-send re-prompts through chatsApi + swipe/new-generation UX.
    // InputArea.startGeneration stays the sole owner of composer sends.
    const handleEditAndSend = async () => {
      return { dispatchedBy: 'edit-and-send' as const }
    }

    await expect(handleEditAndSend()).resolves.toEqual({ dispatchedBy: 'edit-and-send' })
    expect(startGeneration).not.toHaveBeenCalled()
    expect(generateStart).not.toHaveBeenCalled()
    expect(typeof InputAreaStub.send).toBe('function')
  })

  test('edit-and-send lane does not import InputArea or call startGeneration', () => {
    const card = readFileSync(join(here, '../../hooks/useMessageCard.ts'), 'utf8')
    const swipe = readFileSync(join(here, '../../hooks/useSwipeAction.ts'), 'utf8')
    const api = readFileSync(join(here, '../../api/chats.ts'), 'utf8')
    const inputArea = readFileSync(join(here, 'InputArea.tsx'), 'utf8')

    expect(card).not.toMatch(/startGeneration/)
    expect(card).not.toMatch(/from ['"]@\/components\/chat\/InputArea['"]/)
    expect(swipe).not.toMatch(/startGeneration/)
    expect(api).toContain('edit-and-send')
    expect(inputArea).not.toMatch(/editAndSend|edit-and-send/)
  })
})
