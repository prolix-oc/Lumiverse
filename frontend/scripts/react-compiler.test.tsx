import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { act, createElement, type ComponentType } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { build } from 'vite'
import { createReactCompilerPlugins } from './react-compiler'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const temporaryRoot = resolve(import.meta.dirname, '../.tmp')
mkdirSync(temporaryRoot, { recursive: true })
const fixture = mkdtempSync(join(temporaryRoot, 'react-compiler-test-'))
const entry = join(fixture, 'entry.tsx')
writeFileSync(entry, `
import { useEffect, useEffectEvent, useState } from 'react'
import { ActivityPanel } from '../../src/components/shared/ActivityPanel'
export const events = []
function Panel({ label }) {
  'use memo'
  const [count, setCount] = useState(0)
  const receive = useEffectEvent(() => events.push('event:' + label))
  useEffect(() => {
    events.push('start')
    window.addEventListener('compiler-probe', receive)
    return () => {
      events.push('stop')
      window.removeEventListener('compiler-probe', receive)
    }
  }, [])
  return <section><button onClick={() => setCount(count + 1)}>{count}</button><textarea defaultValue="draft" /></section>
}
export function Probe({ active, label }) {
  return <ActivityPanel active={active}><Panel label={label} /></ActivityPanel>
}
`)
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})
afterAll(() => {
  dom.window.close()
  rmSync(fixture, { recursive: true, force: true })
})

