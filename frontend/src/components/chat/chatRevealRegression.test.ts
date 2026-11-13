import { describe, expect, test } from 'bun:test'

const readSource = (file: string) => Bun.file(`${import.meta.dir}/${file}`).text()

describe('staging chat reveal regression contracts', () => {
  test('scopes the empty-chat two-frame reveal to the active load', async () => {
    const source = await readSource('ChatView.tsx')
    const emptyChat = source.match(
      /if \(msgPage\.data\.length === 0\) \{[\s\S]*?\n        \}/,
    )?.[0] ?? ''

    expect(emptyChat).toContain('requestAnimationFrame(() => {')
    expect((emptyChat.match(/requestAnimationFrame\(\(\) => \{/g) ?? []).length).toBe(2)
    expect(emptyChat).toMatch(/if\s*\(cancelled\)\s*return/)
    expect(emptyChat).toMatch(/detail:\s*\{\s*chatId\s*\}/)
  })

  test('waits for the warm range and a stable settle before revealing populated rows', async () => {
    const source = await readSource('MessageList.tsx')
    const revealEffect = source.match(
      /const hasPopulated = virtualItems\.some\([\s\S]*?\n  \}, \[canSettleInitialDisplay, chatId, interceptorRegistryVersion\]\)/,
    )?.[0] ?? ''

    expect(revealEffect).toContain('const canSettleInitialDisplay = hasPopulated && initialRangeWarm')
    expect(revealEffect).toMatch(/if \(hasFadedInRef\.current \|\| !canSettleInitialDisplay\) return/)
    expect(revealEffect).toMatch(/let cancelled = false/)
    expect(revealEffect).toContain('CHAT_REVEAL_SETTLE_QUIET_MS')
    expect(revealEffect).toMatch(/if \(!force && !isChatDisplaySettled\(chatId\)\)/)
    expect(revealEffect).toContain('hasFadedInRef.current = true')
    expect(revealEffect).toMatch(/return \(\) => \{\s*cancelled = true/)
    expect(revealEffect).toMatch(/cancelAnimationFrame\(firstFrame\)/)
    expect(revealEffect).toMatch(/cancelAnimationFrame\(secondFrame\)/)
    expect(revealEffect).toMatch(/\}, \[canSettleInitialDisplay, chatId, interceptorRegistryVersion\]\)$/)
  })

  test('keeps the scroll-to-bottom control out of the settling display', async () => {
    const [chatView, scrollToBottom] = await Promise.all([
      readSource('ChatView.tsx'),
      readSource('ScrollToBottom.tsx'),
    ])

    expect(chatView).toContain('<ScrollToBottom key={chatId} displayReady={!chatChromeEntering} />')
    expect(scrollToBottom).toContain('if (!displayReady || !visible) return null')
    expect(scrollToBottom).toContain('}, [displayReady])')
  })

  test('freezes an active stream before animating it out on home navigation', async () => {
    const source = await readSource('ChatView.tsx')
    const completeNavigation = source.match(
      /const completeNavigateHome = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[chatId, navigate\]\)/,
    )?.[0] ?? ''
    const homeHandler = source.match(
      /const handleNavigateHome = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[chatId, completeNavigateHome\]\)/,
    )?.[0] ?? ''

    expect(completeNavigation).toMatch(/state\.activeChatId === chatId/)
    expect(completeNavigation).toContain('state.setActiveChat(null)')
    expect(completeNavigation.indexOf('state.setActiveChat(null)')).toBeLessThan(
      completeNavigation.indexOf("navigate('/')"),
    )
    expect(homeHandler).toContain('state.activeChatId === chatId && state.isStreaming')
    expect(homeHandler).toContain('if (isActivelyStreamingThisChat) state.pauseStreamingForNavigation()')
    expect(homeHandler.indexOf('state.pauseStreamingForNavigation()')).toBeLessThan(
      homeHandler.indexOf('setChatChromeLeaving(true)'),
    )
    expect(homeHandler).toContain('setChatChromeLeaving(true)')
    expect(homeHandler).not.toContain('window.setTimeout')
    expect(source).toContain("playChatChromeMotion(chatColumnInnerRef.current, 'leave', completeNavigateHome)")
  })
})