for (const mode of ['babel', 'native']) {
  test(`${mode} production output preserves Effect Events and Activity lifecycle`, async () => {
    const result = await build({
      configFile: false,
      plugins: createReactCompilerPlugins(mode),
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ['es'] },
        rolldownOptions: {
          external: (id) => id === 'react' || id.startsWith('react/'),
          output: { codeSplitting: false },
        },
      },
    })
    const builds = Array.isArray(result) ? result : [result]
    const chunk = builds.flatMap((item) => 'output' in item ? item.output : [])
      .find((item) => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Missing compiled fixture')
    // This proves that annotation mode actually compiled the fixture, rather
    // than passing a runtime test after silently skipping the compiler.
    expect(chunk.code).toContain('react/compiler-runtime')
    const output = join(fixture, `${mode}.mjs`)
    writeFileSync(output, chunk.code)
    const { Probe, events } = await import(pathToFileURL(output).href) as {
      Probe: ComponentType<{ active: boolean; label: string }>
      events: string[]
    }
    host = document.createElement('div')
    document.body.append(host)
    root = (await import('react-dom/client')).createRoot(host)
    const show = (active: boolean, label: string) => act(async () => root!.render(createElement(Probe, { active, label })))
    const signal = () => window.dispatchEvent(new dom.window.Event('compiler-probe'))

    await show(true, 'first')
    act(() => host!.querySelector('button')!.click())
    const draft = host.querySelector('textarea')!
    draft.value = 'retained draft'
    await show(true, 'latest')
    signal()
    expect(events).toEqual(['start', 'event:latest'])
    await show(false, 'hidden')
    signal()
    expect(events).toEqual(['start', 'event:latest', 'stop'])
    await show(true, 'restored')
    expect(host.querySelector('button')!.textContent).toBe('1')
    expect(host.querySelector('textarea') === draft).toBe(true)
    expect(draft.value).toBe('retained draft')
    signal()
    expect(events).toEqual(['start', 'event:latest', 'stop', 'start', 'event:restored'])
    await act(async () => root!.unmount())
    root = undefined
    signal()
    expect(events.at(-1)).toBe('stop')
  }, 30_000)

  test(`${mode} library cards reuse image subtrees and keep updated actions and extension overrides`, async () => {
    const cardEntry = join(fixture, `cards-${mode}.tsx`)
    writeFileSync(cardEntry, `
      export { default as CharacterCard } from '../../src/components/panels/character-browser/CharacterCard'
      export { default as PackCard } from '../../src/components/panels/pack-browser/PackCard'
      export { registerComponentOverride } from '../../src/lib/spindle/component-override-registry'
      export { imageRenders } from '../../src/components/shared/LazyImage'
    `)
    const result = await build({
      configFile: false,
      resolve: { alias: { '@': resolve(import.meta.dirname, '../src') } },
      plugins: [
        ...createReactCompilerPlugins(mode),
        {
          name: 'card-render-observer',
          enforce: 'pre',
          resolveId(id) { if (id === 'react-i18next') return '\0card-translations' },
          load(id) {
            if (id === '\0card-translations') return `
              const t = key => key;
              export const useTranslation = () => ({ t });
            `
            if (id.endsWith('/src/components/shared/LazyImage.tsx')) return `
              import { createElement } from 'react';
              export const imageRenders = [];
              export default function LazyImage({ src, alt }) {
                imageRenders.push(src);
                return createElement('img', { src, alt });
              }
            `
            if (id.endsWith('/src/lib/avatarUrls.ts')) return `
              export const getCharacterAvatarThumbUrl = c => '/thumb/' + c.id;
              export const getCharacterAvatarLargeUrl = c => '/large/' + c.id;
            `
          },
        },
      ],
      logLevel: 'silent',
      build: {
        write: false, minify: false,
        lib: { entry: cardEntry, formats: ['es'] },
        rolldownOptions: {
          external: id => id === 'react' || id.startsWith('react/'),
          output: { codeSplitting: false },
        },
      },
    })
    const builds = Array.isArray(result) ? result : [result]
    const chunk = builds.flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Missing compiled cards')
    expect(chunk.code).toContain('react/compiler-runtime')
    const output = join(fixture, `cards-${mode}.mjs`)
    writeFileSync(output, chunk.code)
    const { CharacterCard, PackCard, imageRenders, registerComponentOverride } = await import(pathToFileURL(output).href)
    host = document.createElement('div')
    document.body.append(host)
    root = (await import('react-dom/client')).createRoot(host)
    const character = { id: 'character', name: 'Character', tags: ['first', 'second'] }
    const actions: string[] = []
    const props = { character, onOpen: () => actions.push('open'), onToggleFavorite: () => actions.push('favorite') }
    await act(async () => root!.render(createElement(CharacterCard, { ...props, isFavorite: false })))
    await act(async () => root!.render(createElement(CharacterCard, { ...props, isFavorite: true })))
    expect(imageRenders).toEqual(['/thumb/character'])
    expect(host.querySelector('button[title="characterBrowser.removeFromFavorites"]')).not.toBeNull()
    act(() => host!.querySelector<HTMLButtonElement>('button')!.click())
    expect(actions).toEqual(['favorite'])
    let override: { destroy(): void }
    await act(async () => {
      override = registerComponentOverride({ host: 'CharacterCard', owner: 'compiler-test', generation: 1,
        mode: 'replace', component: () => createElement('span', null, 'Extension card') })
    })
    expect(host.textContent).toBe('Extension card')
    await act(async () => override!.destroy())
    expect(host.querySelector('img')?.alt).toBe('Character')

    const pack = { id: 'pack', name: 'Pack', cover_url: '/pack.png', version: '1.0', is_custom: true }
    imageRenders.length = 0
    await act(async () => root!.render(createElement(PackCard, { pack, onClick: () => actions.push('old') })))
    await act(async () => root!.render(createElement(PackCard, { pack, onClick: () => actions.push('latest') })))
    expect(imageRenders).toEqual(['/pack.png'])
    act(() => host!.firstElementChild!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    expect(actions.at(-1)).toBe('latest')
    await act(async () => root!.render(createElement(PackCard, { pack: { ...pack, name: 'Renamed pack' }, onClick: () => {} })))
    expect(host.querySelector('img')?.alt).toBe('Renamed pack')
    expect(host.textContent).toContain('Renamed pack')
  }, 30_000)
}
