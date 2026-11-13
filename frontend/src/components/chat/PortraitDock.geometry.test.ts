import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'

import { assertNever } from '@/lib/assertNever'
import {
  CHAT_CONTENT_WIDTH_PRESETS,
  resolveChatContentWidthForReclaim,
  resolveChatContentWidthPx,
  type ChatWidthMode,
} from '@/lib/chatContentWidth'
// The untouched default portrait rectangle, needed by Property 9's rect generator so the
// default-rect case is drawn from the same constant the component compares against rather than
// from a literal copy that could drift away from it.
import { DEFAULT_PORTRAIT_DOCK_SETTINGS } from '@/lib/uiProductivityDefaults'

// Type-only, so it is erased at compile time and does not defeat the dynamic `./PortraitDock`
// import the store mock above depends on.
import type { PortraitLayoutTargets } from './PortraitDock'
// Type-only as well: `Canonical_Rect`'s shape, taken from the store types so Property 9 compares
// the four fields the persisted rectangle actually has.
import type { SurfaceRectPrefs } from '@/types/store'

let fitPortraitSize: typeof import('./PortraitDock').fitPortraitSize
let getPortraitLayoutReclaim: typeof import('./PortraitDock').getPortraitLayoutReclaim
// Property 10's gate predicate: the component's own "is this the untouched default rect?" test,
// bound so the property can assert the component agrees with the independent field-by-field
// comparison rather than assuming it does.
let isDefaultPortraitRect: typeof import('./PortraitDock').isDefaultPortraitRect
let ownsPortraitPreviewForContext: typeof import('./PortraitDock').ownsPortraitPreviewForContext
let portraitDockOwnsFloatingAvatar: typeof import('./PortraitDock').portraitDockOwnsFloatingAvatar
let placeDockedPortraitRect: typeof import('./PortraitDock').placeDockedPortraitRect
let resolveDockReclaimStyle: typeof import('./PortraitDock').resolveDockReclaimStyle
let resolveDockSideForRect: typeof import('./PortraitDock').resolveDockSideForRect
let shouldAutoOpenPortraitForChat: typeof import('./PortraitDock').shouldAutoOpenPortraitForChat
let resolveDockedPortraitImageRect: typeof import('./PortraitDock').resolveDockedPortraitImageRect
let resolvePortraitLayoutTargets: typeof import('./PortraitDock').resolvePortraitLayoutTargets

mock.module('@/store', () => ({ useStore: () => ({}) }))
mock.module('@/components/shared/ContextMenu', () => ({ default: () => null }))

beforeAll(async () => {
  ;({ fitPortraitSize, getPortraitLayoutReclaim, isDefaultPortraitRect, ownsPortraitPreviewForContext, portraitDockOwnsFloatingAvatar, placeDockedPortraitRect, resolveDockReclaimStyle, resolveDockSideForRect, resolveDockedPortraitImageRect, resolvePortraitLayoutTargets, shouldAutoOpenPortraitForChat } = await import('./PortraitDock'))
})

// ---------------------------------------------------------------------------
// Property-test harness
//
// This repository has no property-based testing library and the governing spec
// prohibits dependency installs, so the generators below are hand-rolled. Every
// run draws from a seeded PRNG and `forAll` reports the seed plus the failing
// input, so any counterexample is reproducible by re-running with that seed.
//
// Declared once at module scope because the remaining property tasks in this
// spec (Properties 1-4, 6-11) reuse the same generators.
// ---------------------------------------------------------------------------

/** Minimum iterations every property in this spec must run. */
export const PROPERTY_ITERATIONS = 100

/** Default seed. Override per property via `forAll`'s options to reproduce a counterexample. */
export const PROPERTY_SEED = 0x5eed_c0de

export type Rng = () => number

/** mulberry32 — a small, fast, fully deterministic 32-bit PRNG. Returns [0, 1). */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform integer in `[min, max]`. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** Uniform choice from a non-empty tuple. */
export function pickOne<T>(rng: Rng, values: readonly T[]): T {
  return values[randomInt(rng, 0, values.length - 1)] as T
}

/**
 * Compile-time coverage guard for `Chat_Width_Mode`. `Record<ChatWidthMode, true>` cannot be
 * satisfied with a member missing, so adding a fifth width mode to settings fails typecheck
 * here instead of silently narrowing every property's input space.
 */
export const CHAT_WIDTH_MODE_COVERAGE = {
  full: true,
  comfortable: true,
  compact: true,
  custom: true,
} as const satisfies Record<ChatWidthMode, true>

export const CHAT_WIDTH_MODES = Object.keys(CHAT_WIDTH_MODE_COVERAGE) as ChatWidthMode[]

export function randomChatWidthMode(rng: Rng): ChatWidthMode {
  return pickOne(rng, CHAT_WIDTH_MODES)
}

/**
 * Custom widths a corrupt or partially hydrated settings row can actually hold. Every one of
 * these must degrade to "unconstrained" rather than producing a wrong margin.
 */
export const INVALID_CUSTOM_WIDTHS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0,
  -1,
  -1400,
] as const

/** Roughly one draw in three is invalid, so the degrade path is exercised heavily. */
export function randomCustomWidth(rng: Rng): number {
  const roll = rng()
  if (roll < 0.3) return pickOne(rng, INVALID_CUSTOM_WIDTHS)
  if (roll < 0.45) return randomInt(rng, 1, 4000) + Math.round(rng() * 100) / 100
  return randomInt(rng, 1, 4000)
}

/**
 * A VALID custom content width in layout px: always finite and always positive, so it never
 * degrades to unconstrained. Properties restricted to the CONSTRAINED width modes need this;
 * an invalid custom width behaves as `full` and belongs to Property 3's input space instead.
 *
 * `relativeTo` is the width the draw straddles (the body width, for gutter properties): about
 * half the draws land at or below it and half above it, so custom content both narrower and
 * wider than the body it sits in is reached. A quarter of the draws carry a fractional part,
 * matching a settings row written by a drag handle rather than a stepper.
 */
export function randomValidCustomWidth(rng: Rng, relativeTo = 1400): number {
  const pivot = Math.max(2, Math.floor(relativeTo))
  const width = rng() < 0.5 ? randomInt(rng, 1, pivot) : randomInt(rng, pivot + 1, pivot + 2000)
  const drawn = rng() < 0.25 ? width + Math.round(rng() * 100) / 100 : width
  return drawn
}

/** A laid-out `Chat_Body` width in layout px. Zero-box readiness is modelled separately. */
export function randomBodyWidth(rng: Rng): number {
  return randomInt(rng, 1, 4000)
}

/** Dock minimum width from `DEFAULT_PORTRAIT_DOCK_SETTINGS`, in layout px. */
export const PORTRAIT_DOCK_MIN_WIDTH = 180

/** A dock width in layout px, never wider than the lane it has to fit in. */
export function randomDockWidth(rng: Rng, maxWidth = 720): number {
  const upper = Math.max(PORTRAIT_DOCK_MIN_WIDTH, Math.floor(maxWidth))
  return randomInt(rng, Math.min(PORTRAIT_DOCK_MIN_WIDTH, upper), upper)
}

/** Serializes non-finite numbers so a `NaN` or `Infinity` counterexample survives reporting. */
function describeInput(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, raw) => (typeof raw === 'number' && !Number.isFinite(raw) ? String(raw) : raw),
  ) ?? String(value)
}

/**
 * Minimal property runner. Generates `iterations` inputs from a seeded PRNG and reports the
 * seed, the iteration index, and the failing input when `check` throws.
 */
export function forAll<T>(
  name: string,
  generate: (rng: Rng) => T,
  check: (value: T, index: number) => void,
  options: { iterations?: number, seed?: number } = {},
): void {
  const seed = options.seed ?? PROPERTY_SEED
  const iterations = options.iterations ?? PROPERTY_ITERATIONS
  const rng = makeRng(seed)
  for (let index = 0; index < iterations; index += 1) {
    const value = generate(rng)
    try {
      check(value, index)
    } catch (error) {
      throw new Error(
        `${name} failed at iteration ${index} of ${iterations} (seed 0x${seed.toString(16)}) `
        + `with input ${describeInput(value)}\n`
        + (error instanceof Error ? error.message : String(error)),
        { cause: error },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Property 5 support
// ---------------------------------------------------------------------------

/**
 * The pure derivation `ChatView`'s `innerStyle` performs, mirrored here rather than imported
 * so the property does not need to render React. Kept character-for-character equivalent to
 * `ChatView.tsx`'s `useMemo` body; the source-shape assertion below pins that equivalence.
 */
function publishChatContentWidthVariable(width: number | null): Record<string, string> | undefined {
  return width === null ? undefined : { '--lumiverse-chat-content-width': `${width}px` }
}

/**
 * Independent expected-width model, written from Requirement 2.2/2.3 and the design's preset
 * table using literal widths rather than the resolver's exported constants, so the property is
 * not a tautology restating `resolveChatContentWidthPx`. `null` means unconstrained.
 */
const EXPECTED_CONTENT_WIDTH_MODEL = {
  full: 'unconstrained',
  comfortable: 1000,
  compact: 760,
  custom: 'custom-width',
} as const satisfies Record<ChatWidthMode, number | 'unconstrained' | 'custom-width'>

function expectedChatContentWidth(mode: ChatWidthMode, customWidth: number): number | null {
  const entry = EXPECTED_CONTENT_WIDTH_MODEL[mode]
  if (entry === 'unconstrained') return null
  if (entry === 'custom-width') {
    return Number.isFinite(customWidth) && customWidth > 0 ? customWidth : null
  }
  return entry
}

describe('chat content width authority', () => {
  // Feature: portrait-dock-reload-anchoring, Property 5
  // For any Chat_Width_Mode and any custom content width, the width used as the reclaim input
  // equals the width Chat_View publishes through `--lumiverse-chat-content-width`, and the
  // resolver reports "unconstrained" exactly for the modes in which Chat_View publishes no
  // variable at all.
  // Validates: Requirements 2.4, 6.6, 7.1
  test('Feature: portrait-dock-reload-anchoring, Property 5 — one source of truth for the chat content width', () => {
    const observedModes = new Set<ChatWidthMode>()
    const observedInvalidWidths = new Set<string>()
    let observedUnconstrained = 0
    let observedConstrained = 0

    forAll(
      'Property 5',
      (rng) => ({
        mode: randomChatWidthMode(rng),
        customWidth: randomCustomWidth(rng),
        bodyWidth: randomBodyWidth(rng),
      }),
      ({ mode, customWidth, bodyWidth }) => {
        observedModes.add(mode)
        if (!(Number.isFinite(customWidth) && customWidth > 0)) {
          observedInvalidWidths.add(String(customWidth))
        }

        const expected = expectedChatContentWidth(mode, customWidth)
        const resolved = resolveChatContentWidthPx(mode, customWidth)

        // The resolver agrees with the independent model, so it is the authority and not
        // merely self-consistent.
        expect(resolved).toBe(expected)

        const published = publishChatContentWidthVariable(resolved)

        if (expected === null) {
          observedUnconstrained += 1
          // Unconstrained is reported by publishing no variable at all.
          expect(published).toBeUndefined()
          // The reclaim math reads an unconstrained mode as a zero-width gutter.
          expect(resolveChatContentWidthForReclaim(mode, customWidth, bodyWidth)).toBe(bodyWidth)
        } else {
          observedConstrained += 1
          // The published string is exactly the resolver's number in px.
          expect(published).toEqual({ '--lumiverse-chat-content-width': `${expected}px` })
          expect(published?.['--lumiverse-chat-content-width']).toBe(`${resolved}px`)
          // The reclaim input is that same width, so the two consumers cannot diverge.
          expect(resolveChatContentWidthForReclaim(mode, customWidth, bodyWidth)).toBe(expected)
        }
      },
    )

    // Input-space coverage: the property is worthless if the generator never reached a mode,
    // never produced an invalid custom width, or only ever exercised one branch.
    expect([...observedModes].sort()).toEqual([...CHAT_WIDTH_MODES].sort())
    expect(observedInvalidWidths.size).toBe(INVALID_CUSTOM_WIDTHS.length)
    expect(observedUnconstrained).toBeGreaterThan(0)
    expect(observedConstrained).toBeGreaterThan(0)
  })

  test('publishes the preset widths ChatView renders and pins the innerStyle derivation', async () => {
    // Fixed table, where randomization adds nothing.
    expect(resolveChatContentWidthPx('full', 1400)).toBeNull()
    expect(resolveChatContentWidthPx('comfortable', 1400)).toBe(CHAT_CONTENT_WIDTH_PRESETS.comfortable)
    expect(resolveChatContentWidthPx('compact', 1400)).toBe(CHAT_CONTENT_WIDTH_PRESETS.compact)
    expect(resolveChatContentWidthPx('custom', 1400)).toBe(1400)
    for (const invalid of INVALID_CUSTOM_WIDTHS) {
      expect(resolveChatContentWidthPx('custom', invalid)).toBeNull()
    }

    // `publishChatContentWidthVariable` above stands in for ChatView's `innerStyle`; assert the
    // real call site still routes through the resolver and still publishes that exact shape, so
    // the model cannot drift away from the component it represents.
    const chatView = await Bun.file(resolve(import.meta.dir, 'ChatView.tsx')).text()
    const innerStyle = chatView
      .match(/const innerStyle = useMemo<[\s\S]*?\}, \[chatWidthMode, chatContentMaxWidth\]\)/)?.[0]
      ?? '<innerStyle useMemo not found in ChatView.tsx>'

    expect(innerStyle).toContain('resolveChatContentWidthPx(chatWidthMode, chatContentMaxWidth)')
    expect(innerStyle).toContain('width === null')
    expect(innerStyle).toContain('undefined')
    expect(innerStyle).toContain("'--lumiverse-chat-content-width': `${width}px`")
  })

  test('treats a runtime-invalid persisted width mode as unconstrained', () => {
    const invalidModes: unknown[] = ['future-mode', '', null, 1, { mode: 'compact' }]

    for (const invalidMode of invalidModes) {
      const mode = invalidMode as ChatWidthMode
      expect(resolveChatContentWidthPx(mode, 1400)).toBeNull()
      expect(resolveChatContentWidthForReclaim(mode, 1400, 1920)).toBe(1920)
    }
  })
})

// ---------------------------------------------------------------------------
// Reclaim measurement support (Properties 1-4)
// ---------------------------------------------------------------------------

/**
 * The exact number the `PortraitDock` reclaim effect writes, for one fully-ready input tuple.
 * Mirrors `measure()`'s final two statements (`resolveChatContentWidthForReclaim` feeding
 * `Math.round(getPortraitLayoutReclaim(...))`) so every reclaim property measures what the
 * component measures rather than a re-derivation of it.
 *
 * `bodyWidth` and `dockWidth` are layout px, matching the effect: the effect's only rendered-px
 * input is the body rect, and it converts through `toLayoutBox` before this point.
 *
 * MUST be called from inside a `test()` — `getPortraitLayoutReclaim` is bound by the `beforeAll`
 * dynamic import of `./PortraitDock`, so it is still `undefined` at module evaluation time.
 */
function measureReclaim(
  bodyWidth: number,
  mode: ChatWidthMode,
  customWidth: number,
  dockWidth: number,
): number {
  const contentWidth = resolveChatContentWidthForReclaim(mode, customWidth, bodyWidth)
  return Math.round(getPortraitLayoutReclaim(bodyWidth, contentWidth, dockWidth))
}

describe('portrait dock reclaim budget', () => {
  // Feature: portrait-dock-reload-anchoring, Property 1
  // For any body width greater than zero, any Chat_Width_Mode, any custom content width, and
  // any dock width no greater than the body width, the computed Layout_Reclaim is >= 0 and
  // <= the dock width: the dock can never reclaim more horizontal space than it occupies, and
  // never applies an outward (positive-gap) margin.
  //
  // SCOPE LIMITATION — read before treating a green run as evidence.
  // This property is arithmetic over the reclaim inputs. For the rendered-geometry criteria in
  // the list below (1.1, 2.1, 6.6) it validates ONLY the numeric precondition, that the reclaim
  // number lands inside its lane budget. Their rendered clauses — a zero rendered gap between
  // the dock's inner edge and Chat_Column's outer edge, and rendered bubble centering within
  // Chat_Content — are established SOLELY by the runtime verification steps (tasks 8.3 and 8.5)
  // against the running instance. A green run here is not evidence about rendered geometry and
  // must not be reported as such.
  // Validates: Requirements 1.1, 1.3, 1.6, 2.1, 4.3, 6.6
  test('Feature: portrait-dock-reload-anchoring, Property 1 — reclaim stays within its lane budget', () => {
    const observedModes = new Set<ChatWidthMode>()
    let observedZeroReclaim = 0
    let observedPositiveReclaim = 0

    forAll(
      'Property 1',
      (rng) => {
        // `randomBodyWidth` can draw below the 180 layout px dock minimum, and a body narrower
        // than the dock is not a state this property is about (the task fixes
        // `dockWidth <= bodyWidth`, and `randomDockWidth` floors at the dock minimum, so the
        // two constraints are only jointly satisfiable at `bodyWidth >= 180`). Clamping up to
        // the minimum keeps every drawn tuple inside the property's stated precondition instead
        // of silently generating dockWidth > bodyWidth. Bodies narrower than the dock minimum
        // are therefore out of this property's input space by construction.
        const bodyWidth = Math.max(PORTRAIT_DOCK_MIN_WIDTH, randomBodyWidth(rng))
        return {
          bodyWidth,
          mode: randomChatWidthMode(rng),
          customWidth: randomCustomWidth(rng),
          dockWidth: randomDockWidth(rng, bodyWidth),
        }
      },
      ({ bodyWidth, mode, customWidth, dockWidth }) => {
        observedModes.add(mode)

        // Preconditions the generator promises, asserted so a generator regression surfaces
        // here rather than quietly weakening the property.
        expect(bodyWidth).toBeGreaterThan(0)
        expect(dockWidth).toBeLessThanOrEqual(bodyWidth)

        const reclaim = measureReclaim(bodyWidth, mode, customWidth, dockWidth)

        expect(Number.isFinite(reclaim)).toBe(true)
        expect(reclaim).toBeGreaterThanOrEqual(0)
        expect(reclaim).toBeLessThanOrEqual(dockWidth)

        if (reclaim === 0) observedZeroReclaim += 1
        else observedPositiveReclaim += 1
      },
    )

    // Input-space coverage: all four modes reached, and both branches of the reserved-width
    // saturation exercised, so the bound is not vacuously passing on a single branch.
    expect([...observedModes].sort()).toEqual([...CHAT_WIDTH_MODES].sort())
    expect(observedZeroReclaim).toBeGreaterThan(0)
    expect(observedPositiveReclaim).toBeGreaterThan(0)
  })
})

describe('portrait dock full-width lane claim', () => {
  // Feature: portrait-dock-reload-anchoring, Property 3
  // For any body width greater than zero and any dock width at or above the dock minimum, when
  // Chat_Width_Mode is `full` the computed Layout_Reclaim is exactly zero, so the dock claims
  // its full width from the space available to Chat_Column.
  //
  // WHY ZERO IS CORRECT HERE, AND WHY THAT IS THE POINT OF THE FIX.
  // With `full`, the resolver reports unconstrained, which the reclaim input reads as
  // `contentWidth === bodyWidth`. The arithmetic then collapses:
  //   naturalGutter  = max(0, (bodyWidth - bodyWidth) / 2)            = 0
  //   reservedWidth  = min(W, max(0, 2 * (W + CHAT_GAP - 0)))
  //                  = min(W, 2W - 40)                               = W   for any W > 40
  //   reclaim        = W - reservedWidth                              = 0
  // The dock minimum width is 180 layout px, far above that 40 px saturation threshold, so the
  // saturation always applies in practice and the zero holds for EVERY dock width at or above
  // the minimum. Crucially this zero is produced by the ARITHMETIC, with the observers attached
  // and `chatWidthMode` in the effect's dependency list — not by a bail that also skipped
  // observer registration. That distinction is the whole point of the fix: a `full` -> `custom`
  // flip now recomputes to a positive reclaim without a reload.
  //
  // SCOPE LIMITATION — read before treating a green run as evidence.
  // This property validates ONLY the numeric precondition of Requirement 2.2, that the reclaim
  // is exactly zero so the dock claims its full width. The criterion's rendered-edge clause —
  // that the dock's inner edge coincides with Chat_Column's outer edge at a zero-pixel gap — is
  // established SOLELY by the runtime verification step (task 8.3) against the running instance.
  // A green run here is not evidence about rendered geometry and must not be reported as such.
  // Validates: Requirements 2.2
  test('Feature: portrait-dock-reload-anchoring, Property 3 — `full` mode claims the entire dock width', () => {
    // The saturation threshold the derivation above depends on. Asserted rather than assumed,
    // so a change to either constant surfaces here instead of silently making the zero
    // conditional on the drawn dock width.
    expect(PORTRAIT_DOCK_MIN_WIDTH).toBeGreaterThan(40)

    const observedInvalidWidths = new Set<string>()
    let observedValidCustomWidths = 0
    let observedBodyNarrowerThanDock = 0
    let observedBodyWiderThanDock = 0

    forAll(
      'Property 3',
      (rng) => ({
        // Every drawn body width is > 0; unlike Property 1 this property places no
        // `dockWidth <= bodyWidth` precondition, because the `full`-mode zero does not depend
        // on the dock fitting the lane.
        bodyWidth: randomBodyWidth(rng),
        dockWidth: randomDockWidth(rng),
        // Irrelevant to `full` by construction — drawn anyway to assert that irrelevance.
        customWidth: randomCustomWidth(rng),
        // A corrupt settings row: `custom` with a non-finite or non-positive width. The
        // resolver degrades it to unconstrained, so it must behave identically to `full`.
        invalidCustomWidth: pickOne(rng, INVALID_CUSTOM_WIDTHS) as number,
      }),
      ({ bodyWidth, dockWidth, customWidth, invalidCustomWidth }) => {
        expect(bodyWidth).toBeGreaterThan(0)
        expect(dockWidth).toBeGreaterThanOrEqual(PORTRAIT_DOCK_MIN_WIDTH)

        if (Number.isFinite(customWidth) && customWidth > 0) observedValidCustomWidths += 1
        observedInvalidWidths.add(String(invalidCustomWidth))
        if (dockWidth > bodyWidth) observedBodyNarrowerThanDock += 1
        else observedBodyWiderThanDock += 1

        // The claim itself: exactly zero, at the drawn dock width.
        expect(measureReclaim(bodyWidth, 'full', customWidth, dockWidth)).toBe(0)

        // The zero holds across the whole admissible dock-width range, not just the drawn
        // point: at the minimum itself, and at the widest dock the bounds allow.
        expect(measureReclaim(bodyWidth, 'full', customWidth, PORTRAIT_DOCK_MIN_WIDTH)).toBe(0)
        expect(measureReclaim(bodyWidth, 'full', customWidth, 720)).toBe(0)

        // A corrupt custom width degrades to unconstrained, so it produces the same zero.
        expect(measureReclaim(bodyWidth, 'custom', invalidCustomWidth, dockWidth)).toBe(0)
        expect(measureReclaim(bodyWidth, 'custom', invalidCustomWidth, dockWidth))
          .toBe(measureReclaim(bodyWidth, 'full', customWidth, dockWidth))
      },
    )

    // Input-space coverage: the property is worthless if it never saw a valid custom width
    // (proving `full` ignores it), never reached every corrupt-row value, or only ever drew
    // bodies on one side of the dock width.
    expect(observedValidCustomWidths).toBeGreaterThan(0)
    expect(observedInvalidWidths.size).toBe(INVALID_CUSTOM_WIDTHS.length)
    expect(observedBodyNarrowerThanDock).toBeGreaterThan(0)
    expect(observedBodyWiderThanDock).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Property 4 support — an INDEPENDENTLY derived gutter model
//
// HOW THIS MODEL IS DERIVED, AND WHY IT IS INDEPENDENT OF THE IMPLEMENTATION.
//
// It is derived from Requirement 2.3's two clauses — the dock renders with `Flush_Overlap`
// and claims only the portion of its width that exceeds the available chat gutter — plus one
// layout fact about a centered max-width column. Nothing below calls, imports, or textually
// copies `getPortraitLayoutReclaim`, and nothing below reads `CHAT_GAP` or
// `CHAT_CONTENT_WIDTH_PRESETS`; the mode widths come from the literal table already used by
// Property 5 and the overlap allowance is spelled as its own positive literal.
//
// The derivation, working in layout px from Chat_Body's inner edge on the dock's side:
//
//  1. Chat_Content carries a max-width and is centered inside Chat_Column, so with the whole
//     body available its outer edge sits `gutter = max(0, (bodyWidth - contentWidth) / 2)`
//     from the body edge. `contentWidth` is `min(bodyWidth, declaredWidth)` because a
//     max-width column can never be wider than the box it sits in.
//  2. When the dock CLAIMS `c` px of layout space on its side, Chat_Column is left with
//     `bodyWidth - c`, and the still-centered content loses HALF of that on each side. So the
//     content's outer edge sits at `gutter + c / 2`, and the dock's inner edge — which is at
//     `dockWidth` — overlaps the content by `overlap(c) = dockWidth - (gutter + c / 2)`.
//     That halving is the whole reason the claim is not a plain `dockWidth - gutter`
//     subtraction: every px claimed only moves the content edge half a px.
//  3. `Flush_Overlap` fixes the required overlap at 20 px, so the claim that satisfies the
//     requirement is the `c` solving `overlap(c) = 20`, i.e. `c = 2 * (dockWidth - 20 - gutter)`.
//  4. `c` is clamped to `[0, dockWidth]`: the dock cannot claim negative space, and cannot
//     claim more than it occupies. Clamping to 0 is the "gutter already absorbs the whole
//     dock" regime; clamping to `dockWidth` is the "dock cannot reach flush even claiming
//     everything" regime, where it claims all of itself and overlaps by more than 20 px.
//  5. `Layout_Reclaim` is the part of the dock NOT claimed from the flow — the negative margin
//     the dock applies on its inner side — so it is `dockWidth - c`.
// ---------------------------------------------------------------------------

/**
 * The `Flush_Overlap` allowance in layout px, as a POSITIVE overlap distance. The
 * implementation spells the same allowance as a signed gap (`CHAT_GAP = -20`); this model
 * never reads that constant, so changing it surfaces as a disagreement here rather than
 * moving both sides of the comparison together.
 */
const MODEL_FLUSH_OVERLAP_PX = 20

/** The constrained width modes — the modes that publish a content max-width. */
const CONSTRAINED_CHAT_WIDTH_MODES = ['comfortable', 'compact', 'custom'] as const

type ConstrainedChatWidthMode = typeof CONSTRAINED_CHAT_WIDTH_MODES[number]

/** Step 1 of the derivation: the natural gutter beside a centered max-width column. */
function modelNaturalGutterPx(
  bodyWidth: number,
  mode: ConstrainedChatWidthMode,
  customWidth: number,
): number {
  const declaredWidth = expectedChatContentWidth(mode, customWidth)
  if (declaredWidth === null) {
    throw new Error(
      `Property 4's input space is the constrained modes only, but ${mode} with customWidth `
      + `${String(customWidth)} is unconstrained (that is Property 3's territory).`,
    )
  }
  const contentWidth = Math.min(bodyWidth, declaredWidth)
  return Math.max(0, (bodyWidth - contentWidth) / 2)
}

/** Step 2 of the derivation: the overlap the dock achieves for a given claimed width. */
function modelAchievedOverlapPx(
  bodyWidth: number,
  mode: ConstrainedChatWidthMode,
  customWidth: number,
  dockWidth: number,
  claimedWidth: number,
): number {
  const gutter = modelNaturalGutterPx(bodyWidth, mode, customWidth)
  return dockWidth - (gutter + claimedWidth / 2)
}

/** Steps 3 and 4: the claim that satisfies `Flush_Overlap`, clamped to what the dock can give. */
function modelClaimedWidthPx(
  bodyWidth: number,
  mode: ConstrainedChatWidthMode,
  customWidth: number,
  dockWidth: number,
): number {
  const gutter = modelNaturalGutterPx(bodyWidth, mode, customWidth)
  const flushClaim = 2 * (dockWidth - MODEL_FLUSH_OVERLAP_PX - gutter)
  return Math.min(dockWidth, Math.max(0, flushClaim))
}

/** Step 5: the reclaim, rounded exactly as the effect rounds before writing state. */
function modelReclaimPx(
  bodyWidth: number,
  mode: ConstrainedChatWidthMode,
  customWidth: number,
  dockWidth: number,
): number {
  return Math.round(dockWidth - modelClaimedWidthPx(bodyWidth, mode, customWidth, dockWidth))
}

describe('portrait dock constrained-mode gutter excess', () => {
  // Feature: portrait-dock-reload-anchoring, Property 4
  // For any body width, any Chat_Width_Mode in `comfortable`, `compact`, or `custom` with a
  // valid custom width, and any dock width, the computed Layout_Reclaim equals the value the
  // independently derived gutter model above produces — the dock width minus the portion of it
  // that fits within the natural gutter, floored at zero.
  //
  // SCOPE LIMITATION — read before treating a green run as evidence.
  // This property is arithmetic over the reclaim inputs. It establishes that the reclaim NUMBER
  // matches the flush-overlap geometry Requirement 2.3 describes. Whether the rendered dock
  // edge actually lands there also depends on the cascade, the ui-scale zoom, and the served
  // bundle, and is established SOLELY by the runtime verification step (task 8.3).
  // Validates: Requirements 2.3
  test('Feature: portrait-dock-reload-anchoring, Property 4 — constrained modes reclaim exactly the excess over the natural gutter', () => {
    const observedModes = new Set<ChatWidthMode>()
    let observedCustomNarrowerThanBody = 0
    let observedCustomWiderThanBody = 0
    let observedFullyAbsorbedByGutter = 0
    let observedExceedsGutter = 0
    let observedSaturatedClaim = 0

    forAll(
      'Property 4',
      (rng) => {
        const bodyWidth = randomBodyWidth(rng)
        return {
          bodyWidth,
          // Constrained modes only. An invalid custom width degrades to unconstrained, which
          // is Property 3's input space, so `randomValidCustomWidth` never draws one. It
          // straddles `bodyWidth`, so custom content narrower AND wider than the body is
          // reached — the branch where the gutter collapses to zero despite a declared width.
          mode: pickOne(rng, CONSTRAINED_CHAT_WIDTH_MODES),
          customWidth: randomValidCustomWidth(rng, bodyWidth),
          dockWidth: randomDockWidth(rng),
        }
      },
      ({ bodyWidth, mode, customWidth, dockWidth }) => {
        observedModes.add(mode)

        // Preconditions the generator promises. A regression that let an invalid custom width
        // through would silently move iterations into Property 3's input space.
        expect(bodyWidth).toBeGreaterThan(0)
        expect(Number.isFinite(customWidth)).toBe(true)
        expect(customWidth).toBeGreaterThan(0)
        expect(dockWidth).toBeGreaterThanOrEqual(PORTRAIT_DOCK_MIN_WIDTH)
        expect(expectedChatContentWidth(mode, customWidth)).not.toBeNull()

        if (mode === 'custom') {
          if (customWidth <= bodyWidth) observedCustomNarrowerThanBody += 1
          else observedCustomWiderThanBody += 1
        }

        // The claim itself: the implementation agrees with the independent model.
        const reclaim = measureReclaim(bodyWidth, mode, customWidth, dockWidth)
        expect(reclaim).toBe(modelReclaimPx(bodyWidth, mode, customWidth, dockWidth))

        // Second, semantic check on the SAME implementation output, so agreement is not just
        // two formulas matching: feed the implementation's own claimed width back through the
        // derivation's overlap equation and assert the flush contract it is supposed to hold.
        // Unrounded here, because rounding is a state-write concern and not part of the
        // geometry — the effect rounds only the value it stores.
        const contentWidth = resolveChatContentWidthForReclaim(mode, customWidth, bodyWidth)
        const exactReclaim = getPortraitLayoutReclaim(bodyWidth, contentWidth, dockWidth)
        const claimedWidth = dockWidth - exactReclaim
        const overlap = modelAchievedOverlapPx(bodyWidth, mode, customWidth, dockWidth, claimedWidth)
        const gutter = modelNaturalGutterPx(bodyWidth, mode, customWidth)

        expect(claimedWidth).toBeGreaterThanOrEqual(0)
        expect(claimedWidth).toBeLessThanOrEqual(dockWidth)

        if (claimedWidth === 0) {
          // Regime A — the natural gutter already absorbs the whole dock, so the dock claims
          // nothing from the flow and reclaims its full width. That is only correct when the
          // gutter plus the allowance already covers the dock.
          observedFullyAbsorbedByGutter += 1
          expect(reclaim).toBe(Math.round(dockWidth))
          expect(dockWidth).toBeLessThanOrEqual(gutter + MODEL_FLUSH_OVERLAP_PX)
          expect(overlap).toBeLessThanOrEqual(MODEL_FLUSH_OVERLAP_PX)
        } else {
          // Regime B — the dock exceeds the gutter, so it claims that excess.
          observedExceedsGutter += 1
          expect(dockWidth).toBeGreaterThan(gutter + MODEL_FLUSH_OVERLAP_PX)

          if (claimedWidth === dockWidth) {
            // Regime B2 — even claiming its entire width the dock cannot pull back to the
            // 20 px allowance, so it claims everything and overlaps by at least that much.
            observedSaturatedClaim += 1
            expect(reclaim).toBe(0)
            expect(overlap).toBeGreaterThanOrEqual(MODEL_FLUSH_OVERLAP_PX)
          } else {
            // Regime B1 — the flush solution is interior, so the achieved overlap is exactly
            // the allowance. Tolerance covers float division only.
            expect(Math.abs(overlap - MODEL_FLUSH_OVERLAP_PX)).toBeLessThan(1e-9)
          }
        }
      },
    )

    // Input-space coverage. Without these the property could pass vacuously on one mode or one
    // regime; the two regimes named by the task are asserted reached explicitly.
    expect([...observedModes].sort()).toEqual([...CONSTRAINED_CHAT_WIDTH_MODES].sort())
    expect(observedCustomNarrowerThanBody).toBeGreaterThan(0)
    expect(observedCustomWiderThanBody).toBeGreaterThan(0)
    expect(observedFullyAbsorbedByGutter).toBeGreaterThan(0)
    expect(observedExceedsGutter).toBeGreaterThan(0)
    expect(observedSaturatedClaim).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Property 2 support — a harness shaped like the effect's measurement write path
//
// The reclaim effect holds ONE `measure(targets)` closure reached through TWO call paths:
// `attach()` invokes it directly (the first measurement after mount) and the
// `new ResizeObserver(() => measure(targets))` that the same `attach()` registers invokes
// that identical closure on every later delivery. The harness below reproduces that exact
// shape — one closure, two dispatchers, one functional state write — so the property can
// assert the committed reclaim depends on nothing but the input tuple
// `(bodyWidth, chatWidthMode, chatContentMaxWidth, dockWidth)`.
//
// Deliberately NOT a React render. A rendered mount driven by fake observers is Property 6's
// territory (task 4.6); this property is purity and idempotence over the measurement itself.
// ---------------------------------------------------------------------------

/** The two call paths that reach the single `measure` closure in the effect. */
export type MeasurementTrigger = 'initial' | 'observer'

const MEASUREMENT_TRIGGER_COVERAGE = {
  initial: true,
  observer: true,
} as const satisfies Record<MeasurementTrigger, true>

const MEASUREMENT_TRIGGERS = Object.keys(MEASUREMENT_TRIGGER_COVERAGE) as MeasurementTrigger[]

/** One fully-ready measurement input tuple, all widths in layout px. */
interface MeasurementInputs {
  bodyWidth: number
  mode: ChatWidthMode
  customWidth: number
  dockWidth: number
}

/**
 * Models the `layoutReclaim` `useState` cell together with the effect's functional write
 * `setLayoutReclaim((current) => current === next ? current : next)`. `changes` counts only the
 * writes that actually moved the value — the ones React would turn into a re-render, and
 * therefore the ones that could move the rendered gap. An unchanged value must leave `changes`
 * alone, which is the link from purity to Requirement 1.3.
 */
interface ReclaimStateCell {
  /** The currently committed reclaim. */
  readonly value: number
  /** How many times the functional updater ran, whether or not it changed anything. */
  readonly writes: number
  /** How many times the committed value actually changed identity. */
  readonly changes: number
  apply: (updater: (current: number) => number) => void
}

function createReclaimStateCell(initial = 0): ReclaimStateCell {
  let value = initial
  let writes = 0
  let changes = 0
  return {
    get value() { return value },
    get writes() { return writes },
    get changes() { return changes },
    apply(updater) {
      writes += 1
      const next = updater(value)
      if (next !== value) {
        changes += 1
        value = next
      }
    },
  }
}

interface MeasurementProbe {
  /** Invoke the one closure through the named call path; returns the committed state. */
  invoke: (trigger: MeasurementTrigger) => number
  /** How many times the body box was read — a memoizing `measure` would stop reading. */
  readonly bodyReads: number
}

/**
 * Mirrors `measure(targets)` statement for statement over a fixed input tuple, and exposes the
 * two dispatchers that reach it. `bodyWidth` is layout px here for the same reason
 * `measureReclaim` takes layout px: the effect's only rendered-px input is the body rect, and
 * `toLayoutBox` has already divided out `--lumiverse-ui-scale` by this point.
 */
function createMeasurementProbe(inputs: MeasurementInputs, cell: ReclaimStateCell): MeasurementProbe {
  let bodyReads = 0
  const readBodyWidth = (): number => {
    bodyReads += 1
    return inputs.bodyWidth
  }

  // THE single closure. It closes over the input tuple and the state cell and holds no other
  // state, exactly as the effect's closure closes over `targets` and the render's props.
  const measure = (): number => {
    const bodyWidth = readBodyWidth()
    // A zero box means "not laid out yet": hold the current value rather than writing zero.
    if (!(bodyWidth > 0)) return cell.value
    const contentWidth = resolveChatContentWidthForReclaim(inputs.mode, inputs.customWidth, bodyWidth)
    const next = Math.round(getPortraitLayoutReclaim(bodyWidth, contentWidth, inputs.dockWidth))
    cell.apply((current) => (current === next ? current : next))
    return cell.value
  }

  // The ResizeObserver callback `attach()` registers. It is a wrapper around the same closure,
  // not a second implementation — so if the two paths ever disagreed it could only be because
  // `measure` carried per-call state.
  const observerCallback = (): number => measure()

  return {
    invoke(trigger) {
      switch (trigger) {
        case 'initial':
          return measure()
        case 'observer':
          return observerCallback()
        default:
          return assertNever(trigger)
      }
    },
    get bodyReads() { return bodyReads },
  }
}

describe('portrait dock measurement purity', () => {
  // Feature: portrait-dock-reload-anchoring, Property 2
  // For any measurement input tuple of body width, width mode, custom width, and dock width,
  // repeated measurement yields an identical Layout_Reclaim, independent of how many times it
  // runs, of which trigger invoked it, and of whether it is the first measurement after mount
  // or a later one.
  //
  // WHY THIS IS THE PROPERTY THE DEFECT NEEDS.
  // Requirement 1.2 states the reclaim applied at first paint equals the value the same inputs
  // produce after a later resize-driven recompute. That equality only holds if measurement is a
  // function of its inputs alone — no memo, no accumulation, no dependence on what was measured
  // before it, and no dependence on which trigger fired. Requirement 1.3 then follows from the
  // idempotence half: a stable value means the functional state write no-ops, so there is no
  // re-render churn and the gap cannot drift while the user does nothing.
  //
  // SCOPE LIMITATION — read before treating a green run as evidence.
  // This property is about the measurement function and its state write, not about a rendered
  // mount. Convergence under a hydration schedule is Property 6 (task 4.6); the rendered gap
  // itself is established solely by the runtime verification step (task 8.3).
  // Validates: Requirements 1.2, 1.3
  test('Feature: portrait-dock-reload-anchoring, Property 2 — measurement is a pure, idempotent function of its inputs', () => {
    const observedModes = new Set<ChatWidthMode>()
    const observedTriggers = new Set<MeasurementTrigger>()
    const observedFirstTriggers = new Set<MeasurementTrigger>()
    let observedRepeatsAboveTwo = 0
    let observedInterleavedForeign = 0
    let observedForeignValueDiffered = 0
    let observedZeroReclaim = 0
    let observedPositiveReclaim = 0

    forAll(
      'Property 2',
      (rng) => {
        // Same generator shape as Property 1: a body at least as wide as the dock minimum, and
        // a dock that fits the lane, so every tuple is one a docked dock can actually be in.
        const bodyWidth = Math.max(PORTRAIT_DOCK_MIN_WIDTH, randomBodyWidth(rng))
        const foreignBodyWidth = Math.max(PORTRAIT_DOCK_MIN_WIDTH, randomBodyWidth(rng))
        return {
          target: {
            bodyWidth,
            mode: randomChatWidthMode(rng),
            customWidth: randomCustomWidth(rng),
            dockWidth: randomDockWidth(rng, bodyWidth),
          } satisfies MeasurementInputs,
          // A second, unrelated tuple measured through the SAME state cell between repeats, so
          // "independent of what ran before it" is tested against genuinely perturbed state
          // rather than against a cell that never moved.
          foreign: {
            bodyWidth: foreignBodyWidth,
            mode: randomChatWidthMode(rng),
            customWidth: randomCustomWidth(rng),
            dockWidth: randomDockWidth(rng, foreignBodyWidth),
          } satisfies MeasurementInputs,
          repeatCount: randomInt(rng, 2, 6),
          // Drawn at a fixed length so the generator consumes the same number of PRNG values
          // every iteration and the seed stays reproducible.
          triggers: Array.from({ length: 8 }, () => pickOne(rng, MEASUREMENT_TRIGGERS)),
          // A stale value a pre-hydration render could have left in the cell.
          staleSeedOffset: randomInt(rng, 1, 400),
        }
      },
      ({ target, foreign, repeatCount, triggers, staleSeedOffset }) => {
        observedModes.add(target.mode)

        // Preconditions the generator promises.
        expect(target.bodyWidth).toBeGreaterThan(0)
        expect(target.dockWidth).toBeLessThanOrEqual(target.bodyWidth)
        expect(repeatCount).toBeGreaterThanOrEqual(2)
        if (repeatCount > 2) observedRepeatsAboveTwo += 1

        // The reference value the tuple determines, from the helper that mirrors the effect's
        // final two statements. Every assertion below compares against this one number.
        const reference = measureReclaim(target.bodyWidth, target.mode, target.customWidth, target.dockWidth)
        const foreignReference = measureReclaim(foreign.bodyWidth, foreign.mode, foreign.customWidth, foreign.dockWidth)
        if (reference === 0) observedZeroReclaim += 1
        else observedPositiveReclaim += 1
        if (foreignReference !== reference) observedForeignValueDiffered += 1

        // --- Phase A: repeated measurement is stable and writes nothing after the first ---
        const cell = createReclaimStateCell()
        const probe = createMeasurementProbe(target, cell)

        const firstTrigger = triggers[0] as MeasurementTrigger
        observedFirstTriggers.add(firstTrigger)
        observedTriggers.add(firstTrigger)

        // The first measurement after mount, through whichever path fired first.
        expect(probe.invoke(firstTrigger)).toBe(reference)
        expect(cell.value).toBe(reference)
        const changesAfterFirst = cell.changes
        expect(changesAfterFirst).toBeLessThanOrEqual(1)

        for (let repeat = 1; repeat < repeatCount; repeat += 1) {
          const trigger = triggers[repeat % triggers.length] as MeasurementTrigger
          observedTriggers.add(trigger)
          expect(probe.invoke(trigger)).toBe(reference)
          // Requirement 1.3: after the first write the functional updater returns the current
          // value, so the committed state never changes again and nothing re-renders. The write
          // itself still happens, which is what distinguishes a no-op write from a skipped one.
          expect(cell.changes).toBe(changesAfterFirst)
          expect(cell.writes).toBe(repeat + 1)
        }
        // No memoization: every invocation went back to the box for the width.
        expect(probe.bodyReads).toBe(repeatCount)

        // --- Phase B: the result does not depend on what was measured before it ---
        // The foreign tuple writes through the SAME cell, so the target's next measurement runs
        // against a cell holding an unrelated value. It must land back on `reference` exactly.
        const foreignProbe = createMeasurementProbe(foreign, cell)
        for (let repeat = 0; repeat < repeatCount; repeat += 1) {
          const foreignTrigger = triggers[(repeat + 1) % triggers.length] as MeasurementTrigger
          expect(foreignProbe.invoke(foreignTrigger)).toBe(foreignReference)
          observedInterleavedForeign += 1

          const trigger = triggers[(repeat + 3) % triggers.length] as MeasurementTrigger
          observedTriggers.add(trigger)
          expect(probe.invoke(trigger)).toBe(reference)
          expect(cell.value).toBe(reference)
        }

        // --- Phase C: trigger-independence and first-versus-later invocation ---
        // The same tuple measured for the FIRST time through each path, on its own fresh cell,
        // produces the same value the long perturbed sequence above converged to. A first
        // measurement and a later one are the same measurement.
        for (const trigger of MEASUREMENT_TRIGGERS) {
          const freshCell = createReclaimStateCell()
          const freshProbe = createMeasurementProbe(target, freshCell)
          expect(freshProbe.invoke(trigger)).toBe(reference)
          expect(freshCell.value).toBe(cell.value)
        }

        // A cell already holding a stale value — the shape of the defect, where a pre-hydration
        // pass left a wrong reclaim behind — converges on its very first measurement, with no
        // interaction and no second trigger required.
        const staleValue = reference + staleSeedOffset
        const staleCell = createReclaimStateCell(staleValue)
        const staleProbe = createMeasurementProbe(target, staleCell)
        expect(staleValue).not.toBe(reference)
        expect(staleProbe.invoke(firstTrigger)).toBe(reference)
        expect(staleCell.changes).toBe(1)
        // And it stays there: the second measurement is a no-op write.
        expect(staleProbe.invoke(firstTrigger === 'initial' ? 'observer' : 'initial')).toBe(reference)
        expect(staleCell.changes).toBe(1)
        expect(staleCell.writes).toBe(2)
      },
    )

    // Input-space coverage. Without these the property could pass while never repeating more
    // than twice, never interleaving a foreign measurement, or only ever seeing one reclaim
    // regime — any of which would make the idempotence claim vacuous.
    expect([...observedModes].sort()).toEqual([...CHAT_WIDTH_MODES].sort())
    expect([...observedTriggers].sort()).toEqual([...MEASUREMENT_TRIGGERS].sort())
    expect([...observedFirstTriggers].sort()).toEqual([...MEASUREMENT_TRIGGERS].sort())
    expect(observedRepeatsAboveTwo).toBeGreaterThan(0)
    expect(observedInterleavedForeign).toBeGreaterThan(0)
    expect(observedForeignValueDiffered).toBeGreaterThan(0)
    expect(observedZeroReclaim).toBeGreaterThan(0)
    expect(observedPositiveReclaim).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Property 6 support — the hydration race expressed as an input-arrival schedule
//
// WHAT THIS PROPERTY ADDS THAT PROPERTIES 1-4 DO NOT.
// Properties 1-4 pin the measurement ARITHMETIC over a fully-ready input tuple. The reported
// defect was never an arithmetic error: `getPortraitLayoutReclaim(1920, 1400, 278)` has always
// returned 278. The defect was a SCHEDULE — the chat frame and the persisted width mode arrived
// after the dock's first layout pass, the effect bailed to zero, and it registered no observer,
// so nothing could recompute until the user resized or dragged something. This property is
// therefore about arrival order, not about numbers: for ANY order in which the inputs become
// available, the committed reclaim must land on the value a fully-ready mount would produce,
// with zero pointer, keyboard, resize, or dock-control input.
//
// IMPLEMENTATION APPROACH — read before extending this section.
// Two halves, each driven by the strongest thing available without a dependency install:
//
//  * TARGET RESOLUTION is REAL. `resolvePortraitLayoutTargets` is the exported implementation,
//    called against a real DOM built with `jsdom` (already a devDependency of this package;
//    no install is performed). The Spindle host chain is synthesized node for node, and the
//    schedule inserts `chat-body`, `chat-column`, and `chat-column-inner` at arbitrary points,
//    so `closest()`, `:scope >`, and the all-or-nothing contract are exercised as written. The
//    jsdom instance is LOCAL: no global `window` / `document` is installed, so the source-text
//    and pure-function tests in this file are unaffected.
//
//  * THE EFFECT'S SCHEDULING is a TRANSCRIBED HARNESS, not a React render. Rendering the real
//    `PortraitDock` would need a fabricated store covering `portraitDockSettings`,
//    `floatingAvatar`, `characters`, `usePersistentRect`, image loading, and portals — a large
//    fake surface whose drift would be invisible, and this file's module-scope
//    `mock.module('@/store', () => ({ useStore: () => ({}) }))` is shared by every test here.
//    Instead `createHydrationHarness` reproduces the effect's shape statement for statement —
//    the `mobile || isFloating` zero, `measure`'s hold on a zero box, `attach()`'s single
//    `ResizeObserver` over all three targets and its guard against a second attach, the
//    `MutationObserver` + `requestAnimationFrame` retry on attach failure with the frame
//    cancelled on success, unconditional cleanup, and React's dependency-change semantics
//    (cleanup, then re-run, with the deps captured in the closure). The observers and the frame
//    queue are fakes injected into that harness.
//
//    A transcription can drift from its original, so the drift is pinned: the test
//    `pins the reclaim effect's scheduling shape` below asserts the real effect's structure in
//    source, including that the ONLY `setLayoutReclaim(0)` in the component is the deliberate
//    `mobile || isFloating` one, and that `chatWidthMode` and `chatContentMaxWidth` are in the
//    dependency list. That assertion is what makes this harness evidence about the component.
//
// UNIT DISCIPLINE. The body rect stub reports layout px directly (ui scale 1), so the harness
// omits `toLayoutBox`'s division. Scale conversion is not this property's subject; the effect's
// source assertion below pins that the conversion is still there.
// ---------------------------------------------------------------------------

/**
 * A local jsdom instance. Deliberately NOT installed onto `globalThis`: every other test in
 * this file runs without DOM globals today, and `resolvePortraitLayoutTargets` only ever calls
 * methods on the element it is handed, so passing jsdom elements is sufficient.
 */
const PROPERTY_6_DOM = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const property6Document = PROPERTY_6_DOM.window.document

/**
 * The steps a hydration schedule may take. Every one of these is something the BROWSER or the
 * STORE does on its own after a reload — a subtree commits, a box gets laid out, settings
 * hydration replaces the default width mode, an observer delivers, a frame ticks. None of them
 * is a user action.
 */
type ScheduleStepKind =
  | 'commit-chat-body'
  | 'commit-chat-column'
  | 'commit-chat-content'
  | 'lay-out-body'
  | 'flip-width-mode'
  | 'deliver-resize'
  | 'deliver-mutation'
  | 'tick-frame'

const SCHEDULE_STEP_COVERAGE = {
  'commit-chat-body': true,
  'commit-chat-column': true,
  'commit-chat-content': true,
  'lay-out-body': true,
  'flip-width-mode': true,
  'deliver-resize': true,
  'deliver-mutation': true,
  'tick-frame': true,
} as const satisfies Record<ScheduleStepKind, true>

const SCHEDULE_STEP_KINDS = Object.keys(SCHEDULE_STEP_COVERAGE) as ScheduleStepKind[]

/**
 * The inputs Requirements 1.4 and 1.5 forbid this property from using. Convergence must happen
 * WITHOUT any of them, so they are not part of the step space at all — asserted disjoint below
 * rather than merely omitted, and the harness records any of them that a future edit sneaks in.
 */
const INTERACTION_STEP_KINDS = [
  'pointer-down',
  'key-down',
  'window-resize',
  'dock-drag',
  'dock-resize',
  'dock-side-toggle',
] as const

const DELIVERY_STEP_KINDS = ['deliver-resize', 'deliver-mutation', 'tick-frame'] as const

/** One committed reclaim write, together with the inputs that were live when it happened. */
interface MeasureWrite {
  trigger: MeasurementTrigger
  value: number
  bodyWidth: number
  mode: ChatWidthMode
  customWidth: number
}

/** What was resolvable at an `attach()` failure, so partial-readiness coverage is provable. */
interface ReadinessSnapshot {
  chatBody: boolean
  chatColumn: boolean
  chatContent: boolean
}

/** One store-hydration flip: the width mode and the custom width arriving together. */
interface WidthModeFlip {
  mode: ChatWidthMode
  customWidth: number
}

interface HydrationHarnessOptions {
  /** The body width the browser eventually lays out, in layout px. Starts at 0 (not laid out). */
  finalBodyWidth: number
  /** `panel.rect.width`, in layout px. Constant: changing it is a dock drag or resize. */
  dockWidth: number
  /** The pre-hydration width mode. `full` is the settings-slice default and the bug's shape. */
  initialMode: ChatWidthMode
  initialCustomWidth: number
  /** Store hydration arriving in one or more flips, consumed by `flip-width-mode` steps. */
  flips: readonly WidthModeFlip[]
  /**
   * The persisted `Canonical_Rect` the dock carries into the sequence. Copied on entry, so the
   * caller keeps a pristine object to compare against and an in-place mutation by the harness
   * cannot hide behind a shared reference. Defaults to the untouched default portrait rectangle.
   * Only Property 9 reads it back; the effect transcription never touches it.
   */
  canonicalRect?: SurfaceRectPrefs
  /**
   * `fixed` transcribes the effect as it stands. `pre-fix` transcribes the DEFECTIVE shape the
   * design's Root cause section describes, and exists only as this property's negative control:
   * a property that cannot fail against the bug it was written for is not evidence.
   *
   * `leaky-teardown` is a SECOND, DISTINCT defect shape, and it is Property 11's negative
   * control. `pre-fix` cannot serve as one: its bug is that it registers NOTHING on a failed
   * resolution, so it can never leak a registration. `leaky-teardown` keeps the fixed effect's
   * scheduling exactly and removes only the two guards Property 6's counterexample forced into
   * `attach()` and `retry()` — the idempotent-attach guard and the cancel of the frame requested
   * alongside the MutationObserver. That is the source as it stood between task 4.1 and the fix
   * task 4.6 provoked, and it is the only shape in which a ResizeObserver outlives its cleanup.
   *
   * `geometry-writing` is a THIRD defect shape and it is Property 9's negative control. It keeps
   * the fixed effect's scheduling exactly and adds the one thing the design promises the change
   * does NOT add: a write path from the measured reclaim into geometry. It pushes the reclaim
   * through `panel.setRect`, `updateFloatingAvatar`, and `setSetting`, and mutates the
   * `Canonical_Rect` IN PLACE, so a property that compared a shared reference or forgot to count
   * a write would pass against it. Neither `pre-fix` nor `leaky-teardown` can serve as this
   * control: both leave geometry alone, so both are indistinguishable from `fixed` here.
   */
  variant?: 'fixed' | 'pre-fix' | 'leaky-teardown' | 'geometry-writing'
}

/**
 * The three geometry write paths the design's "No-regression surface" says the reclaim never
 * reaches. Named exactly as the source spells them, so the ledger below and the source-shape
 * assertion in Property 9 talk about the same three sinks.
 */
type GeometryWriteKind = 'setSetting' | 'panel.setRect' | 'updateFloatingAvatar'

const GEOMETRY_WRITE_KIND_COVERAGE = {
  setSetting: true,
  'panel.setRect': true,
  updateFloatingAvatar: true,
} as const satisfies Record<GeometryWriteKind, true>

const GEOMETRY_WRITE_KINDS = Object.keys(GEOMETRY_WRITE_KIND_COVERAGE) as GeometryWriteKind[]

/** One recorded geometry write, with the rect it carried and the effect run that issued it. */
interface GeometryWrite {
  kind: GeometryWriteKind
  runId: number
  rect: SurfaceRectPrefs
}

type ObserverKind = 'resize' | 'mutation'

interface ObserverRecord {
  kind: ObserverKind
  callback: () => void
  targetCount: number
  live: boolean
}

/**
 * The three registration kinds the design's "Observers and teardown" table enumerates. The
 * effect introduces no timers, so there is no fourth kind; Requirement 7.4 names timers too and
 * the source assertion below pins their absence.
 */
type RegistrationKind = 'resize-observer' | 'mutation-observer' | 'animation-frame'

/**
 * How a registration ended. `disconnect` for observers; `delivered` or `cancelled` for a frame.
 * Requirement 7.4's frame clause is exactly "every frame is delivered or cancelled", so these
 * two are mutually exclusive dispositions of one handle, never a pair.
 */
type RegistrationRelease = 'disconnect' | 'delivered' | 'cancelled'

/**
 * One registration, tagged with the effect run that created it and the run that released it.
 * The `runId` pair is what makes "through the effect cleanup path THAT CREATED IT" checkable:
 * a global constructed-equals-disconnected tally would also pass if run 1's observer happened to
 * be disconnected by run 4's cleanup, which is a leak for the three runs in between.
 */
interface RegistrationRecord {
  kind: RegistrationKind
  /** 1-based index of the effect run whose body created this registration. */
  runId: number
  release: RegistrationRelease | null
  /** The run that was current when the release happened. Must equal `runId`. */
  releasedByRunId: number | null
  /**
   * Release attempts that arrived after the registration was already released. Two of these are
   * documented browser no-ops and are expected: `disconnect()` on an already-disconnected
   * MutationObserver (retry disconnects it, then cleanup disconnects it again), and
   * `cancelAnimationFrame` on a handle that has already been delivered (the rAF-retry path).
   * A second CANCEL of an already-cancelled handle is not a no-op in bookkeeping terms and is
   * asserted absent.
   */
  redundantReleases: RegistrationRelease[]
}

/** Which call path reached a successful `attach()`. Names the three late-attach cases. */
type AttachSource = 'initial' | 'mutation-retry' | 'frame-retry'

/**
 * The seven entries of the reclaim effect's dependency list, spelled as the source spells them.
 * A dependency change through ANY of them is a full cleanup-then-re-run commit, so each one is a
 * teardown path Requirement 7.4 covers. `Record<DependencyDriver, true>` below is the
 * compile-time coverage guard, and the source-shape test pins the same seven strings.
 */
type DependencyDriver =
  | 'chatContentMaxWidth'
  | 'chatWidthMode'
  | 'dockElement'
  | 'isFloating'
  | 'mobile'
  | 'panel.rect.width'
  | 'settings.dockSide'

/** A dependency change to commit, carrying the new value for whichever entry moved. */
type DependencyChange =
  | { driver: 'chatContentMaxWidth', customWidth: number }
  | { driver: 'chatWidthMode', mode: ChatWidthMode }
  | { driver: 'dockElement' }
  | { driver: 'isFloating', isFloating: boolean }
  | { driver: 'mobile', mobile: boolean }
  | { driver: 'panel.rect.width', dockWidth: number }
  | { driver: 'settings.dockSide', dockSide: 'left' | 'right' | 'floating' }

interface HydrationHarness {
  readonly cell: ReclaimStateCell
  readonly writes: readonly MeasureWrite[]
  /** `measure` calls that returned without writing because the body box was still zero. */
  readonly holds: number
  readonly attachFailures: readonly ReadinessSnapshot[]
  readonly attachSuccesses: number
  /** Writes taken by the deliberate `mobile || isFloating` zero path. Must stay 0 while docked. */
  readonly floatingZeroWrites: number
  readonly interactionLog: readonly string[]
  readonly effectRuns: number
  readonly constructedObservers: number
  readonly disconnectedObservers: number
  readonly liveObservers: number
  /**
   * ResizeObservers left behind because one effect run reached `attach()` successfully more than
   * once, overwriting the single `resizeObserver` binding cleanup can see. Derived from the
   * observed attach count, never hard-coded. The source now guards `attach()` on an existing
   * observer and cancels the pending frame on success, so this is 0 for every schedule; it is
   * asserted as 0 rather than deleted, so removing either guard is reported here.
   */
  readonly orphanedObservers: number
  readonly requestedFrames: number
  readonly pendingFrames: number
  readonly bodyWidth: number
  readonly mode: ChatWidthMode
  readonly customWidth: number
  readonly dockWidth: number
  readonly dockSide: 'left' | 'right' | 'floating'
  readonly mobile: boolean
  readonly isFloating: boolean
  /** False once `unmount()` has run, so the "current run may still hold registrations" allowance ends. */
  readonly mounted: boolean
  /** Every registration ever created, in creation order, with its run and its release. */
  readonly registrations: readonly RegistrationRecord[]
  /**
   * Registrations that were still unreleased when the cleanup of their OWN run had finished.
   * Populated by an audit that runs after every cleanup, so a leak is attributed to the run that
   * leaked it rather than showing up as an end-of-sequence total.
   */
  readonly outlivedRegistrations: readonly RegistrationRecord[]
  readonly constructedByKind: Readonly<Record<ObserverKind, number>>
  readonly disconnectedByKind: Readonly<Record<ObserverKind, number>>
  readonly framesDelivered: number
  readonly framesCancelled: number
  /** `cancelAnimationFrame` against a handle this harness never issued. Must stay 0. */
  readonly unknownFrameCancels: number
  /** The call path of each successful `attach()`, in order. Names the late-attach case reached. */
  readonly attachSources: readonly AttachSource[]
  /**
   * The LIVE `Canonical_Rect` the harness carries — the same object throughout, so an in-place
   * mutation is observable through it. The fixed effect never touches it.
   */
  readonly canonicalRect: SurfaceRectPrefs
  /** How many times each geometry sink was called. All three stay 0 for the fixed effect. */
  readonly geometryWrites: Readonly<Record<GeometryWriteKind, number>>
  /** Every geometry write in order, so a counterexample names the sink and the run. */
  readonly geometryWriteLog: readonly GeometryWrite[]
  mount: () => void
  step: (kind: ScheduleStepKind) => void
  /**
   * Commit a change to one of the seven dependency-list entries: React cleans up the previous
   * run and re-runs the effect. The caller must pass a value that actually differs from the
   * current one, so a change always produces exactly one additional effect run.
   */
  changeDependency: (change: DependencyChange) => void
  /** Flush every observer delivery and frame the browser would flush on its own. */
  settle: () => number
  unmount: () => void
}

/**
 * Builds a real DOM chat frame plus a transcription of the reclaim `useLayoutEffect`, driven by
 * fake observers and a fake frame queue. See the approach note above for why this is a
 * transcription rather than a React render, and for the source assertion that pins it.
 */
function createHydrationHarness(options: HydrationHarnessOptions): HydrationHarness {
  const doc = property6Document

  // A fresh subtree per harness, so iterations cannot observe each other's DOM.
  const documentRoot = doc.createElement('div')
  doc.body.appendChild(documentRoot)

  const chatBody = doc.createElement('div')
  chatBody.setAttribute('data-lumiverse-surface', 'chat-body')
  const chatColumn = doc.createElement('div')
  chatColumn.setAttribute('data-lumiverse-surface', 'chat-column')
  const chatContent = doc.createElement('div')
  chatContent.setAttribute('data-lumiverse-surface', 'chat-column-inner')

  // The real rendered chain, per the design's topology section. Every intermediate node is
  // `display: contents` in the stylesheet, which is exactly why the effect must use `closest()`.
  const spindleMount = doc.createElement('div')
  spindleMount.setAttribute('data-spindle-mount', 'chat_surface_side')
  const extensionRoot = doc.createElement('div')
  extensionRoot.setAttribute('data-spindle-extension-root', '')
  const hostSurface = doc.createElement('div')
  hostSurface.setAttribute('data-spindle-host-surface', 'portrait_dock.workspace')
  const surfaceNode = doc.createElement('div')
  surfaceNode.setAttribute('data-surface-id', 'portrait_dock.workspace')
  const bridgeRoot = doc.createElement('div')
  // `let`, because `dockElement` is one of the seven dependency-list entries: the dock's own node
  // is replaced when the bridge remounts it, which commits a cleanup-then-re-run of this effect.
  let dockElement = doc.createElement('aside')
  bridgeRoot.appendChild(dockElement)
  surfaceNode.appendChild(bridgeRoot)
  hostSurface.appendChild(surfaceNode)
  extensionRoot.appendChild(hostSurface)
  spindleMount.appendChild(extensionRoot)

  let bodyWidth = 0
  chatBody.getBoundingClientRect = (): DOMRect => ({
    width: bodyWidth,
    height: 600,
    top: 0,
    left: 0,
    right: bodyWidth,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })

  let bodyCommitted = false
  let columnCommitted = false
  let contentCommitted = false

  const variant = options.variant ?? 'fixed'

  /**
   * `ChatView` carries `data-chat-constrained` only when the width mode is not `full`, in both
   * the pre-fix and the fixed source. The fixed effect never reads it — the regression guard in
   * this file asserts that — but the pre-fix variant resolved its ancestor through it, which is
   * how a pre-hydration `full` mode stranded the dock.
   */
  const publishConstrainedAttribute = (mode: ChatWidthMode) => {
    if (mode === 'full') chatBody.removeAttribute('data-chat-constrained')
    else chatBody.setAttribute('data-chat-constrained', '')
  }
  publishConstrainedAttribute(options.initialMode)

  const observers: ObserverRecord[] = []
  const pendingDeliveries = new Set<ObserverRecord>()
  interface FrameEntry {
    callback: () => void
    registration: RegistrationRecord
  }
  const frames = new Map<number, FrameEntry>()
  /** Every frame handle ever issued, so a cancel of an ALREADY-released handle is classifiable. */
  const frameRegistrations = new Map<number, RegistrationRecord>()
  let nextFrameHandle = 1
  let requestedFrames = 0
  let constructedObservers = 0
  let disconnectedObservers = 0

  const cell = createReclaimStateCell()
  const writes: MeasureWrite[] = []
  const attachFailures: ReadinessSnapshot[] = []
  const interactionLog: string[] = []
  let holds = 0
  let attachSuccesses = 0
  let floatingZeroWrites = 0
  let effectRuns = 0
  let orphanedObservers = 0

  // --- Registration ledger (Requirement 7.4 / Property 11) -----------------
  // Every construction and every release is recorded against the effect run that was current at
  // the time, so parity can be checked PER RUN rather than only as an end-of-sequence tally.
  const registrations: RegistrationRecord[] = []
  const outlivedRegistrations: RegistrationRecord[] = []
  const constructedByKind: Record<ObserverKind, number> = { resize: 0, mutation: 0 }
  const disconnectedByKind: Record<ObserverKind, number> = { resize: 0, mutation: 0 }
  const attachSources: AttachSource[] = []
  let framesDelivered = 0
  let framesCancelled = 0
  let unknownFrameCancels = 0
  /** The run whose body is executing, or whose cleanup / callbacks are executing. 0 before mount. */
  let currentRunId = 0
  let mounted = false

  // --- Geometry write ledger (Requirement 5.5 / Property 9) ----------------
  // Stubs for the three sinks the design promises the reclaim never reaches. They are wired into
  // the transcription so that a write WOULD be recorded, which is what makes "zero calls" a
  // measurement rather than an omission; the `geometry-writing` variant exercises them.
  //
  // COPIED on entry, deliberately: the caller keeps the object it passed in, so a harness that
  // mutated the rect in place could not hide behind a shared reference in a deep-equal check.
  const canonicalRect: SurfaceRectPrefs = { ...(options.canonicalRect ?? DEFAULT_PORTRAIT_DOCK_SETTINGS.rect) }
  const geometryWrites: Record<GeometryWriteKind, number> = {
    setSetting: 0,
    'panel.setRect': 0,
    updateFloatingAvatar: 0,
  }
  const geometryWriteLog: GeometryWrite[] = []

  const recordGeometryWrite = (kind: GeometryWriteKind, rect: SurfaceRectPrefs) => {
    geometryWrites[kind] += 1
    geometryWriteLog.push({ kind, runId: currentRunId, rect: { ...rect } })
  }

  /**
   * The write path the `geometry-writing` control adds and the fixed effect does not have. It is
   * deliberately as nasty as a real regression would be: it mutates `canonicalRect` IN PLACE
   * before pushing it through all three sinks, so a property comparing a shared reference — or
   * only counting `setSetting` — would still pass.
   */
  const persistReclaimIntoGeometry = (reclaim: number) => {
    canonicalRect.x -= reclaim
    canonicalRect.width += reclaim
    recordGeometryWrite('panel.setRect', canonicalRect)
    recordGeometryWrite('updateFloatingAvatar', canonicalRect)
    recordGeometryWrite('setSetting', canonicalRect)
  }

  const openRegistration = (kind: RegistrationKind): RegistrationRecord => {
    const record: RegistrationRecord = {
      kind,
      runId: currentRunId,
      release: null,
      releasedByRunId: null,
      redundantReleases: [],
    }
    registrations.push(record)
    return record
  }

  /** Returns false when the registration was already released, so double-releases stay visible. */
  const releaseRegistration = (record: RegistrationRecord, release: RegistrationRelease): boolean => {
    if (record.release !== null) {
      record.redundantReleases.push(release)
      return false
    }
    record.release = release
    record.releasedByRunId = currentRunId
    return true
  }

  /**
   * Run immediately after a cleanup returns: anything the finished run created and did not
   * release has outlived its creating cleanup, which is exactly what Requirement 7.4 forbids.
   */
  const auditRun = (runId: number) => {
    for (const record of registrations) {
      if (record.runId !== runId) continue
      if (record.release === null && !outlivedRegistrations.includes(record)) {
        outlivedRegistrations.push(record)
      }
    }
  }

  const enqueue = (kind: ObserverKind) => {
    for (const record of observers) {
      if (record.live && record.kind === kind && record.targetCount > 0) pendingDeliveries.add(record)
    }
  }

  const flush = (kind: ObserverKind): number => {
    const due = [...pendingDeliveries].filter((record) => record.kind === kind)
    for (const record of due) {
      pendingDeliveries.delete(record)
      if (record.live) record.callback()
    }
    return due.length
  }

  const makeObserver = (kind: ObserverKind, callback: () => void) => {
    const record: ObserverRecord = { kind, callback, targetCount: 0, live: true }
    observers.push(record)
    constructedObservers += 1
    constructedByKind[kind] += 1
    const registration = openRegistration(kind === 'resize' ? 'resize-observer' : 'mutation-observer')
    return {
      registration,
      observe(_target: Element) {
        record.targetCount += 1
        // Both observers deliver on their own once observation starts: a ResizeObserver's
        // initial observation is guaranteed by spec, and a MutationObserver fires on the next
        // microtask after a matching mutation. Queue rather than call, so delivery ordering
        // stays part of the schedule.
        pendingDeliveries.add(record)
      },
      disconnect() {
        pendingDeliveries.delete(record)
        // A second `disconnect()` is a documented no-op — the retry path disconnects the
        // MutationObserver and cleanup disconnects it again — so it is recorded as a redundant
        // release rather than counted twice.
        if (!releaseRegistration(registration, 'disconnect')) return
        record.live = false
        disconnectedObservers += 1
        disconnectedByKind[kind] += 1
      },
    }
  }

  const requestFrame = (callback: () => void): number => {
    const handle = nextFrameHandle
    nextFrameHandle += 1
    requestedFrames += 1
    const registration = openRegistration('animation-frame')
    frames.set(handle, { callback, registration })
    frameRegistrations.set(handle, registration)
    return handle
  }

  const cancelFrame = (handle: number) => {
    const registration = frameRegistrations.get(handle)
    if (!registration) {
      // `0` is never a valid handle and the source guards on it, so this can only fire if a
      // handle from nowhere reached `cancelAnimationFrame`.
      unknownFrameCancels += 1
      return
    }
    frames.delete(handle)
    // Cancelling a handle that has already been DELIVERED is what a browser treats as a no-op,
    // and the rAF-retry path does exactly that. It must not change the frame's disposition.
    if (releaseRegistration(registration, 'cancelled')) framesCancelled += 1
  }

  const tickFrames = (): number => {
    const due = [...frames.values()]
    frames.clear()
    for (const entry of due) {
      // Marked delivered BEFORE the callback runs, matching the browser: the handle is already
      // dequeued by the time the callback can call `cancelAnimationFrame` on it.
      if (releaseRegistration(entry.registration, 'delivered')) framesDelivered += 1
      entry.callback()
    }
    return due.length
  }

  interface EffectDeps {
    mobile: boolean
    isFloating: boolean
    mode: ChatWidthMode
    customWidth: number
    dockWidth: number
    dockSide: 'left' | 'right' | 'floating'
    /**
     * Stands in for the `dockElement` dependency's IDENTITY. React compares the element by
     * reference, so a remounted dock node is a dependency change; this counter moves with the
     * node swap so the harness's change detection sees what React would see.
     */
    dockElementVersion: number
  }

  let deps: EffectDeps = {
    mobile: false,
    isFloating: false,
    mode: options.initialMode,
    customWidth: options.initialCustomWidth,
    dockWidth: options.dockWidth,
    dockSide: 'left',
    dockElementVersion: 0,
  }
  let committed: EffectDeps | null = null
  let cleanup: (() => void) | null = null

  /**
   * THE DEFECT, transcribed from the design's Root cause section, for use as this property's
   * negative control only. Three differences from the fixed effect, all of them the bug:
   *
   *  1. Resolution keys on `data-chat-constrained`, which a pre-hydration `full` mode does not
   *     publish, so the lookup fails on the first post-reload layout pass.
   *  2. A failed resolution WRITES ZERO and registers no observer at all, so nothing can
   *     recompute. This is the stranding.
   *  3. The content width is read back off the cascade, and an unconstrained cascade is reported
   *     as "no reclaim" rather than as "not ready" (the fourth bail, which can self-heal because
   *     it happens with observers attached).
   *
   * Paired with a dependency list that omits `chatWidthMode` and `chatContentMaxWidth`, so a
   * hydration flip cannot re-run the effect either. See `render` below.
   */
  const runDefectiveEffect = (captured: EffectDeps) => {
    let resizeObserver: ReturnType<typeof makeObserver> | null = null

    const resolveDefectiveTargets = (): PortraitLayoutTargets | null => {
      const bodyElement = dockElement.closest<HTMLElement>('[data-chat-constrained]')
      if (!bodyElement) return null
      const resolvedColumn = columnCommitted ? chatColumn : null
      const resolvedContent = contentCommitted ? chatContent : null
      if (!resolvedColumn || !resolvedContent) return null
      return { bodyElement, chatColumn: resolvedColumn, chatContent: resolvedContent }
    }

    const measureDefectively = (targets: PortraitLayoutTargets, trigger: MeasurementTrigger) => {
      const measuredBodyWidth = targets.bodyElement.getBoundingClientRect().width
      // The cascade is live even though the effect did not re-run, so the published width is
      // read from the CURRENT store values rather than from the captured ones.
      const declared = resolveChatContentWidthPx(deps.mode, deps.customWidth)
      const next = declared === null || !(measuredBodyWidth > 0)
        ? 0
        : Math.round(getPortraitLayoutReclaim(measuredBodyWidth, declared, captured.dockWidth))
      cell.apply((current) => (current === next ? current : next))
      writes.push({
        trigger,
        value: next,
        bodyWidth: measuredBodyWidth,
        mode: deps.mode,
        customWidth: deps.customWidth,
      })
    }

    const targets = resolveDefectiveTargets()
    if (!targets) {
      attachFailures.push({
        chatBody: bodyCommitted,
        chatColumn: columnCommitted,
        chatContent: contentCommitted,
      })
      cell.apply(() => 0)
      cleanup = null
      return
    }

    attachSuccesses += 1
    measureDefectively(targets, 'initial')
    resizeObserver = makeObserver('resize', () => measureDefectively(targets, 'observer'))
    resizeObserver.observe(targets.bodyElement)
    resizeObserver.observe(targets.chatColumn)
    resizeObserver.observe(targets.chatContent)
    cleanup = () => {
      resizeObserver?.disconnect()
      resizeObserver = null
    }
  }

  // --- The transcription of the reclaim useLayoutEffect ---------------------
  const runEffect = (captured: EffectDeps) => {
    effectRuns += 1
    currentRunId = effectRuns

    if (variant === 'pre-fix') {
      runDefectiveEffect(captured)
      return
    }

    // The two guards the Property 6 counterexample forced into the source. `leaky-teardown`
    // removes exactly these and nothing else, which is Property 11's negative control.
    const guardIdempotentAttach = variant !== 'leaky-teardown'
    const releaseFrameOnRetrySuccess = variant !== 'leaky-teardown'

    if (captured.mobile || captured.isFloating) {
      floatingZeroWrites += 1
      cell.apply(() => 0)
      cleanup = null
      return
    }

    let frame = 0
    let resizeObserver: ReturnType<typeof makeObserver> | null = null
    let mutationObserver: ReturnType<typeof makeObserver> | null = null
    let attachesInThisRun = 0
    // Instrumentation only: names which of the three call paths reached a successful `attach()`,
    // so Property 11 can prove it reached all three late-attach cases rather than assuming it.
    let attachSource: AttachSource = 'initial'

    const measure = (targets: PortraitLayoutTargets, trigger: MeasurementTrigger) => {
      const measuredBodyWidth = targets.bodyElement.getBoundingClientRect().width
      if (!(measuredBodyWidth > 0)) {
        holds += 1
        return
      }
      const contentWidth = resolveChatContentWidthForReclaim(
        captured.mode,
        captured.customWidth,
        measuredBodyWidth,
      )
      const next = Math.round(getPortraitLayoutReclaim(measuredBodyWidth, contentWidth, captured.dockWidth))
      cell.apply((current) => (current === next ? current : next))
      writes.push({
        trigger,
        value: next,
        bodyWidth: measuredBodyWidth,
        mode: captured.mode,
        customWidth: captured.customWidth,
      })
      // The fixed effect stops at the `useState` write above: `layoutReclaim` is component-local
      // and reaches the DOM only through `resolveDockReclaimStyle` in `dockStyle`. Property 9's
      // negative control is the shape where it does NOT stop there.
      if (variant === 'geometry-writing') persistReclaimIntoGeometry(next)
    }

    const attach = (): boolean => {
      // Idempotent, exactly as the source is: a re-entry after a successful attach reports the
      // existing one instead of constructing a second ResizeObserver over the same binding.
      if (guardIdempotentAttach && resizeObserver) return true
      const targets = resolvePortraitLayoutTargets(dockElement)
      if (!targets) {
        attachFailures.push({
          chatBody: bodyCommitted,
          chatColumn: columnCommitted,
          chatContent: contentCommitted,
        })
        return false
      }
      attachSuccesses += 1
      attachesInThisRun += 1
      attachSources.push(attachSource)
      // A second successful attach inside one effect run would overwrite the binding below and
      // leave the previous observer unreachable from cleanup. The guard above makes that
      // unreachable; the counter stays as a drift detector, so a future edit that removes the
      // guard is reported as an orphaned registration rather than passing silently.
      if (attachesInThisRun > 1) orphanedObservers += 1
      measure(targets, 'initial')
      // ONE observer over all three targets, exactly as `attach()` registers it.
      resizeObserver = makeObserver('resize', () => measure(targets, 'observer'))
      resizeObserver.observe(targets.bodyElement)
      resizeObserver.observe(targets.chatColumn)
      resizeObserver.observe(targets.chatContent)
      return true
    }

    if (!attach()) {
      const retry = () => {
        if (!attach()) return
        mutationObserver?.disconnect()
        mutationObserver = null
        // Mutation records are microtasks and land before the frame requested alongside them, so
        // the pending frame is cancelled on a successful attach and the handle is cleared.
        if (releaseFrameOnRetrySuccess) {
          if (frame) cancelFrame(frame)
          frame = 0
        }
      }
      // The two wrappers are instrumentation around the SAME `retry` closure the source
      // registers with both, not two implementations: they only record which path fired.
      mutationObserver = makeObserver('mutation', () => {
        attachSource = 'mutation-retry'
        retry()
      })
      mutationObserver.observe(doc.body)
      frame = requestFrame(() => {
        attachSource = 'frame-retry'
        retry()
      })
    }

    cleanup = () => {
      if (frame) cancelFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      resizeObserver = null
      mutationObserver = null
    }
  }

  /** React's commit for this effect: on a dependency change, clean up and re-run. */
  const render = () => {
    const changed = committed === null
      || committed.mobile !== deps.mobile
      || committed.isFloating !== deps.isFloating
      || committed.dockWidth !== deps.dockWidth
      || committed.dockSide !== deps.dockSide
      || committed.dockElementVersion !== deps.dockElementVersion
      // `chatWidthMode` and `chatContentMaxWidth` are the two entries the fix ADDED to the
      // dependency list, and they are what makes a hydration flip recompute (Requirement 2.5).
      // The pre-fix variant omits them, so a flip changes the cascade but never the effect.
      || (variant !== 'pre-fix'
        && (committed.mode !== deps.mode || committed.customWidth !== deps.customWidth))
    if (!changed) return
    if (committed !== null) {
      // A dock drag, a dock resize, or a dock-side toggle is the ONLY way these two change.
      // Requirements 1.4 and 1.5 demand convergence without them, so any change is logged as
      // the interaction it would be.
      if (committed.dockWidth !== deps.dockWidth) interactionLog.push('dock-resize')
      if (committed.dockSide !== deps.dockSide) interactionLog.push('dock-side-toggle')
      if (committed.mobile !== deps.mobile) interactionLog.push('window-resize')
    }
    cleanup?.()
    cleanup = null
    // The audit runs while `currentRunId` is still the FINISHED run's id, so anything that run
    // created and its own cleanup did not release is attributed to it (Requirement 7.4).
    if (currentRunId > 0) auditRun(currentRunId)
    committed = deps
    runEffect(deps)
  }

  let flipIndex = 0

  return {
    cell,
    writes,
    get holds() { return holds },
    attachFailures,
    get attachSuccesses() { return attachSuccesses },
    get floatingZeroWrites() { return floatingZeroWrites },
    interactionLog,
    get effectRuns() { return effectRuns },
    get constructedObservers() { return constructedObservers },
    get disconnectedObservers() { return disconnectedObservers },
    get liveObservers() { return observers.filter((record) => record.live).length },
    get orphanedObservers() { return orphanedObservers },
    get requestedFrames() { return requestedFrames },
    get pendingFrames() { return frames.size },
    get bodyWidth() { return bodyWidth },
    get mode() { return deps.mode },
    get customWidth() { return deps.customWidth },
    get dockWidth() { return deps.dockWidth },
    get dockSide() { return deps.dockSide },
    get mobile() { return deps.mobile },
    get isFloating() { return deps.isFloating },
    get mounted() { return mounted },
    registrations,
    outlivedRegistrations,
    constructedByKind,
    disconnectedByKind,
    get framesDelivered() { return framesDelivered },
    get framesCancelled() { return framesCancelled },
    get unknownFrameCancels() { return unknownFrameCancels },
    attachSources,
    canonicalRect,
    geometryWrites,
    geometryWriteLog,

    mount() {
      mounted = true
      render()
    },

    step(kind) {
      switch (kind) {
        case 'commit-chat-body': {
          if (bodyCommitted) return
          bodyCommitted = true
          // The dock's host chain commits into the chat body: only now can `closest()` reach it.
          chatBody.appendChild(spindleMount)
          documentRoot.appendChild(chatBody)
          enqueue('mutation')
          return
        }
        case 'commit-chat-column': {
          if (columnCommitted) return
          columnCommitted = true
          chatBody.appendChild(chatColumn)
          enqueue('mutation')
          return
        }
        case 'commit-chat-content': {
          if (contentCommitted) return
          contentCommitted = true
          chatColumn.appendChild(chatContent)
          enqueue('mutation')
          return
        }
        case 'lay-out-body': {
          if (bodyWidth === options.finalBodyWidth) return
          bodyWidth = options.finalBodyWidth
          enqueue('resize')
          return
        }
        case 'flip-width-mode': {
          const flip = options.flips[flipIndex]
          flipIndex += 1
          if (!flip) return
          // Settings hydration replacing the pre-hydration default. Not an interaction.
          deps = { ...deps, mode: flip.mode, customWidth: flip.customWidth }
          publishConstrainedAttribute(flip.mode)
          render()
          // The published content width changed, so `Chat_Content`'s box changes with it. Any
          // live ResizeObserver is entitled to a delivery.
          enqueue('resize')
          return
        }
        case 'deliver-resize':
          flush('resize')
          return
        case 'deliver-mutation':
          flush('mutation')
          return
        case 'tick-frame':
          tickFrames()
          return
        default:
          return assertNever(kind)
      }
    },

    changeDependency(change) {
      switch (change.driver) {
        case 'chatContentMaxWidth':
          deps = { ...deps, customWidth: change.customWidth }
          break
        case 'chatWidthMode':
          deps = { ...deps, mode: change.mode }
          publishConstrainedAttribute(change.mode)
          break
        case 'dockElement': {
          // The bridge remounting the dock node: a NEW element in the same host chain, so
          // resolution still succeeds but React sees a different dependency value.
          const replacement = doc.createElement('aside')
          dockElement.remove()
          bridgeRoot.appendChild(replacement)
          dockElement = replacement
          deps = { ...deps, dockElementVersion: deps.dockElementVersion + 1 }
          enqueue('mutation')
          break
        }
        case 'isFloating':
          deps = { ...deps, isFloating: change.isFloating }
          break
        case 'mobile':
          deps = { ...deps, mobile: change.mobile }
          break
        case 'panel.rect.width':
          deps = { ...deps, dockWidth: change.dockWidth }
          break
        case 'settings.dockSide':
          deps = { ...deps, dockSide: change.dockSide }
          break
        default:
          return assertNever(change)
      }
      render()
    },

    settle() {
      // Everything below is work the browser performs on its own: queued mutation records,
      // queued resize observations, and the requested animation frame. No user input.
      for (let round = 0; round < 64; round += 1) {
        if (flush('mutation') > 0) continue
        if (frames.size > 0) {
          tickFrames()
          continue
        }
        if (flush('resize') > 0) continue
        return round
      }
      throw new Error('hydration schedule did not settle within 64 rounds')
    },

    unmount() {
      cleanup?.()
      cleanup = null
      if (currentRunId > 0) auditRun(currentRunId)
      mounted = false
      documentRoot.remove()
    },
  }
}

/** Fisher-Yates over a copy, so a schedule's step order is uniformly random and reproducible. */
function shuffle<T>(rng: Rng, values: readonly T[]): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(rng, 0, index)
    const held = result[index] as T
    result[index] = result[swap] as T
    result[swap] = held
  }
  return result
}

describe('portrait dock hydration convergence', () => {
  // Feature: portrait-dock-reload-anchoring, Property 6
  // For any schedule by which the measurement inputs become available — Chat_Body, Chat_Column,
  // or Chat_Content inserted at an arbitrary later time, the body's box becoming non-zero at an
  // arbitrary later time, or Chat_Width_Mode changing to any other value — the dock converges to
  // the Layout_Reclaim its current inputs determine, with no pointer, keyboard, resize, or
  // dock-control interaction.
  //
  // THIS IS THE TEST THAT WOULD HAVE CAUGHT THE REPORTED BUG.
  // Against the pre-fix effect, a schedule that commits the chat frame after the first layout
  // pass ends with the cell holding 0 and no observer registered, so the final assertion
  // `cell.value === measureReclaim(finalBodyWidth, finalMode, ...)` fails with a positive
  // expectation against a stranded zero — the captured runtime state exactly.
  //
  // SCOPE LIMITATION — read before treating a green run as evidence.
  // This property establishes that the reclaim NUMBER converges under any arrival order. It
  // says nothing about the rendered gap, which also depends on the cascade, the ui-scale zoom,
  // and the served bundle, and is established solely by the runtime verification step (task 8.3).
  // Validates: Requirements 1.4, 1.5, 2.5
  test('Feature: portrait-dock-reload-anchoring, Property 6 — convergence under any input-arrival schedule', () => {
    // The step space contains no user input at all. Asserted rather than assumed, so an added
    // step kind cannot quietly turn this into a "converges after the user does something" test.
    const stepKindNames: readonly string[] = SCHEDULE_STEP_KINDS
    for (const interaction of INTERACTION_STEP_KINDS) {
      expect(stepKindNames).not.toContain(interaction)
    }

    const observedSteps = new Set<ScheduleStepKind>()
    const observedInitialModes = new Set<ChatWidthMode>()
    const observedFinalModes = new Set<ChatWidthMode>()
    let observedFirstAttachFailed = 0
    let observedPartialFrame = 0
    let observedZeroWidthHold = 0
    let observedFullToCustomFlip = 0
    let observedFlipWhileUnready = 0
    let observedPositiveExpected = 0
    let observedZeroExpected = 0
    let observedConvergedFromWrongValue = 0
    let observedOrphanedObservers = 0
    let observedIterations = 0

    forAll(
      'Property 6',
      (rng) => {
        const finalBodyWidth = Math.max(PORTRAIT_DOCK_MIN_WIDTH, randomBodyWidth(rng))
        const dockWidth = randomDockWidth(rng, finalBodyWidth)
        // `full` is the settings-slice default, so it is what the first frames after a reload
        // see regardless of what the user persisted. That is the bug's pre-hydration state, so
        // it is drawn most of the time — but not always, because 2.5 covers any pair of modes.
        const initialMode: ChatWidthMode = rng() < 0.6 ? 'full' : randomChatWidthMode(rng)
        // Pre-hydration custom width: usually still the unset/zero value the default row holds.
        const initialCustomWidth = rng() < 0.5 ? 0 : randomValidCustomWidth(rng, finalBodyWidth)
        const flipCount = randomInt(rng, 1, 3)
        const flips: WidthModeFlip[] = Array.from({ length: flipCount }, (_unused, index) => {
          const last = index === flipCount - 1
          return {
            // The hydration flip from the bug report is `full` -> `custom`, so `custom` is the
            // most likely landing mode; the other three still appear.
            mode: last && rng() < 0.6 ? 'custom' : randomChatWidthMode(rng),
            customWidth: rng() < 0.8
              ? randomValidCustomWidth(rng, finalBodyWidth)
              : (pickOne(rng, INVALID_CUSTOM_WIDTHS) as number),
          }
        })

        // Required steps: every readiness input arrives exactly once, every drawn flip applies.
        // Their ORDER is what this property randomizes.
        const required: ScheduleStepKind[] = [
          'commit-chat-body',
          'commit-chat-column',
          'commit-chat-content',
          'lay-out-body',
          ...flips.map(() => 'flip-width-mode' as const),
        ]
        // Interleaved deliveries: observer callbacks and frames firing at arbitrary points,
        // including before anything is ready and between two readiness inputs.
        const deliveries: ScheduleStepKind[] = Array.from(
          { length: randomInt(rng, 1, 8) },
          () => pickOne(rng, DELIVERY_STEP_KINDS),
        )

        return {
          finalBodyWidth,
          dockWidth,
          initialMode,
          initialCustomWidth,
          flips,
          steps: shuffle(rng, [...required, ...deliveries]),
        }
      },
      ({ finalBodyWidth, dockWidth, initialMode, initialCustomWidth, flips, steps }) => {
        observedIterations += 1
        observedInitialModes.add(initialMode)

        const harness = createHydrationHarness({
          finalBodyWidth,
          dockWidth,
          initialMode,
          initialCustomWidth,
          flips,
        })

        // Mount happens with NOTHING ready: no chat frame in the tree and a zero body box. That
        // is the post-reload first layout pass the defect lived in.
        harness.mount()
        expect(harness.effectRuns).toBe(1)
        expect(harness.attachSuccesses).toBe(0)
        expect(harness.attachFailures.length).toBe(1)
        expect(harness.cell.value).toBe(0)
        observedFirstAttachFailed += 1

        let readyAtFlip = 0
        for (const kind of steps) {
          observedSteps.add(kind)
          if (kind === 'flip-width-mode' && harness.attachSuccesses === 0) readyAtFlip += 1
          harness.step(kind)
        }
        if (readyAtFlip > 0) observedFlipWhileUnready += 1

        // The browser finishing its own work: queued mutation records, queued resize
        // observations, the requested frame. Still no pointer, keyboard, resize, or dock control.
        harness.settle()

        const finalMode = harness.mode
        const finalCustomWidth = harness.customWidth
        observedFinalModes.add(finalMode)
        if (initialMode === 'full' && finalMode === 'custom') observedFullToCustomFlip += 1
        if (harness.holds > 0) observedZeroWidthHold += 1
        if (harness.attachFailures.some((snapshot) => snapshot.chatBody
          && !(snapshot.chatColumn && snapshot.chatContent))) {
          observedPartialFrame += 1
        }

        // THE CLAIM: the committed value is the one a fully-ready mount would have produced.
        const expected = measureReclaim(finalBodyWidth, finalMode, finalCustomWidth, dockWidth)
        if (expected > 0) observedPositiveExpected += 1
        else observedZeroExpected += 1

        expect(harness.bodyWidth).toBe(finalBodyWidth)
        expect(harness.cell.value).toBe(expected)

        // The bug's signature, asserted directly: a stranded zero while the real value is
        // positive, with nothing left that could recompute it.
        expect(harness.cell.value === 0 && expected > 0).toBe(false)

        // Convergence happened with ZERO user interaction, and the two inputs only an
        // interaction can move never moved.
        expect(harness.interactionLog).toEqual([])
        expect(harness.dockWidth).toBe(dockWidth)
        expect(harness.dockSide).toBe('left')
        // The docked dock never took the deliberate floating/mobile zero path.
        expect(harness.floatingZeroWrites).toBe(0)

        // No write was ever justified by an unready input: every committed value is exactly
        // what its own live inputs determine, and no write happened on a zero body box.
        for (const write of harness.writes) {
          expect(write.bodyWidth).toBeGreaterThan(0)
          expect(write.value).toBe(
            measureReclaim(write.bodyWidth, write.mode, write.customWidth, dockWidth),
          )
        }
        // At least one measurement committed, and convergence was reached by measurement rather
        // than by the cell happening to start on the right number.
        expect(harness.writes.length).toBeGreaterThan(0)
        if (harness.cell.changes > 0) observedConvergedFromWrongValue += 1

        // Teardown, kept LIGHT here on purpose: registration parity across mount, dependency
        // change, and unmount SEQUENCES is Property 11's claim (task 4.7). What is asserted here
        // is strict parity for this schedule, which is Requirement 7.4's actual claim.
        //
        // HISTORY, so the strictness below is not weakened back by a future reader.
        // This assertion used to allow `constructed - disconnected === orphanedObservers` with a
        // derived, non-zero right-hand side, because the effect did not cancel the animation
        // frame it requested alongside the MutationObserver. Mutation records are delivered as
        // microtasks and land BEFORE the frame, so the frame ran `retry` a second time, `attach()`
        // succeeded again, and the fresh `resizeObserver` assignment overwrote the binding
        // cleanup could see — one ResizeObserver constructed and never disconnected. Seed
        // 0x5eedc0de iteration 0 reproduced it: 4 constructed, 3 disconnected. The source now
        // guards `attach()` on an existing observer and cancels the pending frame on success, so
        // parity is exact and `orphanedObservers` is 0 for every schedule.
        harness.unmount()
        expect(harness.pendingFrames).toBe(0)
        expect(harness.orphanedObservers).toBe(0)
        expect(harness.constructedObservers).toBe(harness.disconnectedObservers)
        expect(harness.liveObservers).toBe(0)
        if (harness.orphanedObservers > 0) observedOrphanedObservers += 1
      },
    )

    // Input-space coverage. Without these the property could pass while never seeing a partially
    // committed frame, never holding on a zero box, or never reaching the exact hydration flip
    // from the bug report — any of which would make the convergence claim vacuous.
    expect([...observedSteps].sort()).toEqual([...SCHEDULE_STEP_KINDS].sort())
    expect(observedInitialModes.size).toBeGreaterThan(1)
    expect(observedFinalModes.size).toBeGreaterThan(1)
    // Every schedule mounted with NOTHING ready, which is the post-reload state the defect lived
    // in. Expressed against the observed iteration count so raising `iterations` to reproduce a
    // counterexample does not trip this.
    expect(observedIterations).toBeGreaterThanOrEqual(PROPERTY_ITERATIONS)
    expect(observedFirstAttachFailed).toBe(observedIterations)
    expect(observedPartialFrame).toBeGreaterThan(0)
    expect(observedZeroWidthHold).toBeGreaterThan(0)
    expect(observedFullToCustomFlip).toBeGreaterThan(0)
    expect(observedFlipWhileUnready).toBeGreaterThan(0)
    expect(observedPositiveExpected).toBeGreaterThan(0)
    expect(observedZeroExpected).toBeGreaterThan(0)
    expect(observedConvergedFromWrongValue).toBeGreaterThan(0)
    // No schedule reached the double-attach path at all, which is the whole point of the two
    // guards described in the teardown note above.
    expect(observedOrphanedObservers).toBe(0)
  })

  test('converges on the captured reload schedule from the bug report', () => {
    // The runtime state recorded in the design's Root cause section: a 1920 px body, a dock
    // 278 px wide, `--lumiverse-chat-content-width: 1400px` from a persisted `custom` mode, and
    // a settings row that reads `full` until hydration resolves. The captured dock had
    // `margin-right: 0px`; the correct value is 278.
    const harness = createHydrationHarness({
      finalBodyWidth: 1920,
      dockWidth: 278,
      initialMode: 'full',
      initialCustomWidth: 0,
      flips: [{ mode: 'custom', customWidth: 1400 }],
    })

    harness.mount()
    // First layout pass after reload: nothing resolvable, nothing written.
    expect(harness.cell.value).toBe(0)
    expect(harness.cell.changes).toBe(0)

    // The chat frame commits, then hydration flips the mode. No interaction anywhere.
    harness.step('commit-chat-body')
    harness.step('commit-chat-column')
    harness.step('commit-chat-content')
    harness.step('lay-out-body')
    harness.step('flip-width-mode')
    harness.settle()

    expect(getPortraitLayoutReclaim(1920, 1400, 278)).toBe(278)
    expect(harness.cell.value).toBe(278)
    expect(harness.interactionLog).toEqual([])

    harness.unmount()
    expect(harness.liveObservers).toBe(0)
    expect(harness.pendingFrames).toBe(0)
  })

  test('negative control — the same schedule strands the pre-fix effect', () => {
    // WHY THIS TEST EXISTS.
    // Property 6 claims to be the test that would have caught the reported bug. That claim is
    // only worth anything if the property can FAIL against the defect, so the defective effect
    // shape is transcribed too (see `runDefectiveEffect`) and driven through the SAME schedule
    // the captured-reload test above drives through the fixed shape. If a future refactor makes
    // the property vacuous, this control starts passing the convergence assertion and fails here.
    const defective = createHydrationHarness({
      finalBodyWidth: 1920,
      dockWidth: 278,
      initialMode: 'full',
      initialCustomWidth: 0,
      flips: [{ mode: 'custom', customWidth: 1400 }],
      variant: 'pre-fix',
    })

    defective.mount()
    defective.step('commit-chat-body')
    defective.step('commit-chat-column')
    defective.step('commit-chat-content')
    defective.step('lay-out-body')
    defective.step('flip-width-mode')
    defective.settle()

    const expected = measureReclaim(1920, 'custom', 1400, 278)
    expect(expected).toBe(278)

    // The captured runtime state: reclaim 0 while the correct value is 278, reached with no
    // interaction and with nothing left that could recompute it.
    expect(defective.cell.value).toBe(0)
    expect(defective.cell.value).not.toBe(expected)
    expect(defective.interactionLog).toEqual([])
    // The stranding mechanism, asserted rather than described: the pre-hydration `full` mode
    // published no `data-chat-constrained`, so resolution failed and NO observer was registered.
    expect(defective.attachSuccesses).toBe(0)
    expect(defective.attachFailures.length).toBeGreaterThan(0)
    expect(defective.constructedObservers).toBe(0)
    expect(defective.effectRuns).toBe(1)

    defective.unmount()
  })

  test('pins the reclaim effect\'s scheduling shape', async () => {
    // The harness above is a TRANSCRIPTION of this effect. These assertions are what stop the
    // transcription from drifting away from the component it stands in for: if any of the
    // structure below changes, this test fails and the harness must be revisited.
    const component = await Bun.file(resolve(import.meta.dir, 'PortraitDock.tsx')).text()
    const effectSource = component
      .match(/useLayoutEffect\(\(\) => \{\s*\/\/ The only deliberate zero[\s\S]*?\n {2}\]\)/)?.[0]
      ?? '<reclaim useLayoutEffect not found in PortraitDock.tsx>'

    expect(effectSource).toContain('useLayoutEffect')

    // 1. The ONLY zero-write in the whole component is the deliberate floating/mobile one.
    //    Every former bail-to-zero is gone, which is the fix.
    expect(component.match(/setLayoutReclaim\(0\)/g) ?? []).toHaveLength(1)
    expect(effectSource).toMatch(/if \(mobile \|\| isFloating\) \{\s*setLayoutReclaim\(0\)\s*return\s*\}/)

    // A component that currently renders no dock has no node whose ancestors can resolve.
    // Its ref change is already a dependency, so it must wait without observing the document.
    expect(effectSource).toContain('if (!dockElement) return')

    // 2. `measure` holds rather than writing when the body box is not laid out yet, and the
    //    hold precedes the write.
    expect(effectSource).toContain('toLayoutBox(targets.bodyElement.getBoundingClientRect()).width')
    expect(effectSource).toContain('if (!(bodyWidth > 0)) return')
    const holdIndex = effectSource.indexOf('if (!(bodyWidth > 0)) return')
    const writeIndex = effectSource.indexOf('setLayoutReclaim((current)')
    expect(holdIndex).toBeGreaterThanOrEqual(0)
    expect(writeIndex).toBeGreaterThan(holdIndex)
    expect(effectSource).toContain('resolveChatContentWidthForReclaim(chatWidthMode, chatContentMaxWidth, bodyWidth)')
    expect(effectSource).toContain('Math.round(getPortraitLayoutReclaim(bodyWidth, contentWidth, panel.rect.width))')
    expect(effectSource).toContain('setLayoutReclaim((current) => (current === next ? current : next))')

    // 3. `attach()` resolves all-or-nothing, measures, then registers ONE ResizeObserver over
    //    all three targets. Exactly two call sites reach the single `measure` closure — the
    //    direct call and the observer callback — which is the shape Property 2 relies on too.
    expect(effectSource).toContain('const targets = resolvePortraitLayoutTargets(dockElement)')
    expect(effectSource).toContain('if (!targets) return false')
    // A successful attach is idempotent: the guard precedes resolution, so a re-entered `attach()`
    // cannot construct a second ResizeObserver over the one binding cleanup can see (7.4).
    expect(effectSource).toContain('if (resizeObserver) return true')
    const attachIndex = effectSource.indexOf('const attach = (): boolean => {')
    const attachGuardIndex = effectSource.indexOf('if (resizeObserver) return true')
    const resolveIndex = effectSource.indexOf('const targets = resolvePortraitLayoutTargets(dockElement)')
    expect(attachIndex).toBeGreaterThanOrEqual(0)
    expect(attachGuardIndex).toBeGreaterThan(attachIndex)
    expect(resolveIndex).toBeGreaterThan(attachGuardIndex)
    expect(effectSource).toContain('new ResizeObserver(() => measure(targets))')
    expect(effectSource).toContain('resizeObserver.observe(targets.bodyElement)')
    expect(effectSource).toContain('resizeObserver.observe(targets.chatColumn)')
    expect(effectSource).toContain('resizeObserver.observe(targets.chatContent)')
    expect(effectSource.match(/measure\(targets\)/g) ?? []).toHaveLength(2)

    // 4. The attach-failure branch is the retry path Requirement 1.5 needs: a MutationObserver
    //    on the owner document's body plus one animation frame, disconnecting on success.
    expect(effectSource).toContain('if (!attach()) {')
    expect(effectSource).toContain('const ownerDocument = dockElement.ownerDocument')
    expect(effectSource).toContain('new MutationObserver(retry)')
    expect(effectSource).toContain('mutationObserver.observe(ownerDocument.body, { childList: true, subtree: true })')
    expect(effectSource).toContain('frame = requestAnimationFrame(retry)')
    expect(effectSource).toMatch(/const retry = \(\) => \{\s*if \(!attach\(\)\) return\s*mutationObserver\?\.disconnect\(\)/)

    // 5. A successful retry also RELEASES the frame it was requested alongside. Mutation records
    //    are microtasks, so they land before the frame; an uncancelled frame re-enters `retry`
    //    after the attach already succeeded. `frame = 0` keeps the cleanup guard honest.
    //    Two `cancelAnimationFrame(frame)` sites: this one and the cleanup one below.
    expect(effectSource.match(/cancelAnimationFrame\(frame\)/g) ?? []).toHaveLength(2)
    expect(effectSource).toContain('frame = 0')
    const retryIndex = effectSource.indexOf('const retry = () => {')
    const retryCancelIndex = effectSource.indexOf('if (frame) cancelAnimationFrame(frame)', retryIndex)
    const retryFrameResetIndex = effectSource.indexOf('frame = 0', retryCancelIndex)
    expect(retryIndex).toBeGreaterThanOrEqual(0)
    expect(retryCancelIndex).toBeGreaterThan(retryIndex)
    expect(retryFrameResetIndex).toBeGreaterThan(retryCancelIndex)

    // 6. Cleanup is unconditional and covers every registration, including a late attach.
    const cleanupIndex = effectSource.indexOf('return () => {')
    expect(cleanupIndex).toBeGreaterThan(retryFrameResetIndex)
    expect(effectSource.indexOf('if (frame) cancelAnimationFrame(frame)', cleanupIndex))
      .toBeGreaterThan(cleanupIndex)
    expect(effectSource).toContain('resizeObserver?.disconnect()')
    expect(effectSource).toContain('mutationObserver?.disconnect()')

    // 7. The dependency list is what makes a `full` -> `custom` hydration flip recompute without
    //    a reload (Requirement 2.5). Without these two entries the effect never re-runs.
    const dependencyList = effectSource.match(/\}, \[([\s\S]*)\]\)$/)?.[1] ?? '<dependency list not found>'
    for (const dependency of [
      'chatContentMaxWidth',
      'chatWidthMode',
      'dockElement',
      'isFloating',
      'mobile',
      'panel.rect.width',
      'settings.dockSide',
    ]) {
      expect(dependencyList).toContain(dependency)
    }
    // The dependency list is EXACTLY those seven. Property 11 enumerates the same seven as
    // teardown drivers through `DependencyDriver`, so an eighth entry appearing here without a
    // matching driver would leave one cleanup path untested.
    expect(dependencyList.split(',').map((entry) => entry.trim()).filter(Boolean)).toHaveLength(7)

    // 8. Registration inventory (Requirement 7.4, Property 11). The harness accounts for exactly
    //    three registration kinds and one instance of each per run, so the effect must not grow a
    //    fourth kind or a second instance of one of these without the ledger being extended.
    expect(effectSource.match(/new ResizeObserver\(/g) ?? []).toHaveLength(1)
    expect(effectSource.match(/new MutationObserver\(/g) ?? []).toHaveLength(1)
    expect(effectSource.match(/requestAnimationFrame\(/g) ?? []).toHaveLength(1)
    // Requirement 7.4 names timers too. The design states none are introduced; this is where
    // that stays true, because a timer would be a registration with no release path here.
    expect(effectSource).not.toContain('setTimeout')
    expect(effectSource).not.toContain('setInterval')

    //    The floating/mobile and missing-dock early returns precede every registration site, so
    //    those runs register NOTHING at all. A ref commit re-runs the latter through the existing
    //    `dockElement` dependency.
    const earlyReturnIndex = effectSource.search(/if \(mobile \|\| isFloating\) \{/)
    const missingDockReturnIndex = effectSource.indexOf('if (!dockElement) return')
    expect(earlyReturnIndex).toBeGreaterThanOrEqual(0)
    expect(missingDockReturnIndex).toBeGreaterThan(earlyReturnIndex)
    for (const registrationSite of ['new ResizeObserver(', 'new MutationObserver(', 'requestAnimationFrame(']) {
      expect(effectSource.indexOf(registrationSite)).toBeGreaterThan(earlyReturnIndex)
      expect(effectSource.indexOf(registrationSite)).toBeGreaterThan(missingDockReturnIndex)
    }

    //    One cleanup closure for the whole effect, and it nulls both observer bindings, so no
    //    registration from a finished run stays reachable by a later delivery.
    expect(effectSource.match(/return \(\) => \{/g) ?? []).toHaveLength(1)
    const teardownIndex = effectSource.indexOf('return () => {')
    expect(effectSource.indexOf('resizeObserver = null', teardownIndex)).toBeGreaterThan(teardownIndex)
    expect(effectSource.indexOf('mutationObserver = null', teardownIndex)).toBeGreaterThan(teardownIndex)
  })
})

// ---------------------------------------------------------------------------
// Property 11 support — registration parity across SEQUENCES of runs
//
// WHAT THIS PROPERTY ADDS THAT PROPERTY 6 DOES NOT.
// Property 6 ends with a teardown check, but it checks ONE mount's schedule: a single effect run
// (plus whatever the width-mode flips add), settled, then unmounted. Requirement 7.4 is a claim
// about every registration in every run — "through the effect cleanup path THAT CREATED IT" —
// and a single-run tally cannot distinguish that from "released eventually, by somebody". So
// this property randomizes SEQUENCES instead of schedules:
//
//  * a mount, then one to five dependency changes, then an unmount, in a randomized order of
//    browser work around them;
//  * changes driven by each of the SEVEN dependency-list entries, including flips into and out
//    of the `mobile || isFloating` early return, which registers nothing at all and must
//    therefore leave the counters untouched while still releasing whatever the previous run
//    registered;
//  * all three LATE-ATTACH cases — a run torn down before any retry delivery, one torn down
//    after the MutationObserver retry attached, and one torn down after the rAF retry attached;
//  * unmounts that happen while a frame is still queued, so "every frame is delivered or
//    cancelled" is a live claim rather than a vacuous one.
//
// The ledger the harness keeps is per-run, so a leak is attributed to the run that leaked it.
// A global constructed-equals-disconnected tally would also pass if run 1's observer happened to
// be disconnected by run 4's cleanup — three runs' worth of leak with a clean final total.
// ---------------------------------------------------------------------------

/**
 * Compile-time coverage guard over the effect's dependency list. `Record<DependencyDriver, true>`
 * cannot be satisfied with an entry missing, so adding an eighth dependency to the effect and
 * its `DependencyDriver` union fails typecheck here instead of silently narrowing this property's
 * input space. The source-shape test pins the same seven strings against `PortraitDock.tsx`.
 */
const DEPENDENCY_DRIVER_COVERAGE = {
  chatContentMaxWidth: true,
  chatWidthMode: true,
  dockElement: true,
  isFloating: true,
  mobile: true,
  'panel.rect.width': true,
  'settings.dockSide': true,
} as const satisfies Record<DependencyDriver, true>

const DEPENDENCY_DRIVERS = Object.keys(DEPENDENCY_DRIVER_COVERAGE) as DependencyDriver[]

const DOCK_SIDES = ['left', 'right', 'floating'] as const

/** Which call path had attached — or had not yet attached — when a run was torn down. */
type LateAttachCase = 'cleanup-before-retry' | 'attached-by-mutation-retry' | 'attached-by-frame-retry'

const LATE_ATTACH_CASE_COVERAGE = {
  'cleanup-before-retry': true,
  'attached-by-mutation-retry': true,
  'attached-by-frame-retry': true,
} as const satisfies Record<LateAttachCase, true>

const LATE_ATTACH_CASES = Object.keys(LATE_ATTACH_CASE_COVERAGE) as LateAttachCase[]

/** When the final unmount happens relative to the browser work still outstanding. */
type UnmountTiming = 'after-settle' | 'immediate' | 'unready-with-pending-frame'

const UNMOUNT_TIMING_COVERAGE = {
  'after-settle': true,
  immediate: true,
  'unready-with-pending-frame': true,
} as const satisfies Record<UnmountTiming, true>

const UNMOUNT_TIMINGS = Object.keys(UNMOUNT_TIMING_COVERAGE) as UnmountTiming[]

/**
 * The scenario table is ROTATED rather than sampled, so every late-attach case and every unmount
 * timing is reached deterministically instead of probably. `unready-with-pending-frame` is paired
 * only with `cleanup-before-retry` because they are the same precondition: a run that never
 * attached is the only run that still has a frame queued.
 */
const PROPERTY_11_SCENARIOS = [
  { lateAttach: 'cleanup-before-retry', unmount: 'unready-with-pending-frame' },
  { lateAttach: 'attached-by-mutation-retry', unmount: 'after-settle' },
  { lateAttach: 'attached-by-frame-retry', unmount: 'after-settle' },
  { lateAttach: 'cleanup-before-retry', unmount: 'after-settle' },
  { lateAttach: 'attached-by-mutation-retry', unmount: 'immediate' },
  { lateAttach: 'attached-by-frame-retry', unmount: 'immediate' },
] as const satisfies readonly { lateAttach: LateAttachCase, unmount: UnmountTiming }[]

/** The readiness inputs, applied in commit order. `flip-width-mode` is not used by this property:
 * width-mode changes go through `changeDependency` so they commit a real cleanup-and-re-run. */
const READINESS_STEP_KINDS = [
  'commit-chat-body',
  'commit-chat-column',
  'commit-chat-content',
  'lay-out-body',
] as const satisfies readonly ScheduleStepKind[]

/** Deliveries that cannot consume a queued frame, for the unmount-with-pending-frame scenario. */
const NON_TICK_DELIVERY_KINDS = ['deliver-resize', 'deliver-mutation'] as const satisfies readonly ScheduleStepKind[]

/** One dependency change, drawn as raw numbers and resolved against the harness's live state. */
interface DependencyChangeDraw {
  driver: DependencyDriver
  modeIndex: number
  sideIndex: number
  widthDelta: number
  dockWidth: number
}

/**
 * Turns a draw into a change that is GUARANTEED to differ from the harness's current value, so
 * every change commits exactly one cleanup-and-re-run. A no-op change would silently reduce the
 * sequence length and weaken the property.
 */
function resolveDependencyChange(harness: HydrationHarness, draw: DependencyChangeDraw): DependencyChange {
  switch (draw.driver) {
    case 'chatContentMaxWidth':
      return { driver: 'chatContentMaxWidth', customWidth: harness.customWidth + draw.widthDelta }
    case 'chatWidthMode': {
      const candidates = CHAT_WIDTH_MODES.filter((mode) => mode !== harness.mode)
      return { driver: 'chatWidthMode', mode: candidates[draw.modeIndex % candidates.length] as ChatWidthMode }
    }
    case 'dockElement':
      return { driver: 'dockElement' }
    case 'isFloating':
      return { driver: 'isFloating', isFloating: !harness.isFloating }
    case 'mobile':
      return { driver: 'mobile', mobile: !harness.mobile }
    case 'panel.rect.width':
      return {
        driver: 'panel.rect.width',
        dockWidth: draw.dockWidth === harness.dockWidth ? draw.dockWidth + 1 : draw.dockWidth,
      }
    case 'settings.dockSide': {
      const candidates = DOCK_SIDES.filter((side) => side !== harness.dockSide)
      return { driver: 'settings.dockSide', dockSide: candidates[draw.sideIndex % candidates.length] as 'left' | 'right' | 'floating' }
    }
    default:
      return assertNever(draw.driver)
  }
}

/**
 * The per-run half of Requirement 7.4, assertable at ANY point in a sequence: every registration
 * belonging to a run that has already ended is released, and it was released while its own run
 * was the current one. The run that is still live may legitimately hold registrations, which is
 * why the current run is exempt until `includeCurrentRun` is set after unmount.
 */
function expectClosedRunsReleased(harness: HydrationHarness, includeCurrentRun = false): void {
  for (const registration of harness.registrations) {
    if (!includeCurrentRun && harness.mounted && registration.runId === harness.effectRuns) continue
    expect(registration.release).not.toBeNull()
    expect(registration.releasedByRunId).toBe(registration.runId)
  }
  expect(harness.outlivedRegistrations).toEqual([])
}

describe('portrait dock registration teardown parity', () => {
  // Feature: portrait-dock-reload-anchoring, Property 11
  // For any sequence of mounts, dependency changes, and unmounts of the docked dock, the number
  // of ResizeObserver and MutationObserver instances disconnected equals the number constructed,
  // and every requested animation frame is either delivered or cancelled.
  //
  // SCOPE LIMITATION — read before treating a green run as evidence.
  // This property is about the effect's REGISTRATION BOOKKEEPING, driven through the transcribed
  // harness the note above Property 6 describes and pinned to the component by the source-shape
  // test. It says nothing about whether the browser's real ResizeObserver delivers when this
  // harness says it would, and nothing about rendered geometry.
  // Validates: Requirements 7.4
  test('Feature: portrait-dock-reload-anchoring, Property 11 — every registration is released by its creating cleanup', () => {
    // The seven the effect actually depends on. A change to any one of them is a teardown path.
    expect(DEPENDENCY_DRIVERS).toHaveLength(7)

    const observedDrivers = new Set<DependencyDriver>()
    const observedLateAttach = new Set<LateAttachCase>()
    const observedUnmountTimings = new Set<UnmountTiming>()
    let observedUnmountWithPendingFrame = 0
    let observedFloatingRuns = 0
    let observedMobileRuns = 0
    let observedEarlyReturnRuns = 0
    let observedCancelAfterDelivery = 0
    let observedRedundantDisconnects = 0
    let observedCleanupCancelledPendingRetry = 0
    let observedIterations = 0
    let maxEffectRuns = 0
    let drawIndex = 0

    forAll(
      'Property 11',
      (rng) => {
        // Rotated, not sampled: coverage of the scenario table and of the seven drivers is
        // deterministic, so a green run cannot be green because a dimension was never reached.
        const scenario = PROPERTY_11_SCENARIOS[drawIndex % PROPERTY_11_SCENARIOS.length] as typeof PROPERTY_11_SCENARIOS[number]
        const primaryDriver = DEPENDENCY_DRIVERS[drawIndex % DEPENDENCY_DRIVERS.length] as DependencyDriver
        drawIndex += 1

        const finalBodyWidth = Math.max(PORTRAIT_DOCK_MIN_WIDTH, randomBodyWidth(rng))
        const dockWidth = randomDockWidth(rng, finalBodyWidth)
        const changeCount = randomInt(rng, 1, 5)
        const changes: DependencyChangeDraw[] = Array.from({ length: changeCount }, (_unused, index) => ({
          // The first change is the rotated driver, so every entry of the dependency list is the
          // one that closes run 1 in some iteration. The rest are free.
          driver: index === 0 ? primaryDriver : pickOne(rng, DEPENDENCY_DRIVERS),
          modeIndex: randomInt(rng, 0, 2),
          sideIndex: randomInt(rng, 0, 1),
          widthDelta: randomInt(rng, 1, 500),
          dockWidth: randomDockWidth(rng, finalBodyWidth),
        }))
        const tailKinds: readonly ScheduleStepKind[] = scenario.unmount === 'unready-with-pending-frame'
          ? NON_TICK_DELIVERY_KINDS
          : DELIVERY_STEP_KINDS
        const tail = Array.from({ length: randomInt(rng, 0, 4) }, () => pickOne(rng, tailKinds))

        return {
          scenario,
          finalBodyWidth,
          dockWidth,
          initialMode: randomChatWidthMode(rng),
          initialCustomWidth: randomValidCustomWidth(rng, finalBodyWidth),
          changes,
          tail,
        }
      },
      ({ scenario, finalBodyWidth, dockWidth, initialMode, initialCustomWidth, changes, tail }) => {
        observedIterations += 1
        observedLateAttach.add(scenario.lateAttach)
        observedUnmountTimings.add(scenario.unmount)

        const harness = createHydrationHarness({
          finalBodyWidth,
          dockWidth,
          initialMode,
          initialCustomWidth,
          flips: [],
        })

        // Run 1 mounts with nothing ready, which is the only state that registers the retry pair
        // and therefore the only state in which the late-attach teardown cases exist.
        harness.mount()
        expect(harness.effectRuns).toBe(1)
        expect(harness.attachSources).toEqual([])
        expect(harness.constructedByKind.mutation).toBe(1)
        expect(harness.constructedByKind.resize).toBe(0)
        expect(harness.requestedFrames).toBe(1)
        expect(harness.pendingFrames).toBe(1)

        // --- Shape run 1 into one of the three late-attach cases -----------
        const readiness: readonly ScheduleStepKind[] = scenario.unmount === 'unready-with-pending-frame'
          ? []
          : READINESS_STEP_KINDS
        for (const kind of readiness) harness.step(kind)

        const lateAttach: LateAttachCase = scenario.lateAttach
        switch (lateAttach) {
          case 'cleanup-before-retry':
            // (a) Neither retry has been delivered, so run 1's own cleanup is what has to release
            //     BOTH the MutationObserver and the queued frame.
            expect(harness.attachSources).toEqual([])
            expect(harness.constructedByKind.resize).toBe(0)
            expect(harness.pendingFrames).toBe(1)
            break
          case 'attached-by-mutation-retry':
            // (b) The MutationObserver retry attached. Mutation records are microtasks, so this
            //     is the ordering that produced Property 6's counterexample.
            harness.step('deliver-mutation')
            expect(harness.attachSources).toEqual(['mutation-retry'])
            expect(harness.constructedByKind.resize).toBe(1)
            // The retry released the frame it was requested alongside.
            expect(harness.framesCancelled).toBe(1)
            expect(harness.pendingFrames).toBe(0)
            break
          case 'attached-by-frame-retry':
            // (c) The rAF retry attached first. The frame is DELIVERED here, not cancelled, and
            //     the retry's `cancelAnimationFrame` on the spent handle is the browser's no-op.
            harness.step('tick-frame')
            expect(harness.attachSources).toEqual(['frame-retry'])
            expect(harness.constructedByKind.resize).toBe(1)
            expect(harness.framesDelivered).toBe(1)
            expect(harness.pendingFrames).toBe(0)
            break
          default:
            assertNever(lateAttach)
        }
        expectClosedRunsReleased(harness)

        // --- The sequence: one dependency change per entry drawn -----------
        for (const draw of changes) {
          const runsBefore = harness.effectRuns
          const constructedBefore = harness.constructedObservers
          const framesRequestedBefore = harness.requestedFrames
          const framesCancelledBefore = harness.framesCancelled
          const pendingBefore = harness.pendingFrames
          const earlyReturnsBefore = harness.floatingZeroWrites

          const change = resolveDependencyChange(harness, draw)
          observedDrivers.add(change.driver)
          harness.changeDependency(change)

          // Every draw moves a real value, so React committed exactly one cleanup and one re-run.
          expect(harness.effectRuns).toBe(runsBefore + 1)
          // Requirement 7.4, per run: the run that just ended released everything it created,
          // and it did so through its OWN cleanup.
          expectClosedRunsReleased(harness)

          // A run torn down with a frame still queued must have had that frame cancelled by its
          // cleanup — never left to fire against a dead closure.
          if (pendingBefore > 0) {
            expect(harness.framesCancelled).toBeGreaterThanOrEqual(framesCancelledBefore + 1)
            observedCleanupCancelledPendingRetry += 1
          }

          if (harness.mobile || harness.isFloating) {
            // The deliberate early return: it writes the zero and registers NOTHING, so no
            // counter may move — while the previous run's registrations are still released,
            // which the per-run assertion above has already confirmed.
            expect(harness.constructedObservers).toBe(constructedBefore)
            expect(harness.requestedFrames).toBe(framesRequestedBefore)
            expect(harness.pendingFrames).toBe(0)
            expect(harness.floatingZeroWrites).toBe(earlyReturnsBefore + 1)
            observedEarlyReturnRuns += 1
            if (harness.isFloating) observedFloatingRuns += 1
            if (harness.mobile) observedMobileRuns += 1
          }
        }

        // --- Trailing browser work, then the unmount ------------------------
        for (const kind of tail) harness.step(kind)
        expectClosedRunsReleased(harness)

        if (scenario.unmount === 'after-settle') harness.settle()

        const pendingAtUnmount = harness.pendingFrames
        if (pendingAtUnmount > 0) observedUnmountWithPendingFrame += 1
        if (scenario.unmount === 'after-settle') expect(pendingAtUnmount).toBe(0)
        if (scenario.unmount === 'unready-with-pending-frame' && !(harness.mobile || harness.isFloating)) {
          // The last run never attached, so its retry frame is still queued. This is what makes
          // "every frame is delivered or cancelled" a live claim at this unmount.
          expect(pendingAtUnmount).toBeGreaterThan(0)
        }

        harness.unmount()
        maxEffectRuns = Math.max(maxEffectRuns, harness.effectRuns)

        // --- THE CLAIM -----------------------------------------------------
        expect(harness.constructedObservers).toBe(harness.disconnectedObservers)
        expect(harness.constructedByKind.resize).toBe(harness.disconnectedByKind.resize)
        expect(harness.constructedByKind.mutation).toBe(harness.disconnectedByKind.mutation)
        expect(harness.liveObservers).toBe(0)
        expect(harness.orphanedObservers).toBe(0)
        expect(harness.pendingFrames).toBe(0)
        // A cancel of a handle nobody requested would mean the `if (frame)` guard let a 0 through.
        expect(harness.unknownFrameCancels).toBe(0)
        // Every requested frame reached exactly one disposition: delivered or cancelled.
        expect(harness.framesDelivered + harness.framesCancelled).toBe(harness.requestedFrames)
        // Nothing outlived the run that created it, at any point in the sequence.
        expect(harness.outlivedRegistrations).toEqual([])
        expectClosedRunsReleased(harness, true)

        let frameRegistrations = 0
        for (const registration of harness.registrations) {
          expect(registration.release).not.toBeNull()
          // "Through the effect cleanup path THAT CREATED IT": released while its own run was
          // current, never by a later run's cleanup and never by the unmount of a different run.
          expect(registration.releasedByRunId).toBe(registration.runId)

          if (registration.kind === 'animation-frame') {
            frameRegistrations += 1
            expect(['delivered', 'cancelled']).toContain(registration.release)
            const redundantCancels = registration.redundantReleases.filter((release) => release === 'cancelled')
            if (registration.release === 'cancelled') {
              // NEVER BOTH: a cancelled frame was never also delivered, and never cancelled a
              // second time — `frame = 0` on the retry path is what keeps that true.
              expect(registration.redundantReleases).toEqual([])
            } else {
              // A cancel AFTER delivery is the browser's documented no-op and belongs to the
              // rAF-retry path. At most one, and it did not change the disposition.
              expect(redundantCancels).toHaveLength(registration.redundantReleases.length)
              expect(redundantCancels.length).toBeLessThanOrEqual(1)
              if (redundantCancels.length === 1) observedCancelAfterDelivery += 1
            }
            continue
          }

          expect(registration.release).toBe('disconnect')
          expect(registration.redundantReleases.every((release) => release === 'disconnect')).toBe(true)
          if (registration.redundantReleases.length > 0) observedRedundantDisconnects += 1
        }
        expect(frameRegistrations).toBe(harness.requestedFrames)
      },
    )

    // Input-space coverage. Without these the property could pass while never tearing down a
    // late attach, never touching four of the seven dependencies, or never unmounting with a
    // frame still queued — any of which would make the parity claim vacuous.
    expect(observedIterations).toBeGreaterThanOrEqual(PROPERTY_ITERATIONS)
    expect([...observedDrivers].sort()).toEqual([...DEPENDENCY_DRIVERS].sort())
    expect([...observedLateAttach].sort()).toEqual([...LATE_ATTACH_CASES].sort())
    expect([...observedUnmountTimings].sort()).toEqual([...UNMOUNT_TIMINGS].sort())
    expect(observedUnmountWithPendingFrame).toBeGreaterThan(0)
    expect(observedCleanupCancelledPendingRetry).toBeGreaterThan(0)
    expect(observedEarlyReturnRuns).toBeGreaterThan(0)
    expect(observedFloatingRuns).toBeGreaterThan(0)
    expect(observedMobileRuns).toBeGreaterThan(0)
    expect(observedCancelAfterDelivery).toBeGreaterThan(0)
    // Sequences, not single mounts: at least one iteration ran the effect more than twice.
    expect(maxEffectRuns).toBeGreaterThan(2)
    // The design calls a double `disconnect()` a documented no-op, and it is — but the source
    // also nulls `mutationObserver` after the retry disconnects it, so cleanup never reaches a
    // second disconnect at all. Asserted rather than assumed, so removing the null-out shows up.
    expect(observedRedundantDisconnects).toBe(0)
  })

  test('negative control — a teardown without the two attach guards leaks a ResizeObserver', () => {
    // WHY THIS TEST EXISTS.
    // Property 11 is only evidence if it can FAIL against an implementation that leaks. The
    // `pre-fix` variant cannot serve as that control: its defect is that a failed resolution
    // registers NOTHING, so it has nothing to leak. The leaking shape is a different one — the
    // source as it stood before Property 6's counterexample forced two guards into it — so it is
    // transcribed as its own variant and driven through the schedule that exposes it.
    const options = {
      finalBodyWidth: 1920,
      dockWidth: 278,
      initialMode: 'custom' as ChatWidthMode,
      initialCustomWidth: 1400,
      flips: [],
    }
    const schedule = (harness: HydrationHarness) => {
      harness.mount()
      harness.step('commit-chat-body')
      harness.step('commit-chat-column')
      harness.step('commit-chat-content')
      harness.step('lay-out-body')
      // Mutation records are microtasks: the MutationObserver retry lands FIRST and attaches.
      harness.step('deliver-mutation')
      // The frame requested alongside it then runs. Without the guards it re-enters `attach()`.
      harness.step('tick-frame')
      harness.unmount()
    }

    const leaky = createHydrationHarness({ ...options, variant: 'leaky-teardown' })
    schedule(leaky)

    // The leak, in the exact terms Property 11 asserts above.
    expect(leaky.attachSources).toEqual(['mutation-retry', 'frame-retry'])
    expect(leaky.orphanedObservers).toBe(1)
    expect(leaky.constructedByKind.resize).toBe(2)
    expect(leaky.disconnectedByKind.resize).toBe(1)
    expect(leaky.constructedObservers).not.toBe(leaky.disconnectedObservers)
    expect(leaky.liveObservers).toBe(1)
    // And the leak is attributed to the run that created it, not to the end-of-sequence total.
    expect(leaky.outlivedRegistrations).toHaveLength(1)
    expect(leaky.outlivedRegistrations[0]?.kind).toBe('resize-observer')
    expect(leaky.outlivedRegistrations[0]?.runId).toBe(1)
    expect(leaky.outlivedRegistrations[0]?.release).toBeNull()

    // The identical schedule against the effect as it stands: exact parity, nothing left live,
    // and the frame released once by the retry rather than left for the frame to re-enter.
    const fixed = createHydrationHarness({ ...options, variant: 'fixed' })
    schedule(fixed)

    expect(fixed.attachSources).toEqual(['mutation-retry'])
    expect(fixed.orphanedObservers).toBe(0)
    expect(fixed.constructedByKind.resize).toBe(1)
    expect(fixed.constructedObservers).toBe(fixed.disconnectedObservers)
    expect(fixed.liveObservers).toBe(0)
    expect(fixed.outlivedRegistrations).toEqual([])
    expect(fixed.framesCancelled).toBe(1)
    expect(fixed.framesDelivered).toBe(0)
    expect(fixed.framesDelivered + fixed.framesCancelled).toBe(fixed.requestedFrames)
    expect(fixed.pendingFrames).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Property 9 support — geometry immutability under measurement
//
// WHAT THIS PROPERTY CLAIMS, AND WHERE EACH HALF OF IT IS ESTABLISHED.
// The design's "No-regression surface" makes one negative promise about this change: the reclaim
// is component-local `useState`, it never flows into `panel.setRect`, `updateFloatingAvatar`, or
// `setSetting`, and the change therefore adds NO write path. That promise has a runtime half and
// a source half, and neither alone is evidence:
//
//  * RUNTIME half — driven through the same `createHydrationHarness` transcription Properties 6
//    and 11 use, now carrying a `Canonical_Rect` and a ledger over the three geometry sinks. A
//    randomized measurement sequence (mount unready -> readiness inputs -> width-mode flips ->
//    observer deliveries -> settle -> dependency changes -> unmount) must end with all three
//    counters at zero and the four rect fields exactly where they started. Checked at EVERY
//    checkpoint, not just at the end, so a write that was later undone still fails.
//
//  * SOURCE half — a runtime harness cannot show that the COMPONENT has no write path; it can
//    only show that the transcribed one does not use the path it was given. Requirements 3.1 and
//    5.5 therefore live in `reclaim is component-local state with no geometry write path` below,
//    which pins `layoutReclaim`'s complete occurrence list in `PortraitDock.tsx`, the absence of
//    all three sinks from the reclaim effect body, `top: panel.rect.y` as the vertical mechanism,
//    and every `setSetting('portraitDockSettings', ...)` call site with the gate that guards it.
//
// WHY THE NEGATIVE CONTROL MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS FILE.
// "No writes happened" is the easiest assertion in testing to pass vacuously: a harness that
// never wired the sinks up at all would pass it, and so would one whose reclaim never moved. Both
// holes are closed explicitly — the `geometry-writing` variant proves the ledger and the
// field-by-field comparison DO catch a write (including one that mutates the rect in place), and
// the coverage counters prove the committed reclaim actually moved during the sequences.
//
// WHY THE DEPENDENCY CHANGES ARE RESTRICTED TO THREE OF THE SEVEN DRIVERS.
// Requirement 5.5 permits persistence in response to a user-initiated move, resize, fit,
// dock-side change, or reset. Four of the effect's seven dependency-list entries can only move
// BECAUSE of one of those actions — `panel.rect.width` is a drag or resize, `settings.dockSide`
// and `isFloating` are a dock-side change, `mobile` is a viewport resize — and the harness logs
// each as the interaction it is. Driving them here would mean asserting "no write" across inputs
// whose real-world cause is allowed to write. The three remaining drivers carry no interaction at
// all, so an empty `interactionLog` plus zero writes is exactly 5.5's contrapositive: nothing the
// user did, therefore nothing persisted. The partition is asserted below rather than assumed.
//
// SCOPE LIMITATION — read before treating a green run as evidence.
// This is a claim about the reclaim path's writes and the component's source shape. Requirement
// 3.2's "exactly equal to the values saved before the reload" is established across a REAL reload
// solely by the runtime verification step (task 8.4); what is established here is that the
// measurement path is not the thing that could move them. Requirement 3.4's fit-to-available
// gating is Property 10's subject (task 6.3) and is deliberately untouched here.
// ---------------------------------------------------------------------------

/** The four `Canonical_Rect` fields, compared one at a time and exactly. */
const CANONICAL_RECT_FIELDS = ['x', 'y', 'width', 'height'] as const satisfies readonly (keyof SurfaceRectPrefs)[]

/**
 * The rect shapes a persisted settings row can actually hold. Rotated rather than sampled, so the
 * default rect and every awkward non-default shape are reached deterministically.
 */
type CanonicalRectCategory =
  | 'untouched-default'
  | 'non-default-integer'
  | 'zero-origin'
  | 'negative-origin'
  | 'fractional'
  | 'far-offscreen'

const CANONICAL_RECT_CATEGORY_COVERAGE = {
  'untouched-default': true,
  'non-default-integer': true,
  'zero-origin': true,
  'negative-origin': true,
  fractional: true,
  'far-offscreen': true,
} as const satisfies Record<CanonicalRectCategory, true>

const CANONICAL_RECT_CATEGORIES = Object.keys(CANONICAL_RECT_CATEGORY_COVERAGE) as CanonicalRectCategory[]

function drawCanonicalRect(rng: Rng, category: CanonicalRectCategory): SurfaceRectPrefs {
  const width = randomInt(rng, PORTRAIT_DOCK_MIN_WIDTH, 720)
  const height = randomInt(rng, PORTRAIT_DOCK_MIN_WIDTH, 860)
  switch (category) {
    // The rectangle a never-touched install carries. Taken from the constant the component
    // compares against, so it cannot drift into "just another non-default rect".
    case 'untouched-default': return { ...DEFAULT_PORTRAIT_DOCK_SETTINGS.rect }
    case 'non-default-integer': return { x: randomInt(rng, 1, 1600), y: randomInt(rng, 1, 900), width, height }
    case 'zero-origin': return { x: 0, y: 0, width, height }
    // A dock dragged past the left or top edge before clamping. Negative coordinates must survive
    // a measurement sequence exactly as positive ones do.
    case 'negative-origin': return { x: -randomInt(rng, 1, 400), y: -randomInt(rng, 1, 400), width, height }
    // A row written by a drag handle rather than a stepper. `309.5` must come back as `309.5`,
    // not as `309` or `310`.
    case 'fractional': return {
      x: randomInt(rng, 0, 1600) + randomInt(rng, 1, 99) / 100,
      y: randomInt(rng, 0, 900) + randomInt(rng, 1, 99) / 100,
      width: width + randomInt(rng, 1, 99) / 100,
      height: height + randomInt(rng, 1, 99) / 100,
    }
    case 'far-offscreen': return { x: randomInt(rng, 5000, 20000), y: randomInt(rng, 5000, 20000), width, height }
    default: return assertNever(category)
  }
}

/**
 * Bookkeeping only — used to prove the generator reached BOTH the untouched default rect and
 * non-default rects. Deliberately not an assertion about the component: whether the component
 * gates fit-to-available on the default rect is Property 10's claim (task 6.3), and nothing here
 * touches `isDefaultPortraitRect` or `resolveDockedPortraitImageRect`.
 */
function rectEqualsUntouchedDefault(rect: SurfaceRectPrefs): boolean {
  const defaultRect = DEFAULT_PORTRAIT_DOCK_SETTINGS.rect
  return CANONICAL_RECT_FIELDS.every((field) => Object.is(rect[field], defaultRect[field]))
}

/**
 * The dependency-list entries that move WITHOUT any user action: settings hydration replacing the
 * width mode or the custom width, and the Spindle bridge remounting the dock node.
 */
const PROPERTY_9_NON_INTERACTION_DRIVERS = [
  'chatContentMaxWidth',
  'chatWidthMode',
  'dockElement',
] as const satisfies readonly DependencyDriver[]

/**
 * The complement: every entry whose only cause is one of the five actions Requirement 5.5 permits
 * to persist. Excluded from this property's sequences for exactly that reason, and asserted to be
 * the complement rather than merely listed.
 */
const PROPERTY_9_INTERACTION_DRIVERS = [
  'isFloating',
  'mobile',
  'panel.rect.width',
  'settings.dockSide',
] as const satisfies readonly DependencyDriver[]

/** Throws with the offending sink and run, so a counterexample names the write path. */
function expectNoGeometryWrites(harness: HydrationHarness, checkpoint: string): void {
  for (const kind of GEOMETRY_WRITE_KINDS) {
    if (harness.geometryWrites[kind] !== 0) {
      throw new Error(
        `geometry sink ${kind} was called ${harness.geometryWrites[kind]} time(s) by the reclaim `
        + `path at checkpoint "${checkpoint}"; log: ${JSON.stringify(harness.geometryWriteLog)}`,
      )
    }
  }
  if (harness.geometryWriteLog.length !== 0) {
    throw new Error(
      `geometry write log is non-empty at checkpoint "${checkpoint}": `
      + JSON.stringify(harness.geometryWriteLog),
    )
  }
}

/**
 * Field-by-field, with `Object.is`, against a SEPARATELY HELD copy of the original numbers. Not a
 * deep-equal against the object the harness carries: that object is the one a regression would
 * mutate in place, so comparing it with itself would prove nothing.
 */
function expectCanonicalRectUnchanged(
  harness: HydrationHarness,
  original: SurfaceRectPrefs,
  checkpoint: string,
): void {
  for (const field of CANONICAL_RECT_FIELDS) {
    const actual = harness.canonicalRect[field]
    const expected = original[field]
    if (!Object.is(actual, expected)) {
      throw new Error(
        `Canonical_Rect.${field} moved at checkpoint "${checkpoint}": expected `
        + `${String(expected)}, got ${String(actual)}`,
      )
    }
  }
}

/** Both halves of the runtime claim, asserted together at every checkpoint in the sequence. */
function expectGeometryHeld(
  harness: HydrationHarness,
  original: SurfaceRectPrefs,
  checkpoint: string,
): void {
  expectNoGeometryWrites(harness, checkpoint)
  expectCanonicalRectUnchanged(harness, original, checkpoint)
}

/**
 * Slices a named block out of the component source. Throws with the marker it could not find, so
 * a refactor that moves the code reports which pin broke rather than silently asserting against
 * an empty string.
 */
function extractSourceBlock(source: string, label: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`${label}: start marker not found in PortraitDock.tsx — ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  if (end < 0) throw new Error(`${label}: end marker not found after the start marker — ${endMarker}`)
  return source.slice(start, end + endMarker.length)
}

describe('portrait dock geometry immutability', () => {
  // Feature: portrait-dock-reload-anchoring, Property 9
  // For any sequence of reclaim measurements, the persisted Canonical_Rect values x, y, width,
  // and height are unchanged and no settings write is issued.
  // Validates: Requirements 3.1, 3.2, 5.5
  test('Feature: portrait-dock-reload-anchoring, Property 9 — reclaim never mutates or persists geometry', () => {
    // The driver partition this property depends on: the three it drives carry no interaction,
    // the four it excludes are exactly the ones Requirement 5.5 permits to persist. Asserted, so
    // an eighth dependency cannot land in neither list and quietly go untested.
    expect([...PROPERTY_9_NON_INTERACTION_DRIVERS, ...PROPERTY_9_INTERACTION_DRIVERS].sort())
      .toEqual([...DEPENDENCY_DRIVERS].sort())
    for (const driver of PROPERTY_9_NON_INTERACTION_DRIVERS) {
      expect(PROPERTY_9_INTERACTION_DRIVERS as readonly DependencyDriver[]).not.toContain(driver)
    }
    // Three sinks, so a future fourth write path has to be added to the ledger to be counted.
    expect(GEOMETRY_WRITE_KINDS).toHaveLength(3)

    const observedCategories = new Set<CanonicalRectCategory>()
    const observedSteps = new Set<ScheduleStepKind>()
    const observedDrivers = new Set<DependencyDriver>()
    let observedDefaultRects = 0
    let observedNonDefaultRects = 0
    let observedNegativeCoordinates = 0
    let observedFractionalFields = 0
    let observedZeroCoordinates = 0
    let observedReclaimMoved = 0
    let observedReclaimMovedTwice = 0
    let observedPositiveExpected = 0
    let observedZeroExpected = 0
    let observedUnmounts = 0
    let observedIterations = 0
    let observedCheckpoints = 0
    let totalGeometryWrites = 0
    let maxReclaimChanges = 0
    let drawIndex = 0

    forAll(
      'Property 9',
      (rng) => {
        // Rotated: every rect shape and every non-interaction driver is reached deterministically
        // rather than probably.
        const category = CANONICAL_RECT_CATEGORIES[drawIndex % CANONICAL_RECT_CATEGORIES.length] as CanonicalRectCategory
        const primaryDriver = PROPERTY_9_NON_INTERACTION_DRIVERS[
          drawIndex % PROPERTY_9_NON_INTERACTION_DRIVERS.length
        ] as DependencyDriver
        drawIndex += 1

        const finalBodyWidth = Math.max(PORTRAIT_DOCK_MIN_WIDTH, randomBodyWidth(rng))
        const dockWidth = randomDockWidth(rng, finalBodyWidth)
        const initialMode: ChatWidthMode = rng() < 0.6 ? 'full' : randomChatWidthMode(rng)
        const initialCustomWidth = rng() < 0.5 ? 0 : randomValidCustomWidth(rng, finalBodyWidth)
        const flipCount = randomInt(rng, 1, 3)
        const flips: WidthModeFlip[] = Array.from({ length: flipCount }, (_unused, index) => ({
          mode: index === flipCount - 1 && rng() < 0.6 ? 'custom' : randomChatWidthMode(rng),
          customWidth: randomValidCustomWidth(rng, finalBodyWidth),
        }))

        const required: ScheduleStepKind[] = [
          'commit-chat-body',
          'commit-chat-column',
          'commit-chat-content',
          'lay-out-body',
          ...flips.map(() => 'flip-width-mode' as const),
        ]
        const deliveries: ScheduleStepKind[] = Array.from(
          { length: randomInt(rng, 1, 6) },
          () => pickOne(rng, DELIVERY_STEP_KINDS),
        )

        const changeCount = randomInt(rng, 1, 4)
        const changes: DependencyChangeDraw[] = Array.from({ length: changeCount }, (_unused, index) => ({
          driver: index === 0 ? primaryDriver : pickOne(rng, PROPERTY_9_NON_INTERACTION_DRIVERS),
          modeIndex: randomInt(rng, 0, 2),
          sideIndex: randomInt(rng, 0, 1),
          widthDelta: randomInt(rng, 1, 500),
          dockWidth,
        }))

        return {
          category,
          rect: drawCanonicalRect(rng, category),
          finalBodyWidth,
          dockWidth,
          initialMode,
          initialCustomWidth,
          flips,
          steps: shuffle(rng, [...required, ...deliveries]),
          changes,
        }
      },
      ({ category, rect, finalBodyWidth, dockWidth, initialMode, initialCustomWidth, flips, steps, changes }) => {
        observedIterations += 1
        observedCategories.add(category)

        // THE SEPARATE COPY. Held as four primitives so no reference the harness can reach is
        // able to move the expectation along with the value.
        const original: SurfaceRectPrefs = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }

        if (rectEqualsUntouchedDefault(original)) observedDefaultRects += 1
        else observedNonDefaultRects += 1
        if (original.x < 0 || original.y < 0) observedNegativeCoordinates += 1
        if (Object.is(original.x, 0) && Object.is(original.y, 0)) observedZeroCoordinates += 1
        if (CANONICAL_RECT_FIELDS.some((field) => !Number.isInteger(original[field]))) observedFractionalFields += 1

        const harness = createHydrationHarness({
          finalBodyWidth,
          dockWidth,
          initialMode,
          initialCustomWidth,
          flips,
          canonicalRect: rect,
        })

        // The rect the harness carries is a DISTINCT object from both the drawn one and the
        // expectation, so the comparison below can never be self-equality.
        expect(harness.canonicalRect).not.toBe(original)
        expect(harness.canonicalRect).not.toBe(rect)

        const check = (checkpoint: string) => {
          expectGeometryHeld(harness, original, checkpoint)
          observedCheckpoints += 1
        }

        // Mount with nothing ready — the post-reload first layout pass.
        harness.mount()
        check('mount')

        // Readiness inputs, width-mode flips, and observer deliveries in a randomized order.
        for (const kind of steps) {
          observedSteps.add(kind)
          harness.step(kind)
          check(`step:${kind}`)
        }

        // The browser finishing its own work.
        harness.settle()
        check('settle')

        // Dependency changes: each one is a full cleanup-then-re-run, so the effect measures
        // again from scratch. None of them is a user action.
        const runsBeforeChanges = harness.effectRuns
        for (const draw of changes) {
          const change = resolveDependencyChange(harness, draw)
          observedDrivers.add(change.driver)
          harness.changeDependency(change)
          check(`dependency:${change.driver}`)
        }
        expect(harness.effectRuns).toBe(runsBeforeChanges + changes.length)

        harness.settle()
        check('settle-after-dependency-changes')

        // Every sequence ends in an unmount, so the cleanup path is part of the claim.
        harness.unmount()
        observedUnmounts += 1
        expect(harness.mounted).toBe(false)
        check('unmount')

        // --- The sequence really did measure, so the claim is not vacuous ---
        // A run that never measured could not have written geometry either. These assertions are
        // what make "no writes" a statement about a live measurement path.
        expect(harness.writes.length).toBeGreaterThan(0)
        const expected = measureReclaim(finalBodyWidth, harness.mode, harness.customWidth, dockWidth)
        expect(harness.cell.value).toBe(expected)
        if (expected > 0) observedPositiveExpected += 1
        else observedZeroExpected += 1

        // The committed reclaim MOVED during the sequence. Without this a green run could mean
        // "nothing happened", which says nothing about a write path.
        if (harness.cell.changes > 0) observedReclaimMoved += 1
        if (harness.cell.changes > 1) observedReclaimMovedTwice += 1
        maxReclaimChanges = Math.max(maxReclaimChanges, harness.cell.changes)

        // No user interaction anywhere in the sequence, so Requirement 5.5 permits no write at
        // all — which is what the zero counters above mean.
        expect(harness.interactionLog).toEqual([])
        expect(harness.dockWidth).toBe(dockWidth)
        expect(harness.dockSide).toBe('left')

        // The final tally, restated over the whole sequence rather than per checkpoint.
        for (const kind of GEOMETRY_WRITE_KINDS) {
          expect(harness.geometryWrites[kind]).toBe(0)
          totalGeometryWrites += harness.geometryWrites[kind]
        }
        expect(harness.geometryWriteLog).toEqual([])
      },
    )

    // Input-space coverage. Without these the property could pass while never drawing a
    // non-default rect, never moving the reclaim, or never running a dependency change — any of
    // which would make the immutability claim vacuous.
    expect(observedIterations).toBeGreaterThanOrEqual(PROPERTY_ITERATIONS)
    expect([...observedCategories].sort()).toEqual([...CANONICAL_RECT_CATEGORIES].sort())
    expect(observedDefaultRects).toBeGreaterThan(0)
    expect(observedNonDefaultRects).toBeGreaterThan(0)
    expect(observedNegativeCoordinates).toBeGreaterThan(0)
    expect(observedZeroCoordinates).toBeGreaterThan(0)
    expect(observedFractionalFields).toBeGreaterThan(0)
    expect([...observedSteps].sort()).toEqual([...SCHEDULE_STEP_KINDS].sort())
    expect([...observedDrivers].sort()).toEqual([...PROPERTY_9_NON_INTERACTION_DRIVERS].sort())
    expect(observedReclaimMoved).toBeGreaterThan(0)
    expect(observedReclaimMovedTwice).toBeGreaterThan(0)
    expect(maxReclaimChanges).toBeGreaterThan(1)
    expect(observedPositiveExpected).toBeGreaterThan(0)
    expect(observedZeroExpected).toBeGreaterThan(0)
    // Every sequence ended in an unmount, and every checkpoint held.
    expect(observedUnmounts).toBe(observedIterations)
    expect(observedCheckpoints).toBeGreaterThan(observedIterations * 5)
    expect(totalGeometryWrites).toBe(0)
  })

  test('negative control — a reclaim that writes geometry is caught at the first measurement', () => {
    // WHY THIS TEST EXISTS.
    // "Zero writes" and "the rect did not move" are the two easiest assertions in this file to
    // pass for the wrong reason. This drives the SAME schedule through a variant that adds the
    // one thing the design promises the change does not add — a write path from the measured
    // reclaim into geometry — and shows that both halves of Property 9 fail against it. The
    // control mutates the rect IN PLACE, so it also proves the field-by-field comparison against
    // a separately held copy is what catches it: a deep-equal against the harness's own object
    // would still have passed.
    const rect: SurfaceRectPrefs = { x: 411, y: 309, width: 278, height: 832 }
    const original: SurfaceRectPrefs = { ...rect }
    const options = {
      finalBodyWidth: 1920,
      dockWidth: 278,
      initialMode: 'custom' as ChatWidthMode,
      initialCustomWidth: 1400,
      flips: [],
      canonicalRect: rect,
    }
    const schedule = (harness: HydrationHarness) => {
      harness.mount()
      harness.step('commit-chat-body')
      harness.step('commit-chat-column')
      harness.step('commit-chat-content')
      harness.step('lay-out-body')
      harness.settle()
      harness.unmount()
    }

    const writing = createHydrationHarness({ ...options, variant: 'geometry-writing' })
    schedule(writing)

    // The reclaim the fixed effect commits and the control then persists.
    expect(writing.cell.value).toBe(278)

    // Every sink was called, so a ledger that only counted `setSetting` would still catch it —
    // and one that counted none of them would not.
    for (const kind of GEOMETRY_WRITE_KINDS) {
      expect(writing.geometryWrites[kind]).toBeGreaterThan(0)
    }
    expect(writing.geometryWriteLog.length).toBeGreaterThanOrEqual(3)
    expect([...new Set(writing.geometryWriteLog.map((entry) => entry.kind))].sort())
      .toEqual([...GEOMETRY_WRITE_KINDS].sort())

    // The rect moved, and it moved IN PLACE on the object the harness carries. The displacement
    // is derived from the number of writes the ledger recorded rather than assumed to be one:
    // this schedule measures once on attach and again on the ResizeObserver's first delivery, and
    // a regression that wrote on every measurement is exactly the shape being modelled.
    const persistedMeasurements = writing.geometryWriteLog
      .filter((entry) => entry.kind === 'panel.setRect').length
    expect(persistedMeasurements).toBe(writing.writes.length)
    expect(persistedMeasurements).toBeGreaterThan(0)
    expect(writing.canonicalRect.x).toBe(original.x - 278 * persistedMeasurements)
    expect(writing.canonicalRect.width).toBe(original.width + 278 * persistedMeasurements)
    // Untouched fields stay put, so the control is a targeted regression rather than noise.
    expect(writing.canonicalRect.y).toBe(original.y)
    expect(writing.canonicalRect.height).toBe(original.height)

    // Property 9's own assertions, shown to FAIL against this shape. If a future refactor made
    // either of them vacuous, these two expectations would stop throwing and fail here.
    expect(() => expectNoGeometryWrites(writing, 'negative-control')).toThrow(/geometry sink/)
    expect(() => expectCanonicalRectUnchanged(writing, original, 'negative-control'))
      .toThrow(/Canonical_Rect\.x moved/)

    // The identical schedule against the effect as it stands: the same reclaim, no writes, and a
    // rect still exactly where it started in all four fields.
    const held: SurfaceRectPrefs = { x: 411, y: 309, width: 278, height: 832 }
    const fixed = createHydrationHarness({ ...options, canonicalRect: held, variant: 'fixed' })
    schedule(fixed)

    expect(fixed.cell.value).toBe(278)
    expect(fixed.geometryWriteLog).toEqual([])
    for (const kind of GEOMETRY_WRITE_KINDS) expect(fixed.geometryWrites[kind]).toBe(0)
    expectCanonicalRectUnchanged(fixed, original, 'fixed')
    for (const field of CANONICAL_RECT_FIELDS) {
      expect(fixed.canonicalRect[field]).toBe(original[field])
    }
  })

  test('Feature: portrait-dock-reload-anchoring, Property 9 — reclaim is component-local state with no geometry write path', async () => {
    // The source half of Property 9. A runtime harness can only show that the transcription does
    // not use the write paths it was handed; that the COMPONENT has none is a claim about its
    // text, and Requirements 3.1 and 5.5 live here.
    const component = await Bun.file(resolve(import.meta.dir, 'PortraitDock.tsx')).text()

    // --- 1. `layoutReclaim` is component-local `useState` ------------------
    expect(component).toContain('const [layoutReclaim, setLayoutReclaim] = useState(0)')
    // No ref, no store selector, no persisted setting carries it.
    expect(component).not.toMatch(/useRef[^\n]*layoutReclaim/i)
    expect(component).not.toMatch(/useStore\([^\n]*layoutReclaim/i)

    // The COMPLETE occurrence list, as an exact whitelist rather than a blocklist: every line in
    // the component that mentions the reclaim, in order. A new line of any shape — a write into a
    // sink, a ref assignment, an extra style consumer — fails here even if nobody anticipated it.
    // Word-bounded on both spellings of the state pair, so the unrelated exported
    // `getPortraitLayoutReclaim` — which carries the same trailing characters — is not swept in.
    const reclaimLines = component
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\blayoutReclaim\b|\bsetLayoutReclaim\b/.test(line))
    expect(reclaimLines).toEqual([
      'const [layoutReclaim, setLayoutReclaim] = useState(0)',
      'setLayoutReclaim(0)',
      'setLayoutReclaim((current) => (current === next ? current : next))',
      '...resolveDockReclaimStyle(settings.dockSide, layoutReclaim),',
    ])

    // Stated again in the design's own vocabulary: the reclaim is never an argument to any of the
    // three geometry sinks.
    for (const sink of ['panel.setRect(', 'updateFloatingAvatar(', 'setSetting(']) {
      for (const line of reclaimLines) expect(line).not.toContain(sink)
    }
    expect(component).not.toMatch(/panel\.setRect\([^)]*layoutReclaim/)
    expect(component).not.toMatch(/updateFloatingAvatar\([^)]*layoutReclaim/)
    expect(component).not.toMatch(/setSetting\([^)]*layoutReclaim/)

    // --- 2. The reclaim effect body contains no geometry write -------------
    const effectSource = component
      .match(/useLayoutEffect\(\(\) => \{\s*\/\/ The only deliberate zero[\s\S]*?\n {2}\]\)/)?.[0]
      ?? '<reclaim useLayoutEffect not found in PortraitDock.tsx>'
    expect(effectSource).toContain('useLayoutEffect')
    expect(effectSource).toContain('setLayoutReclaim')
    for (const sink of ['setSetting', 'panel.setRect', 'updateFloatingAvatar']) {
      expect(effectSource).not.toContain(sink)
    }
    // It reads `panel.rect.width` and nothing else off the rect, and it never writes the rect.
    expect(effectSource).toContain('panel.rect.width')
    expect(effectSource).not.toMatch(/panel\.rect\s*=/)
    expect(effectSource).not.toMatch(/settings\.rect/)
    expect(effectSource).not.toContain('portraitDockSettings')

    // --- 3. Requirement 3.1: the vertical offset mechanism is unchanged ----
    // `dockStyle` applies the persisted `y` straight from the rect, immediately above the reclaim
    // style, in the docked branch. Requirement 3.1's mechanism, pinned where it lives.
    expect(component).toMatch(/top: panel\.rect\.y,\s*\.\.\.resolveDockReclaimStyle\(settings\.dockSide, layoutReclaim\),/)
    // Exactly two vertical-offset SITES in code — the docked branch and the floating/mobile one —
    // and no third. Comment lines are excluded rather than counted: the resolver's doc comment
    // quotes the same expression, and pinning prose would make this fail on a reworded comment.
    const verticalOffsetSites = component
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('top: panel.rect.y')
        && !line.startsWith('*')
        && !line.startsWith('//'))
    expect(verticalOffsetSites).toEqual([
      'top: panel.rect.y,',
      '? { left: panel.rect.x, top: panel.rect.y }',
    ])
    // No offset token and no transform smuggles the vertical placement in by another name.
    expect(component).not.toContain('--portrait-dock-offset-y')
    expect(component).not.toMatch(/transform:/)

    // --- 4. Requirement 5.5: every persistence site, with its gate ---------
    // ENUMERATED FROM THE SOURCE, not from an assumed list. Five call sites, all writing the same
    // key. A sixth cannot appear without failing here.
    expect(component.match(/setSetting\(/g) ?? []).toHaveLength(5)
    expect(component.match(/setSetting\('portraitDockSettings'/g) ?? []).toHaveLength(5)

    // (a) `commitRect` — the drag / resize commit path. `usePersistentRect` calls it with
    //     `'user-interaction'` only from `stop()`, at the end of a pointer drag; every other
    //     caller defaults to `'automatic-sync'`, which this gate refuses. So `panel.setRect(...)`
    //     on its own — the call `applyFit` and the image-init effect make — never persists.
    const commitRect = extractSourceBlock(
      component,
      'commitRect',
      'const commitRect = useCallback(',
      '}, [floatingAvatar, mobile, setSetting, settings, updateFloatingAvatar])',
    )
    expect(commitRect).toContain("if (source !== 'user-interaction') return")
    expect(commitRect).toContain("setSetting('portraitDockSettings', { ...settings, rect, dockSide }, source)")
    expect(commitRect.indexOf("if (source !== 'user-interaction') return"))
      .toBeLessThan(commitRect.indexOf('setSetting('))
    expect(component).toContain('onCommit: commitRect')

    const persistentRect = await Bun.file(resolve(import.meta.dir, '../../hooks/usePersistentRect.ts')).text()
    expect(persistentRect).toContain("source: SettingsWriteSource = 'automatic-sync'")
    expect(persistentRect).toContain("commit(latest.current, 'user-interaction')")

    // (b) `updateSettings` — the shared user-initiated path. Its default source is
    //     `'user-interaction'`; any other source is refused unless the explicit init gate allows
    //     it. Every Requirement 5.5 action that is not a drag reaches persistence through here.
    const updateSettings = extractSourceBlock(
      component,
      'updateSettings',
      'const updateSettings = useCallback(',
      '}, [fullSettingsLoaded, setSetting, settings])',
    )
    expect(updateSettings).toContain("source: SettingsWriteSource = 'user-interaction'")
    expect(updateSettings).toContain("if (source !== 'user-interaction' && !canPersistPortraitDockInitialization(fullSettingsLoaded)) return")
    expect(updateSettings).toContain("setSetting('portraitDockSettings', { ...settings, ...partial }, source)")
    expect(updateSettings.indexOf('canPersistPortraitDockInitialization'))
      .toBeLessThan(updateSettings.indexOf('setSetting('))

    // ...and the user-initiated callers Requirement 5.5 names, each reaching it from a control:
    // the dock-side change, the reset, and the close.
    for (const caller of [
      'const setDockSide = useCallback(',
      'const resetCurrentLayout = useCallback(',
      'const closePortraitDock = useCallback(',
    ]) {
      expect(component).toContain(caller)
    }
    expect(extractSourceBlock(component, 'setDockSide', 'const setDockSide = useCallback(', 'updateSettings({ dockSide, rect })'))
      .toContain('updateSettings({ dockSide, rect })')
    expect(extractSourceBlock(component, 'resetCurrentLayout', 'const resetCurrentLayout = useCallback(', '}, [settings.defaultAspectRatioLock, settings.defaultDockSide, updateFloatingAvatar, updateSettings])'))
      .toContain('updateSettings({')
    expect(extractSourceBlock(component, 'closePortraitDock', 'const closePortraitDock = useCallback(', '}, [activeChatId, closeFloatingAvatar, updateSettings])'))
      .toContain('updateSettings({ open: false })')
    // `applyFit` sizes through the rect hook and never writes settings itself, so the fit action
    // persists only if the commit path judges it user-initiated.
    const applyFit = extractSourceBlock(
      component,
      'applyFit',
      'const applyFit = useCallback(',
      '}, [bounds, floatingAvatar, isFloating, mobile, naturalSize, panel, ratio, settings.defaultDockSide, settings.dockSide])',
    )
    expect(applyFit).toContain('panel.setRect(nextRect)')
    expect(applyFit).not.toContain('setSetting(')

    // (c) The extension host-intent preview. An explicitly tagged `'state-sync'` write, reachable
    //     only from the `image-preview` host-intent window listener — an image the user opened in
    //     an extension — and never from measurement. RECORDED HERE AS IT IS: it does carry
    //     `rect`, so it is the one persistence site that is neither a Requirement 5.5 action nor
    //     an init gate, and the pin exists so it cannot change shape unnoticed.
    const previewHandler = extractSourceBlock(
      component,
      'onPreview',
      'const onPreview = (event: Event) => {',
      'event.preventDefault()',
    )
    expect(previewHandler).toContain("setSetting('portraitDockSettings', {")
    expect(previewHandler).toContain("}, 'state-sync')")
    expect(previewHandler).toContain('rect,')
    expect(component).toContain("const eventName = hostIntentEventName('image-preview')")
    // The rect it persists is the placed dock rect, never a reclaim-derived value.
    expect(previewHandler).not.toContain('layoutReclaim')

    // (d) The full reset.
    const resetAllSettings = extractSourceBlock(
      component,
      'resetAllSettings',
      'const resetAllSettings = useCallback(',
      '}, [closeFloatingAvatar, setSetting])',
    )
    expect(resetAllSettings).toContain("setSetting('portraitDockSettings', { ...DEFAULT_PORTRAIT_DOCK_SETTINGS })")

    // (e) The bootstrap / init write, explicitly gated on full settings hydration so it cannot
    //     race a reload and overwrite the persisted row with a pre-hydration default.
    expect(component).toMatch(
      /if \(!canPersistPortraitDockInitialization\(fullSettingsLoaded\)\) \{[\s\S]*?return\s*\}\s*setSetting\('portraitDockSettings', \{/,
    )
    expect(component.match(/'portrait-dock-init'\)/g) ?? []).toHaveLength(1)
    expect(component).toContain("import { canPersistPortraitDockInitialization } from '@/store/slices/settings'")

    // None of the five sites is inside the reclaim effect, restated as a containment check so the
    // enumeration above and the effect assertion in step 2 cannot drift apart.
    expect(effectSource).not.toContain('setSetting')
  })
})

// ---------------------------------------------------------------------------
// Stylesheet no-regression support (Requirements 2.6, 6.1-6.4, 6.6)
//
// WHY A PARSER RATHER THAN `toContain` ON THE WHOLE FILE.
// Every Requirement 6 criterion is a claim about a SPECIFIC rule: `min-height: 41px` under
// `data-dock-request='strip'`, `display: contents` under `floating`/unrequested, no
// `flex: 0 0 auto` on a docked QuickToolbar root. A whole-file substring check cannot express
// any of them, and in several cases would be outright FALSE while the stylesheet is correct —
// `flex: 0 0 auto` legitimately appears on `.toolbarBtn` and `.nativeDockActions`, and
// `display: contents` legitimately appears on a `[data-dock-request='strip']` selector that
// targets an empty Spindle wrapper inside the mount rather than `_chatToolbar` itself. Splitting
// the sheet into (at-rule context, selector, body) triples is what makes the criteria
// expressible without pinning unrelated declarations.
//
// SCOPE LIMITATION. These are assertions about the SOURCE stylesheet's declared rules. They say
// nothing about cascade resolution, specificity outcomes, or rendered geometry in a browser; the
// rendered clauses of Requirement 6 are established only by the runtime verification steps.
// ---------------------------------------------------------------------------

interface CssRule {
  /** The selector list exactly as written, comments stripped, whitespace collapsed. */
  selector: string
  /** The declaration block's contents, without the surrounding braces. */
  body: string
  /** The enclosing at-rule preludes, outermost first, joined by a space. `''` at top level. */
  media: string
}

/**
 * Splits a stylesheet into its declaration blocks, carrying the at-rule context each one sits
 * in. Deliberately minimal — it handles the two constructs `ChatView.module.css` actually uses
 * (top-level rules and `@media` / `@keyframes` nesting) and nothing else. Commas inside
 * `:not(...)` / `:has(...)` are left alone because selectors are never split here; every
 * assertion below matches against the full selector list instead.
 */
function parseCssRules(css: string): CssRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  const atRuleStack: string[] = []
  let prelude = ''

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (char === '}') {
      atRuleStack.pop()
      prelude = ''
      continue
    }

    if (char !== '{') {
      prelude += char
      continue
    }

    const selector = prelude.trim().replace(/\s+/g, ' ')
    prelude = ''

    if (selector.startsWith('@')) {
      atRuleStack.push(selector)
      continue
    }

    let depth = 1
    let body = ''
    index += 1
    for (; index < source.length; index += 1) {
      const inner = source[index]
      if (inner === '{') depth += 1
      else if (inner === '}') {
        depth -= 1
        if (depth === 0) break
      }
      body += inner
    }

    rules.push({ selector, body, media: atRuleStack.join(' ') })
  }

  return rules
}

/** The mobile breakpoint Requirement 2.6 names, spelled as the at-rule prelude actually is. */
const MOBILE_MEDIA_PRELUDE = '@media (max-width: 600px)'

/** The full-width-mode portrait-side-strip override, as the selector is actually written. */
const PORTRAIT_SIDE_UNCONSTRAINED_SELECTOR = '.body:not([data-chat-constrained]) .portraitSide'

describe('portrait dock placement', () => {
  test('uses the default lane position when no y coordinate is supplied', () => {
    const rect = placeDockedPortraitRect(
      { width: 280, height: 280 },
      'right',
      { minWidth: 180, minHeight: 180, maxWidth: 720, maxHeight: 860 },
      { width: 960, height: 615 },
    )

    expect(rect).toEqual({ x: 668, y: 323, width: 280, height: 280 })
  })

  test('preserves a valid y coordinate of zero when docking', () => {
    expect(placeDockedPortraitRect(
      { width: 280, height: 280 },
      'left',
      { minWidth: 180, minHeight: 180, maxWidth: 720, maxHeight: 860 },
      { width: 960, height: 615 },
      0,
    )).toEqual({ x: 12, y: 0, width: 280, height: 280 })
  })

  test('keeps a clamped vertical lane position while anchoring each side correctly', () => {
    const bounds = { minWidth: 180, minHeight: 180, maxWidth: 720, maxHeight: 860 }
    const viewport = { width: 960, height: 615 }

    expect(placeDockedPortraitRect({ width: 280, height: 280 }, 'left', bounds, viewport, 180))
      .toEqual({ x: 12, y: 180, width: 280, height: 280 })
    expect(placeDockedPortraitRect({ width: 280, height: 280 }, 'right', bounds, viewport, 580))
      .toEqual({ x: 668, y: 335, width: 280, height: 280 })
  })

  test('keeps the vertical lane position when switching dock sides', () => {
    const bounds = { minWidth: 180, minHeight: 180, maxWidth: 720, maxHeight: 860 }
    const viewport = { width: 960, height: 615 }
    const current = placeDockedPortraitRect({ width: 280, height: 280 }, 'left', bounds, viewport, 0)

    expect(placeDockedPortraitRect(current, 'right', bounds, viewport, current.y))
      .toEqual({ x: 668, y: 0, width: 280, height: 280 })
  })

  test('transfers the dock side when a dragged portrait crosses the chat midpoint', () => {
    const viewport = { width: 960, height: 615 }

    expect(resolveDockSideForRect({ x: 12, width: 280 }, viewport)).toBe('left')
    expect(resolveDockSideForRect({ x: 668, width: 280 }, viewport)).toBe('right')
    expect(placeDockedPortraitRect(
      { width: 280, height: 280 },
      resolveDockSideForRect({ x: 668, width: 280 }, viewport),
      { minWidth: 180, minHeight: 180, maxWidth: 720, maxHeight: 860 },
      viewport,
      42,
    )).toEqual({ x: 668, y: 42, width: 280, height: 280 })
  })

  test('keeps a user-closed portrait closed for the same chat but reopens after chat changes', () => {
    expect(shouldAutoOpenPortraitForChat('chat-1', 'chat-1', false)).toBe(false)
    expect(shouldAutoOpenPortraitForChat('chat-2', 'chat-1', false)).toBe(true)
    expect(shouldAutoOpenPortraitForChat('chat-1', null, false)).toBe(true)
    expect(shouldAutoOpenPortraitForChat('chat-1', 'chat-1', true)).toBe(true)
  })

  test('restores natural image dimensions within available bounds', () => {
    expect(fitPortraitSize(
      2,
      { minWidth: 180, minHeight: 180, maxWidth: 500, maxHeight: 400 },
      'natural',
      { width: 1200, height: 600 },
    )).toEqual({ width: 500, height: 250 })
  })

  test('preserves a saved dock size when the portrait image initializes', () => {
    const bounds = { minWidth: 180, minHeight: 180, maxWidth: 720, maxHeight: 860 }
    const viewport = { width: 960, height: 900 }
    const savedRect = { x: 0, y: 24, width: 266, height: 832 }

    expect(resolveDockedPortraitImageRect(
      { width: 589, height: 832 },
      savedRect,
      'left',
      bounds,
      viewport,
    )).toEqual({ x: 12, y: 24, width: 266, height: 832 })
  })

  test('reclaims only the dock width outside the constrained chat gutter', () => {
    expect(getPortraitLayoutReclaim(960, 680, 280)).toBe(40)
  })

  test('does not retain the legacy docked offset transform', async () => {
    const css = await Bun.file(resolve(import.meta.dir, 'PortraitDock.module.css')).text()
    const chatCss = await Bun.file(resolve(import.meta.dir, 'ChatView.module.css')).text()
    const component = await Bun.file(resolve(import.meta.dir, 'PortraitDock.tsx')).text()

    expect(css).not.toContain('--portrait-dock-offset-y')
    expect(css).not.toMatch(/\.dockedDock\s*\{[^}]*transform:/s)
    expect(css).toMatch(/\.dockedDock\s*\{[^}]*align-self:\s*flex-start;/s)
    expect(chatCss).toContain("[data-surface-id='portrait_dock.workspace']")
    expect(chatCss).toMatch(/portrait_dock\.workspace'\]\)\s*\{\s*display:\s*contents;/s)
    // The dock resolves its chat-body ancestor through the stable surface marker, declared
    // once as a named constant and consumed by `closest<HTMLElement>()` so the lookup keeps
    // working across the `display: contents` Spindle host chain.
    expect(component).toContain('const CHAT_BODY_SELECTOR = \'[data-lumiverse-surface="chat-body"]\'')
    expect(component).toMatch(/closest<HTMLElement>\(CHAT_BODY_SELECTOR\)/)
    // Regression guard: the width-mode-conditional attribute must never be the resolution
    // anchor again, in inlined or any other selector form.
    expect(component).not.toContain("closest<HTMLElement>('[data-chat-constrained]')")
    expect(component).not.toContain("'[data-chat-constrained]'")

    // Requirement 2.6 — the mobile overlay behavior for the portrait SIDE STRIP (the slim tab
    // plus `PortraitPanel`, a different surface from `Portrait_Dock`) survives in all four width
    // modes. Two rules carry the same selector and must keep disagreeing in exactly one way:
    // the desktop rule drops the strip into flow for unconstrained (`full`) chat width so it
    // does not overlap unconstrained content, and the `max-width: 600px` block re-overrides that
    // back to `position: absolute` because mobile always wants the overlay. Matched on exact
    // selector equality, not `includes`, because the left/right anchor rules in the same block
    // carry this selector as a prefix.
    const chatRules = parseCssRules(chatCss)
    const portraitSideOverrides = chatRules.filter(
      (rule) => rule.selector === PORTRAIT_SIDE_UNCONSTRAINED_SELECTOR,
    )
    expect(portraitSideOverrides).toHaveLength(2)

    const desktopPortraitSide = portraitSideOverrides.find((rule) => rule.media === '')
    const mobilePortraitSide = portraitSideOverrides.find((rule) => rule.media === MOBILE_MEDIA_PRELUDE)
    expect(desktopPortraitSide?.body).toMatch(/position:\s*relative;/)
    expect(mobilePortraitSide?.body).toMatch(/position:\s*absolute;/)
    // The re-override is only an overlay if it also re-establishes the edge anchoring, so both
    // sides are pinned rather than just the position keyword.
    const mobileSideAnchors = chatRules.filter(
      (rule) => rule.media === MOBILE_MEDIA_PRELUDE
        && (rule.selector === `${PORTRAIT_SIDE_UNCONSTRAINED_SELECTOR}Left`
          || rule.selector === `${PORTRAIT_SIDE_UNCONSTRAINED_SELECTOR}Right`),
    )
    expect(mobileSideAnchors).toHaveLength(2)
  })

  test('keeps the chat top dock and quick toolbar stylesheet rules unregressed', async () => {
    // Requirement 6 no-regression surface. `ChatView.module.css` is not modified by this spec at
    // all; these assertions exist so an unrelated edit to the dock rail cannot land unnoticed
    // behind a green portrait-dock run.
    const chatCss = await Bun.file(resolve(import.meta.dir, 'ChatView.module.css')).text()
    const rules = parseCssRules(chatCss)
    const toolbarRules = rules.filter((rule) => rule.selector.includes('.chatToolbar'))
    expect(toolbarRules.length).toBeGreaterThan(0)

    // --- Requirement 6.1: strip keeps its 41px floor, its glass fill, and its border --------
    const stripMinHeightRules = toolbarRules.filter(
      (rule) => rule.selector.includes(".chatToolbar[data-dock-request='strip']")
        && /min-height:\s*41px;/.test(rule.body),
    )
    expect(stripMinHeightRules).toHaveLength(1)

    const toolbarBase = rules.find((rule) => rule.selector === '.chatToolbar')
    expect(toolbarBase).toBeDefined()
    expect(toolbarBase?.body).toMatch(/background:\s*var\(--lcs-glass-bg,/)
    expect(toolbarBase?.body).toMatch(/border-bottom:\s*1px solid var\(--lcs-glass-border,/)

    // The invariant behind 6.1: a docked rail must never be collapsed away. Scoped to
    // `.chatToolbar` selectors, because a `[data-dock-request='strip']` selector targeting an
    // EMPTY Spindle wrapper inside the mount does legitimately collapse to `display: contents`.
    for (const rule of toolbarRules) {
      if (!rule.selector.includes("[data-dock-request='strip']")) continue
      expect(rule.body).not.toMatch(/display:\s*contents/)
    }

    // --- Requirement 6.4: the collapse is restricted to floating / unrequested + unoccupied --
    // Exactly two `.chatToolbar` rules collapse to `display: contents`, and they must stay
    // partitioned this way: one whose SUBJECT is the rail itself (asserted below in full), and
    // one that targets empty Spindle wrappers INSIDE the rail so they cannot paint a second one.
    const toolbarCollapseRules = toolbarRules.filter((rule) => /display:\s*contents;/.test(rule.body))
    expect(toolbarCollapseRules).toHaveLength(2)
    const collapseRules = toolbarCollapseRules.filter(
      (rule) => rule.selector.includes(".chatToolbar[data-dock-request='floating']"),
    )
    expect(collapseRules).toHaveLength(1)
    const wrapperCollapse = toolbarCollapseRules.find((rule) => rule !== collapseRules[0]) as CssRule
    expect(wrapperCollapse.selector).toMatch(/:empty\)|:not\(:has\(\*\)\)|:not\(:has\(button/)
    expect(wrapperCollapse.selector).not.toMatch(/\.chatToolbar\[data-dock-request/)

    const collapse = collapseRules[0] as CssRule
    expect(collapse.selector).toContain(".chatToolbar[data-dock-request='floating']")
    expect(collapse.selector).toContain('.chatToolbar:not([data-dock-request])')
    // Both halves of the selector list are gated on being unoccupied and on holding no unhidden
    // button and no QuickToolbar, so an occupied or populated rail cannot reach the collapse.
    expect(collapse.selector.match(/:not\(\[data-spindle-occupied\]\)/g) ?? []).toHaveLength(2)
    expect(collapse.selector.match(/> \[data-component='QuickToolbar'\]\)\)/g) ?? []).toHaveLength(2)
    expect(collapse.selector.match(/button:not\(\[hidden\]\)/g) ?? []).toHaveLength(4)
    expect(collapse.body).toMatch(/min-height:\s*0;/)
    expect(collapse.body).toMatch(/padding:\s*0;/)
    expect(collapse.body).toMatch(/border:\s*0;/)

    // --- Requirement 6.2: the docked QuickToolbar root spans the whole rail -----------------
    const dockedRootRules = rules.filter(
      (rule) => rule.selector.includes("[data-quick-toolbar-placement='chat_top_dock'])")
        && !rule.selector.includes('> nav'),
    )
    expect(dockedRootRules).toHaveLength(1)
    const dockedRoot = dockedRootRules[0] as CssRule
    // Both the native `.chatToolbar` host and the Spindle `chat_top_dock` mount host are covered
    // by the same rule, so a docked toolbar stretches in either topology.
    expect(dockedRoot.selector).toContain(".chatToolbar > :global([data-component='QuickToolbar'][data-quick-toolbar-placement='chat_top_dock'])")
    expect(dockedRoot.selector).toContain(":global([data-spindle-mount='chat_top_dock'])")
    expect(dockedRoot.body).toMatch(/flex:\s*1 1 100% !important;/)
    expect(dockedRoot.body).toMatch(/width:\s*100% !important;/)

    // --- Requirement 6.3: no hugging and no clamping on any QuickToolbar-scoped rule ---------
    // `width: max-content` is absent from the whole sheet, so that half is asserted globally.
    // `flex: 0 0 auto` is NOT — it legitimately styles `.toolbarBtn` and `.nativeDockActions` —
    // so it is prohibited across every rule whose selector reaches a QuickToolbar, which is a
    // superset of the docked roots and therefore a strictly stronger check than 6.3 asks for.
    expect(chatCss).not.toContain('max-content')
    const quickToolbarScopedRules = rules.filter(
      (rule) => rule.selector.includes("data-component='QuickToolbar'"),
    )
    expect(quickToolbarScopedRules.length).toBeGreaterThan(0)
    for (const rule of quickToolbarScopedRules) {
      expect(rule.body).not.toMatch(/flex:\s*0 0 auto/)
      expect(rule.body).not.toMatch(/width:\s*max-content/)
    }

    // --- Requirement 6.6: bubbles still center within the published content width ------------
    const chatColumn = rules.find((rule) => rule.selector === '.chatColumn')
    const chatColumnInner = rules.find((rule) => rule.selector === '.chatColumnInner')
    expect(chatColumn?.body).toMatch(/align-items:\s*center;/)
    expect(chatColumnInner?.body).toMatch(
      /max-width:\s*var\(--lumiverse-chat-content-width, none\);/,
    )
    // The reclaim math is fed the same number this variable publishes (Property 5), so the width
    // the dock reclaims and the width the bubbles center within cannot disagree.
    expect(chatColumnInner?.body).toMatch(/width:\s*100%;/)
  })

  test('keeps syncDockRequest\'s native default dock request unmodified', async () => {
    // Requirement 6.5, asserted over code NO task in this plan modifies. It exists so an
    // unrelated edit to the dock-request path cannot pass unnoticed.
    //
    // WHAT THE SOURCE ACTUALLY SAYS, AND WHY THAT IS WHAT IS PINNED.
    // The workspace AGENTS.md rule for this criterion quotes the native default as
    // `dockQuickToolbar || keepFloatingDockHost ? 'strip' : 'floating'`. That expression is NOT
    // in `ChatView.tsx`: `chatTopDock`'s default is the UNCONDITIONAL `'strip'`, because the
    // native controls own the top strip regardless of QuickToolbar placement. Asserting the
    // rule's paraphrase would pin a shape the code does not have and fail immediately, so the
    // assertions below pin the real constant instead. The two derived flags the rule names are
    // still pinned — they are declared, and they are still in the effect's dependency list, so a
    // placement change still re-runs the sync.
    const chatView = await Bun.file(resolve(import.meta.dir, 'ChatView.tsx')).text()

    expect(chatView).toContain(
      "const dockQuickToolbar = suiteExtensionEnabled && quickToolbarPlacement === 'chat_top_dock'",
    )
    expect(chatView).toContain(
      "const keepFloatingDockHost = suiteExtensionEnabled && quickToolbarPlacement === 'floating' && keepDockEnabledWhenFloating(quickToolbarSettings)",
    )

    // The native default itself, and the request handed to the rendered `_chatToolbar`.
    expect(chatView).toContain("const nativeDockRequest = 'strip' as const")
    expect(chatView).toContain('const chatTopDockRequest = nativeDockRequest')
    expect(chatView).toContain('data-dock-request={chatTopDockRequest}')

    // `syncDockRequest`'s third parameter is the default applied when the anchor holds no child
    // extension request at all — the mechanism Requirement 6.5 is about.
    expect(chatView).toContain(
      'const syncDockRequest = (anchor: HTMLElement, resolve: (request: unknown) => string, defaultRequest: string | null = null, resolveChild: (request: unknown) => string = resolve) =>',
    )
    expect(chatView).toContain(
      'syncDockRequest(chatTopDock, () => nativeDockRequest, nativeDockRequest, (request) => effectiveQuickToolbarDockRequest(request, quickToolbarSettings))',
    )

    // Both flags remain in the dependency list of the effect that owns the sync, so a
    // QuickToolbar placement change still re-runs it.
    expect(chatView).toContain('}, [chatId, dockQuickToolbar, keepFloatingDockHost, quickToolbarSettings])')
  })

  test('limits extension previews to their matching chat and avatar context', () => {
    const preview = { chatId: 'chat-1', avatarId: 'avatar-1', imageUrl: 'preview.png' }

    expect(ownsPortraitPreviewForContext(preview, 'chat-1', 'avatar-1')).toBe(true)
    expect(ownsPortraitPreviewForContext(preview, 'chat-2', 'avatar-1')).toBe(false)
    expect(ownsPortraitPreviewForContext(preview, 'chat-1', 'avatar-2')).toBe(false)
    expect(ownsPortraitPreviewForContext(null, 'chat-1', 'avatar-1')).toBe(false)
  })

  test('keeps native image viewers isolated when the extension claims a preview', async () => {
    const component = await Bun.file(resolve(import.meta.dir, 'PortraitDock.tsx')).text()
    const nativeViewer = await Bun.file(resolve(import.meta.dir, 'FloatingAvatarViewer.tsx')).text()

    expect(portraitDockOwnsFloatingAvatar({ owner: 'portrait-dock' }, true)).toBe(true)
    expect(portraitDockOwnsFloatingAvatar({ owner: 'native' }, true)).toBe(false)
    expect(portraitDockOwnsFloatingAvatar({ owner: 'native' }, false)).toBe(true)
    expect(portraitDockOwnsFloatingAvatar(null, true)).toBe(false)
    expect(component).toMatch(/if \(!extensionOwned \|\| typeof window === 'undefined'\) return/s)
    expect(component).toMatch(/hostIntentEventName\('image-preview'\)[\s\S]*event\.preventDefault\(\)/s)
    expect(component).toMatch(/autoSyncedChatIdRef\.current === activeChatId[\s\S]*floatingAvatar\?\.owner === 'portrait-dock'/s)
    expect(component).toMatch(/!portraitDockOwnsFloatingAvatar\(floatingAvatar, extensionOwned\)/)
    expect(nativeViewer).toMatch(/if \(!floatingAvatar \|\| portraitDockOwnsAvatar\) return null/)
  })
})

// ---------------------------------------------------------------------------
// Property 7 support — ancestor resolution across the real Spindle host chain
//
// WHY THE DISPLAY ASSIGNMENT IS THE POINT.
// `resolvePortraitLayoutTargets` resolves STRUCTURALLY: `closest()` for the chat-body ancestor,
// then two `:scope >` direct-child queries. Neither reads computed style, so setting
// `display: contents` on a wrapper cannot change the answer. That is exactly what makes
// Requirement 4.5 — resolution works whether the dock is mounted natively or through a host
// surface whose intermediate nodes are `display: contents` — a PROVEN claim rather than an
// assumed one: every tree below is resolved under an all-`contents`, an all-normal, AND a mixed
// assignment, and all three resolutions must return the same three element references. An edit
// that reached for `parentElement`, `offsetParent`, or a computed-style read would break the
// all-`contents` pass; an edit that reached for a flex-order or layout-sibling scan would break
// the all-normal pass.
//
// SCOPE LIMITATION. This is a claim about DOM traversal against a synthesized copy of the real
// rendered chain, not about the browser's own layout. It says nothing about rendered geometry.
// ---------------------------------------------------------------------------

/**
 * Property 6's LOCAL jsdom document, reused deliberately: this file installs no DOM on
 * `globalThis`, so every DOM-touching property stays confined to an explicit instance.
 */
const property7Document = property6Document

/** How the intermediate wrappers between the dock and `Chat_Body` are laid out. */
type WrapperDisplayPolicy = 'all-contents' | 'all-normal' | 'mixed'

/**
 * Compile-time coverage guard: a fourth policy cannot be added to the union without being added
 * here, so the rotation below cannot silently stop reaching one of them.
 */
const WRAPPER_DISPLAY_POLICY_COVERAGE = {
  'all-contents': true,
  'all-normal': true,
  mixed: true,
} as const satisfies Record<WrapperDisplayPolicy, true>

const WRAPPER_DISPLAY_POLICIES = Object.keys(WRAPPER_DISPLAY_POLICY_COVERAGE) as WrapperDisplayPolicy[]

/** Non-`contents` display values a wrapper in this chain can plausibly carry. */
const NORMAL_WRAPPER_DISPLAYS = ['block', 'flex', 'grid', 'inline-block', 'inline'] as const

function resolveWrapperDisplay(rng: Rng, policy: WrapperDisplayPolicy): string {
  switch (policy) {
    case 'all-contents':
      return 'contents'
    case 'all-normal':
      return pickOne(rng, NORMAL_WRAPPER_DISPLAYS)
    case 'mixed':
      return rng() < 0.5 ? 'contents' : pickOne(rng, NORMAL_WRAPPER_DISPLAYS)
    default:
      return assertNever(policy)
  }
}

function applyWrapperDisplays(rng: Rng, nodes: readonly HTMLElement[], policy: WrapperDisplayPolicy): void {
  for (const node of nodes) node.style.display = resolveWrapperDisplay(rng, policy)
}

/** Which of the three markers a partially committed chat frame has published. */
interface MarkerPresence {
  chatBody: boolean
  chatColumn: boolean
  chatContent: boolean
}

/**
 * All 2^3 present/absent combinations, ROTATED rather than sampled so each of the seven partial
 * trees is reached deterministically. All-or-nothing (Requirement 1.5) is only a live claim if
 * every way of being incomplete is actually exercised.
 */
const MARKER_COMBINATIONS = [
  { chatBody: true, chatColumn: true, chatContent: true },
  { chatBody: true, chatColumn: true, chatContent: false },
  { chatBody: true, chatColumn: false, chatContent: true },
  { chatBody: true, chatColumn: false, chatContent: false },
  { chatBody: false, chatColumn: true, chatContent: true },
  { chatBody: false, chatColumn: true, chatContent: false },
  { chatBody: false, chatColumn: false, chatContent: true },
  { chatBody: false, chatColumn: false, chatContent: false },
] as const satisfies readonly MarkerPresence[]

function markerCombinationKey(presence: MarkerPresence): string {
  return [
    presence.chatBody ? 'body' : 'no-body',
    presence.chatColumn ? 'column' : 'no-column',
    presence.chatContent ? 'content' : 'no-content',
  ].join('+')
}

const MARKER_COMBINATION_KEYS = MARKER_COMBINATIONS.map(markerCombinationKey)

interface AncestorTreeOptions {
  rng: Rng
  presence: MarkerPresence
  /** Depth 0: the dock is a direct child of `Chat_Body`, with no host chain at all. */
  nativeMount: boolean
  /** Wrapper nodes added ON TOP of the real chain's five, so depth is not pinned at five. */
  extraWrapperCount: number
  /** Plain sibling nodes sprinkled through the tree, so resolution has to be selective. */
  noiseCount: number
  displayPolicy: WrapperDisplayPolicy
}

interface AncestorTree {
  root: HTMLElement
  /** The node that plays `Chat_Body`, marked or not. */
  frameHost: HTMLElement
  dock: HTMLElement
  /** The marked `chat-body`, or `null` when this tree never published the marker. */
  chatBody: HTMLElement | null
  chatColumn: HTMLElement | null
  chatContent: HTMLElement | null
  /** Every node between the frame host and the dock, outermost first. */
  intermediates: readonly HTMLElement[]
  /** A `chat-column` namesake that is NOT a direct child of `chat-body`. */
  decoyColumn: HTMLElement
  /** A `chat-column-inner` namesake nested inside the decoy column. */
  decoyColumnInner: HTMLElement
  /** A `chat-column-inner` namesake nested a level too deep inside the REAL column. */
  deepContentDecoy: HTMLElement | null
  /** A `chat-body` namesake that is never an ancestor of the dock. */
  decoyBody: HTMLElement
  destroy: () => void
}

/**
 * Synthesizes the real rendered chain from the design's topology section:
 *
 *   chat-body
 *     -> [data-spindle-mount="chat_surface_side"]
 *       -> [data-spindle-extension-root]
 *         -> [data-spindle-host-surface="portrait_dock.workspace"]
 *           -> [data-surface-id="portrait_dock.workspace"]
 *             -> bridge root
 *               -> aside (the dock)
 *
 * ...at a RANDOM depth: the five real nodes keep their real relative order and the requested
 * extra wrappers are spliced in at random positions among them, including above the mount and
 * directly above the dock. The alternative shape — the native mount, where the dock is a direct
 * child of `chat-body` with no chain at all — is the `nativeMount` case.
 */
function createAncestorTree(options: AncestorTreeOptions): AncestorTree {
  const { rng, presence, nativeMount, extraWrapperCount, noiseCount, displayPolicy } = options
  const doc = property7Document

  const root = doc.createElement('div')
  root.setAttribute('data-property-7-root', '')
  doc.body.appendChild(root)

  // The node that plays `Chat_Body`. It carries the marker only when this tree published it;
  // an unmarked frame host is how "no chat-body ancestor at all" is expressed.
  const frameHost = doc.createElement('div')
  if (presence.chatBody) frameHost.setAttribute('data-lumiverse-surface', 'chat-body')
  root.appendChild(frameHost)

  const chatColumn = presence.chatColumn ? doc.createElement('div') : null
  if (chatColumn) {
    chatColumn.setAttribute('data-lumiverse-surface', 'chat-column')
    frameHost.appendChild(chatColumn)
  }

  const chatContent = presence.chatContent ? doc.createElement('div') : null
  if (chatContent) {
    chatContent.setAttribute('data-lumiverse-surface', 'chat-column-inner')
    // With no real column committed, the inner element still has to land somewhere: a frame that
    // published the inner marker but not the column is one of the seven partial trees, and it
    // must still resolve to nothing.
    ;(chatColumn ?? frameHost).appendChild(chatContent)
  }

  // --- The dock's ancestor chain ------------------------------------------
  const dock = doc.createElement('aside')
  const intermediates: HTMLElement[] = []

  if (!nativeMount) {
    const spindleMount = doc.createElement('div')
    spindleMount.setAttribute('data-spindle-mount', 'chat_surface_side')
    const extensionRoot = doc.createElement('div')
    extensionRoot.setAttribute('data-spindle-extension-root', '')
    const hostSurface = doc.createElement('div')
    hostSurface.setAttribute('data-spindle-host-surface', 'portrait_dock.workspace')
    const surfaceNode = doc.createElement('div')
    surfaceNode.setAttribute('data-surface-id', 'portrait_dock.workspace')
    const bridgeRoot = doc.createElement('div')
    bridgeRoot.setAttribute('data-portrait-bridge-root', '')

    const chain: HTMLElement[] = [spindleMount, extensionRoot, hostSurface, surfaceNode, bridgeRoot]
    for (let index = 0; index < extraWrapperCount; index += 1) {
      const wrapper = doc.createElement('div')
      wrapper.setAttribute('data-property-7-wrapper', String(index))
      // `chain.length` is a valid insertion point, so a wrapper can also land between the bridge
      // root and the dock — the position an extension re-render is most likely to add one.
      chain.splice(randomInt(rng, 0, chain.length), 0, wrapper)
    }

    for (const node of chain) intermediates.push(node)
    frameHost.appendChild(chain[0] as HTMLElement)
    for (let index = 1; index < chain.length; index += 1) {
      ;(chain[index - 1] as HTMLElement).appendChild(chain[index] as HTMLElement)
    }
    ;(chain[chain.length - 1] as HTMLElement).appendChild(dock)
  }
  else {
    frameHost.appendChild(dock)
  }

  applyWrapperDisplays(rng, intermediates, displayPolicy)

  // --- Decoy markers ------------------------------------------------------
  // These are the drift the `:scope >` direct-child queries exist to prevent, and the design
  // calls them out as a real risk: a descendant query would find a namesake nested deeper in the
  // tree instead of the committed frame's own column and content.
  const decoyHost = doc.createElement('div')
  decoyHost.setAttribute('data-property-7-decoy-host', '')
  // Never a direct child of the frame host, so it can never be a legitimate match.
  frameHost.appendChild(decoyHost)

  const decoyColumn = doc.createElement('div')
  decoyColumn.setAttribute('data-lumiverse-surface', 'chat-column')
  decoyHost.appendChild(decoyColumn)

  const decoyColumnInner = doc.createElement('div')
  decoyColumnInner.setAttribute('data-lumiverse-surface', 'chat-column-inner')
  decoyColumn.appendChild(decoyColumnInner)

  const decoyBody = doc.createElement('div')
  decoyBody.setAttribute('data-lumiverse-surface', 'chat-body')
  // Inside the frame, never on the dock's ancestor path, so `closest()` must not reach it.
  decoyColumn.appendChild(decoyBody)

  // The sharpest decoy: a `chat-column-inner` one level too deep inside the REAL column. A
  // descendant query rooted at the column would return this instead of the real content.
  let deepContentDecoy: HTMLElement | null = null
  if (chatColumn) {
    const deepHost = doc.createElement('div')
    deepHost.setAttribute('data-property-7-deep-host', '')
    deepContentDecoy = doc.createElement('div')
    deepContentDecoy.setAttribute('data-lumiverse-surface', 'chat-column-inner')
    deepHost.appendChild(deepContentDecoy)
    // Inserted FIRST, so a query that ignored `:scope >` would meet it before the real content.
    chatColumn.insertBefore(deepHost, chatColumn.firstChild)
  }

  // --- Plain sibling noise ------------------------------------------------
  const noiseHosts = shuffle(rng, [
    root,
    frameHost,
    ...(chatColumn ? [chatColumn] : []),
    ...(chatContent ? [chatContent] : []),
    ...intermediates,
  ])
  for (let index = 0; index < noiseCount; index += 1) {
    const host = noiseHosts[index % noiseHosts.length] as HTMLElement
    const noise = doc.createElement('div')
    noise.setAttribute('data-property-7-noise', String(index))
    noise.style.display = resolveWrapperDisplay(rng, displayPolicy)
    // Half the noise precedes the real children, so the real column is not simply the first
    // direct child every time.
    if (rng() < 0.5 && host.firstChild) host.insertBefore(noise, host.firstChild)
    else host.appendChild(noise)
  }

  return {
    root,
    frameHost,
    dock,
    chatBody: presence.chatBody ? frameHost : null,
    chatColumn,
    chatContent,
    intermediates,
    decoyColumn,
    decoyColumnInner,
    deepContentDecoy,
    decoyBody,
    destroy: () => root.remove(),
  }
}

/**
 * Adds `count` wrappers between the dock and its current parent, in place. This is the direct
 * depth-invariance move: the same dock element, the same markers, strictly more intermediate
 * nodes, and therefore the same resolution BY REFERENCE.
 */
function deepenDockChain(
  rng: Rng,
  dock: HTMLElement,
  count: number,
  policy: WrapperDisplayPolicy,
): HTMLElement[] {
  const added: HTMLElement[] = []
  for (let index = 0; index < count; index += 1) {
    const parent = dock.parentElement
    if (!parent) break
    const wrapper = property7Document.createElement('div')
    wrapper.setAttribute('data-property-7-deepened', String(index))
    wrapper.style.display = resolveWrapperDisplay(rng, policy)
    parent.insertBefore(wrapper, dock)
    wrapper.appendChild(dock)
    added.push(wrapper)
  }
  return added
}

/** Asserts a resolution against the tree's markers BY REFERENCE, never by tag or attribute. */
function expectResolvedTree(targets: PortraitLayoutTargets | null, tree: AncestorTree): PortraitLayoutTargets {
  expect(targets).not.toBeNull()
  const resolved = targets as PortraitLayoutTargets
  expect(resolved.bodyElement).toBe(tree.chatBody)
  expect(resolved.chatColumn).toBe(tree.chatColumn)
  expect(resolved.chatContent).toBe(tree.chatContent)

  // The decoys are never what came back.
  expect(resolved.bodyElement).not.toBe(tree.decoyBody)
  expect(resolved.chatColumn).not.toBe(tree.decoyColumn)
  expect(resolved.chatContent).not.toBe(tree.decoyColumnInner)
  expect(resolved.chatContent).not.toBe(tree.deepContentDecoy)

  // The structural contract the `:scope >` queries encode, asserted independently of the
  // builder's own bookkeeping: each target is a DIRECT child of the one above it.
  expect(resolved.chatColumn.parentElement).toBe(resolved.bodyElement)
  expect(resolved.chatContent.parentElement).toBe(resolved.chatColumn)
  return resolved
}

describe('portrait dock ancestor resolution', () => {
  // Feature: portrait-dock-reload-anchoring, Property 7
  // For any chain of intermediate wrapper elements between the dock and Chat_Body, of any depth
  // and with any combination of `display: contents` and normal display, target resolution
  // returns the same Chat_Body, Chat_Column, and Chat_Content elements, and returns nothing at
  // all unless all three are present.
  // Validates: Requirements 4.5, 1.5
  test('Feature: portrait-dock-reload-anchoring, Property 7 — ancestor resolution is invariant to display: contents depth', () => {
    const observedCombinations = new Set<string>()
    const observedPolicies = new Set<WrapperDisplayPolicy>()
    const observedDepths = new Set<number>()
    let observedNativeMounts = 0
    let observedResolvedTrees = 0
    let observedPartialTrees = 0
    let observedDecoyTrees = 0
    let observedDeepChains = 0
    let maxDepth = 0
    let drawIndex = 0

    // The effect calls this with the dock ref before the bridge has mounted a node into it.
    expect(resolvePortraitLayoutTargets(null)).toBeNull()

    forAll(
      'Property 7',
      (rng) => {
        // Rotated, not sampled: every marker combination, every display policy, and every depth
        // from 0 through 8 extra wrappers is reached deterministically, so a green run cannot be
        // green because a dimension was never drawn.
        const presence = MARKER_COMBINATIONS[drawIndex % MARKER_COMBINATIONS.length] as MarkerPresence
        const displayPolicy = WRAPPER_DISPLAY_POLICIES[drawIndex % WRAPPER_DISPLAY_POLICIES.length] as WrapperDisplayPolicy
        const nativeMount = drawIndex % 4 === 3
        const extraWrapperCount = drawIndex % 9
        drawIndex += 1

        return {
          presence,
          displayPolicy,
          nativeMount,
          extraWrapperCount: nativeMount ? 0 : extraWrapperCount,
          noiseCount: randomInt(rng, 0, 5),
          deepenBy: randomInt(rng, 1, 4),
          // The tree's own randomness is drawn from this seed inside the check, so a
          // counterexample's full DOM shape is reproducible from the reported input alone.
          treeSeed: randomInt(rng, 1, 0x7fff_ffff),
        }
      },
      ({ presence, displayPolicy, nativeMount, extraWrapperCount, noiseCount, deepenBy, treeSeed }) => {
        const treeRng = makeRng(treeSeed)
        const tree = createAncestorTree({
          rng: treeRng,
          presence,
          nativeMount,
          extraWrapperCount,
          noiseCount,
          displayPolicy,
        })

        try {
          const resolvable = presence.chatBody && presence.chatColumn && presence.chatContent
          observedCombinations.add(markerCombinationKey(presence))
          observedPolicies.add(displayPolicy)
          observedDepths.add(tree.intermediates.length)
          maxDepth = Math.max(maxDepth, tree.intermediates.length)
          if (nativeMount) observedNativeMounts += 1
          if (tree.intermediates.length >= 10) observedDeepChains += 1

          // The builder really did build the real chain, and really did plant namesakes the
          // resolver could drift onto. Without this the decoy assertions would be vacuous.
          if (nativeMount) {
            // Depth 0: the dock is a direct child of the frame host, with no host chain at all.
            expect(tree.intermediates).toHaveLength(0)
            expect(tree.dock.parentElement).toBe(tree.frameHost)
          }
          else {
            expect(tree.intermediates.length).toBeGreaterThanOrEqual(5)
            expect(tree.root.querySelector('[data-spindle-mount="chat_surface_side"]')).not.toBeNull()
            expect(tree.root.querySelector('[data-spindle-extension-root]')).not.toBeNull()
            expect(tree.root.querySelector('[data-spindle-host-surface="portrait_dock.workspace"]')).not.toBeNull()
            expect(tree.root.querySelector('[data-surface-id="portrait_dock.workspace"]')).not.toBeNull()
          }
          const plantedColumns = tree.root.querySelectorAll('[data-lumiverse-surface="chat-column"]').length
          const plantedContents = tree.root.querySelectorAll('[data-lumiverse-surface="chat-column-inner"]').length
          expect(plantedColumns).toBeGreaterThanOrEqual(presence.chatColumn ? 2 : 1)
          expect(plantedContents).toBeGreaterThanOrEqual(presence.chatContent ? 2 : 1)
          if (plantedColumns > 1 && plantedContents > 1) observedDecoyTrees += 1

          // --- The claim, under every display assignment ------------------
          // Resolution is structural, so the SAME references must come back from an
          // all-`contents` chain, an all-normal chain, and a mixed one. This is the assertion
          // that turns Requirement 4.5 from an assumption into a proof.
          const resolutions: (PortraitLayoutTargets | null)[] = []
          for (const policy of [displayPolicy, 'all-contents', 'all-normal', 'mixed'] as const) {
            applyWrapperDisplays(treeRng, tree.intermediates, policy)
            const resolved = resolvePortraitLayoutTargets(tree.dock)
            if (resolvable) expectResolvedTree(resolved, tree)
            else expect(resolved).toBeNull()
            resolutions.push(resolved)
          }
          // Identical, not merely each-correct: every pass returned the same three references.
          for (const resolved of resolutions.slice(1)) {
            expect(resolved?.bodyElement ?? null).toBe(resolutions[0]?.bodyElement ?? null)
            expect(resolved?.chatColumn ?? null).toBe(resolutions[0]?.chatColumn ?? null)
            expect(resolved?.chatContent ?? null).toBe(resolutions[0]?.chatContent ?? null)
          }

          // --- Depth invariance, in place ---------------------------------
          // The same dock, the same markers, strictly more intermediate nodes. Resolution must
          // not move. This is what makes the property depth-invariant rather than
          // depth-5-specific, and it also carries the native mount past depth 0.
          const before = resolutions[0]
          const added = deepenDockChain(treeRng, tree.dock, deepenBy, displayPolicy)
          expect(added).toHaveLength(deepenBy)
          const after = resolvePortraitLayoutTargets(tree.dock)
          expect(after?.bodyElement ?? null).toBe(before?.bodyElement ?? null)
          expect(after?.chatColumn ?? null).toBe(before?.chatColumn ?? null)
          expect(after?.chatContent ?? null).toBe(before?.chatContent ?? null)
          if (resolvable) {
            expectResolvedTree(after, tree)
            observedResolvedTrees += 1
          }
          else {
            // All-or-nothing: every tree missing any one of the three resolves to nothing, at
            // every depth and under every display assignment.
            expect(after).toBeNull()
            observedPartialTrees += 1
          }

          // A dock the bridge created but has not inserted yet has no chat-body ancestor at all.
          const detached = property7Document.createElement('aside')
          expect(resolvePortraitLayoutTargets(detached)).toBeNull()
        }
        finally {
          tree.destroy()
        }
      },
    )

    // Input-space coverage. Without these the property could pass while never mounting natively,
    // never going deeper than the real five nodes, never planting a decoy, or never reaching one
    // of the seven partial trees — any of which would make the invariance claim vacuous.
    expect([...observedCombinations].sort()).toEqual([...MARKER_COMBINATION_KEYS].sort())
    expect(observedCombinations.size).toBe(8)
    expect([...observedPolicies].sort()).toEqual([...WRAPPER_DISPLAY_POLICIES].sort())
    // Depth 0 is the native mount; the real chain alone is 5; the deepest chain is 5 + 8.
    expect(observedDepths.has(0)).toBe(true)
    expect(maxDepth).toBe(13)
    expect(observedNativeMounts).toBeGreaterThan(0)
    expect(observedDeepChains).toBeGreaterThan(0)
    expect(observedDecoyTrees).toBeGreaterThan(0)
    expect(observedResolvedTrees).toBeGreaterThan(0)
    // Seven of the eight rotated combinations are partial, so partial trees dominate.
    expect(observedPartialTrees).toBeGreaterThan(observedResolvedTrees)
    expect(observedResolvedTrees + observedPartialTrees).toBe(PROPERTY_ITERATIONS)

    // The synthesized trees are cleaned up: no Property 7 root survives the run.
    expect(property7Document.querySelectorAll('[data-property-7-root]').length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Property 8 support — the dock-side reclaim style mapping
//
// WHAT THIS PROPERTY IS ABOUT.
// `resolveDockReclaimStyle` is the entire horizontal half of the docked dock's inline style and
// the only path by which the measured reclaim reaches the DOM. Requirement 3.6 says vertical
// placement stays `top: panel.rect.y` on `dockStyle` and never becomes a `--portrait-dock-offset-y`
// token or a `transform`. The stylesheet half of that prohibition is already owned by
// `does not retain the legacy docked offset transform` above and is NOT restated here; what this
// property adds is the other half — the reclaim style object itself cannot carry anything
// vertical, in any form, for any dock side, at any reclaim value.
//
// WHY THE KEY SET IS ASSERTED EXACTLY.
// A blocklist of vertical property names only catches the names someone thought to list. The
// exact key set catches every addition, including one nobody anticipated: `left` may return
// exactly `order` and `marginRight`, `right` exactly `marginLeft`, `floating` exactly nothing.
// The enumerated vertical blocklist is kept as well, because it names the specific regression
// Requirement 3.6 was written against and states it in the requirement's own vocabulary.
//
// SCOPE LIMITATION. This is a claim about the object the resolver returns, not about rendered
// geometry. It says nothing about the gap the browser paints; that is task 8.3's evidence.
// ---------------------------------------------------------------------------

/**
 * Dock sides, taken from the resolver's own parameter type rather than from a local literal, so
 * a fourth `dockSide` value added to `PortraitDockSettings` fails typecheck here instead of
 * silently shrinking this property's input space. `DOCK_SIDES` (declared with the Property 11
 * support above) supplies the runtime draws and is checked against this type below.
 */
type PropertyDockSide = Parameters<typeof resolveDockReclaimStyle>[0]

const DOCK_SIDE_COVERAGE = {
  left: true,
  right: true,
  floating: true,
} as const satisfies Record<PropertyDockSide, true>

const DOCK_SIDE_COVERAGE_KEYS = Object.keys(DOCK_SIDE_COVERAGE) as PropertyDockSide[]

/**
 * The EXACT key set each dock side may return. Sorted, because the assertion compares sorted
 * key lists — key order in the returned literal is not part of the contract, key membership is.
 */
const EXPECTED_RECLAIM_STYLE_KEYS = {
  left: ['marginRight', 'order'],
  right: ['marginLeft'],
  floating: [],
} as const satisfies Record<PropertyDockSide, readonly string[]>

/**
 * Requirement 3.6's prohibition, enumerated rather than gestured at. Every name below is a CSS
 * property (or vendor / custom-property spelling) that can move the dock vertically or displace
 * it through a transform. None of them may appear on the reclaim style for any dock side.
 */
const FORBIDDEN_VERTICAL_STYLE_KEYS = [
  // Vertical position
  'top', 'bottom', 'y', 'cy',
  'inset', 'insetBlock', 'insetBlockStart', 'insetBlockEnd',
  'offsetBlockStart', 'offsetBlockEnd',
  // Vertical box metrics
  'height', 'minHeight', 'maxHeight',
  'blockSize', 'minBlockSize', 'maxBlockSize',
  'marginTop', 'marginBottom', 'marginBlock', 'marginBlockStart', 'marginBlockEnd',
  'paddingTop', 'paddingBottom', 'paddingBlock', 'paddingBlockStart', 'paddingBlockEnd',
  // Displacement, in every spelling React accepts
  'transform', 'transformOrigin', 'translate', 'rotate', 'scale',
  'WebkitTransform', 'MozTransform', 'msTransform', 'OTransform',
  // Vertical alignment and grid placement
  'verticalAlign', 'alignSelf', 'alignItems', 'placeSelf',
  'rowGap', 'gridRow', 'gridRowStart', 'gridRowEnd',
  // The two custom properties this spec forbids by name
  '--portrait-dock-offset-y', '--portrait-dock-layout-reclaim',
] as const

/**
 * Backstop for the names the list above does not contain. Deliberately broad: none of the three
 * permitted keys (`order`, `marginRight`, `marginLeft`) matches it, so it can only fire on a key
 * that was added.
 */
const VERTICAL_KEY_PATTERN = /transform|translate|rotate|scale|top|bottom|height|vertical|block|row|inset|offset|align|^y$|^cy$/i

const RECLAIM_CATEGORY_COVERAGE = {
  zero: true,
  'positive-integer': true,
  'positive-fractional': true,
  'negative-integer': true,
  'negative-fractional': true,
  'very-large': true,
  nan: true,
  infinity: true,
  'negative-infinity': true,
} as const

type ReclaimCategory = keyof typeof RECLAIM_CATEGORY_COVERAGE

const RECLAIM_CATEGORIES = Object.keys(RECLAIM_CATEGORY_COVERAGE) as ReclaimCategory[]

/** The non-finite categories, whose observed output is reported rather than blessed. */
const NON_FINITE_RECLAIM_CATEGORIES: readonly ReclaimCategory[] = ['nan', 'infinity', 'negative-infinity']

/**
 * A reclaim value the resolver can be handed. `zero` and the negative categories exercise the
 * clamp; `very-large` exercises a reclaim far past any real dock width; the non-finite
 * categories exercise inputs the only call site cannot currently produce but the pure function
 * does not reject. Fractional draws always carry a real fraction, so the fractional coverage
 * counter below cannot be satisfied by an integer draw.
 */
function drawReclaim(rng: Rng, category: ReclaimCategory): number {
  switch (category) {
    case 'zero': return 0
    case 'positive-integer': return randomInt(rng, 1, 720)
    case 'positive-fractional': return randomInt(rng, 0, 719) + randomInt(rng, 1, 99) / 100
    case 'negative-integer': return -randomInt(rng, 1, 720)
    case 'negative-fractional': return -(randomInt(rng, 0, 719) + randomInt(rng, 1, 99) / 100)
    case 'very-large': return randomInt(rng, 1, 9) * 1e9 + randomInt(rng, 0, 999)
    case 'nan': return Number.NaN
    case 'infinity': return Number.POSITIVE_INFINITY
    case 'negative-infinity': return Number.NEGATIVE_INFINITY
    default: return assertNever(category)
  }
}

/**
 * Independent expected-margin model, written from Requirement 3.6's "the negative margin goes on
 * the dock's inner side" plus the clamp contract, in different terms from the source's single
 * `-Math.max(0, reclaim)` expression, so the property is not a restatement of the implementation.
 *
 * A non-positive reclaim yields `-0`, not `0`: negating a zero magnitude produces negative zero.
 * That distinction is asserted with `Object.is`, and the string React would emit for it (`0px`)
 * is asserted alongside, because `-0` is only harmless as long as it serializes that way.
 */
function expectedInnerMargin(reclaim: number): number {
  if (Number.isNaN(reclaim)) return Number.NaN
  if (reclaim <= 0) return -0
  return -reclaim
}

/** `toBe` distinguishes `-0` from `0` and equates `NaN` with `NaN`; both matter here. */
function expectExactNumber(actual: unknown, expected: number): void {
  expect(Object.is(actual, expected)).toBe(true)
}

describe('portrait dock side style mapping', () => {
  // Feature: portrait-dock-reload-anchoring, Property 8
  // For any Dock_Side value and any reclaim, the resolved style is defined, carries `order: -1`
  // only for `left`, applies the negative margin only on the dock's inner side — `margin-right`
  // for `left`, `margin-left` for `right`, neither for `floating` — and contains no transform,
  // no vertical property of any kind, and no vertical-offset custom property.
  // Validates: Requirements 3.6, 7.2
  test('Feature: portrait-dock-reload-anchoring, Property 8 — dock-side style mapping is total and inner-side only', () => {
    // The runtime draw set is exactly the type's members, so neither can drift from the other.
    expect([...DOCK_SIDES].sort()).toEqual([...DOCK_SIDE_COVERAGE_KEYS].sort())

    // Totality, stated directly before the randomized draws: every side returns an object.
    for (const side of DOCK_SIDES) {
      const style = resolveDockReclaimStyle(side, 0)
      expect(style).toBeDefined()
      expect(style).not.toBeNull()
      expect(typeof style).toBe('object')
    }

    const observedSides = new Set<PropertyDockSide>()
    const observedCategories = new Set<ReclaimCategory>()
    const observedCombinations = new Set<string>()
    const observedNonFiniteMargins: Record<string, string> = {}
    let observedZero = 0
    let observedPositive = 0
    let observedNegative = 0
    let observedFractional = 0
    let observedVeryLarge = 0
    let drawIndex = 0

    forAll(
      'Property 8',
      (rng) => {
        // Rotated on co-prime-enough strides: side cycles every draw and the category cycles
        // every third draw, so all 3 x 9 pairings are reached rather than a diagonal slice of
        // them. Drawn deterministically so a green run cannot be green because a side never met
        // a negative reclaim.
        const side = DOCK_SIDES[drawIndex % DOCK_SIDES.length] as PropertyDockSide
        const category = RECLAIM_CATEGORIES[Math.floor(drawIndex / DOCK_SIDES.length) % RECLAIM_CATEGORIES.length] as ReclaimCategory
        drawIndex += 1
        return { side, category, reclaim: drawReclaim(rng, category) }
      },
      ({ side, category, reclaim }) => {
        observedSides.add(side)
        observedCategories.add(category)
        observedCombinations.add(`${side}:${category}`)
        if (Object.is(reclaim, 0)) observedZero += 1
        if (reclaim > 0 && Number.isFinite(reclaim)) observedPositive += 1
        if (reclaim < 0) observedNegative += 1
        if (Number.isFinite(reclaim) && !Number.isInteger(reclaim)) observedFractional += 1
        if (Number.isFinite(reclaim) && Math.abs(reclaim) >= 1e9) observedVeryLarge += 1

        const style = resolveDockReclaimStyle(side, reclaim)

        // --- Totality -----------------------------------------------------
        // Every side, every reclaim, an object. Never `undefined`, never `null`.
        expect(style).toBeDefined()
        expect(style).not.toBeNull()
        expect(typeof style).toBe('object')

        const entries = style as Record<string, unknown>
        const keys = Object.keys(entries)

        // --- Exact key set ------------------------------------------------
        // Nothing more, nothing less. A future key of any name fails here.
        expect([...keys].sort()).toEqual([...EXPECTED_RECLAIM_STYLE_KEYS[side]].sort())

        // --- `order: -1` is a left-lane concern only -----------------------
        if (side === 'left') expect(entries.order).toBe(-1)
        else {
          expect('order' in entries).toBe(false)
          expect(entries.order).not.toBe(-1)
        }

        // --- Inner-side margin --------------------------------------------
        const expectedMargin = expectedInnerMargin(reclaim)
        switch (side) {
          case 'left': {
            // The dock sits in the left lane, so the chat is to its RIGHT.
            expect('marginRight' in entries).toBe(true)
            expect('marginLeft' in entries).toBe(false)
            expectExactNumber(entries.marginRight, expectedMargin)
            break
          }
          case 'right': {
            // The dock sits in the right lane, so the chat is to its LEFT.
            expect('marginLeft' in entries).toBe(true)
            expect('marginRight' in entries).toBe(false)
            expectExactNumber(entries.marginLeft, expectedMargin)
            break
          }
          case 'floating': {
            // A floating dock has no lane and therefore no gutter to reclaim.
            expect('marginLeft' in entries).toBe(false)
            expect('marginRight' in entries).toBe(false)
            expect(keys).toHaveLength(0)
            break
          }
          default: assertNever(side)
        }

        const margin = side === 'left'
          ? entries.marginRight
          : side === 'right' ? entries.marginLeft : undefined

        if (side !== 'floating') {
          if (Number.isFinite(reclaim)) {
            // Non-positive always: the margin pulls the dock into the gutter, never away.
            expect((margin as number) <= 0).toBe(true)
            if (reclaim <= 0) {
              // Clamped. `-0`, which React serializes as `0px` — asserted, not assumed.
              expectExactNumber(margin, -0)
              expect(`${margin as number}px`).toBe('0px')
            } else {
              expectExactNumber(margin, -reclaim)
            }
          } else {
            // OBSERVED, not required. Recorded and reported below rather than asserted here as
            // a contract, because no guard for it exists in the source.
            observedNonFiniteMargins[category] = String(margin)
          }
        }

        // --- No transform, no vertical anything ---------------------------
        // Requirement 3.6, in the requirement's own vocabulary. Vertical placement lives on
        // `dockStyle` as `top: panel.rect.y` and must never leak into the reclaim style.
        for (const forbidden of FORBIDDEN_VERTICAL_STYLE_KEYS) {
          expect(forbidden in entries).toBe(false)
          expect(Object.prototype.hasOwnProperty.call(entries, forbidden)).toBe(false)
        }
        // Backstop over the keys actually present, for names the list does not enumerate.
        for (const key of keys) {
          expect(VERTICAL_KEY_PATTERN.test(key)).toBe(false)
          // No custom property of any kind, so no token can carry an offset in by another name.
          expect(key.startsWith('--')).toBe(false)
        }
        // The two forbidden custom properties, named once more against the serialized object so
        // a nested or renamed spelling cannot hide from the key scan.
        const serialized = JSON.stringify(entries) ?? '{}'
        expect(serialized).not.toContain('--portrait-dock-offset-y')
        expect(serialized).not.toContain('--portrait-dock-layout-reclaim')
        expect(serialized.toLowerCase()).not.toContain('transform')
        expect(serialized.toLowerCase()).not.toContain('translate')
      },
    )

    // --- Input-space coverage ------------------------------------------
    // Without these the property could pass while never reaching a side or a reclaim shape.
    expect([...observedSides].sort()).toEqual([...DOCK_SIDES].sort())
    expect([...observedCategories].sort()).toEqual([...RECLAIM_CATEGORIES].sort())
    // All 3 sides x 9 reclaim categories, so every side met every reclaim shape.
    expect(observedCombinations.size).toBe(DOCK_SIDES.length * RECLAIM_CATEGORIES.length)
    expect(observedZero).toBeGreaterThan(0)
    expect(observedPositive).toBeGreaterThan(0)
    expect(observedNegative).toBeGreaterThan(0)
    expect(observedFractional).toBeGreaterThan(0)
    expect(observedVeryLarge).toBeGreaterThan(0)

    // --- Observed non-finite behavior, reported not blessed -------------
    // A non-finite reclaim propagates: `NaN` in gives `NaN` out, `+Infinity` in gives
    // `-Infinity` out, and `-Infinity` clamps to `-0` (serialized `0`). Neither `NaN` nor
    // `-Infinity` is a usable CSS length — React drops a `NaN` style with a warning — but
    // neither is reachable from the sole call site, which passes
    // `Math.round(getPortraitLayoutReclaim(...))` over finite state behind a `bodyWidth > 0`
    // guard. This records what the pure function does today. If a finite-input guard is ever
    // added to the source, this expectation changes with it; it is not a contract this test
    // invented on the source's behalf.
    expect(observedNonFiniteMargins).toEqual({
      'nan': 'NaN',
      'infinity': '-Infinity',
      'negative-infinity': '0',
    })
    expect(Object.keys(observedNonFiniteMargins).sort()).toEqual([...NON_FINITE_RECLAIM_CATEGORIES].sort())
  })

  // Requirement 7.2's compile-time gate and Requirement 3.6's "vertical placement stays on
  // `dockStyle`" clause are both source-SHAPE claims: no runtime call can observe whether a
  // `default` branch exists, and no returned object can show that `top: panel.rect.y` is still
  // the vertical mechanism. Both are asserted against the source text, the same technique the
  // stylesheet and topology tests above use.
  test('Feature: portrait-dock-reload-anchoring, Property 8 — the dock-side switch is exhaustive and vertical placement stays on dockStyle', async () => {
    const component = await Bun.file(resolve(import.meta.dir, 'PortraitDock.tsx')).text()

    const extracted = component.match(/export function resolveDockReclaimStyle\([\s\S]*?\n\}/)?.[0]
    expect(extracted).toBeDefined()
    const resolverSource = extracted as string

    // Requirement 7.2: the switch over Dock_Side terminates in the exhaustiveness guard, and
    // that guard is the LAST branch — a `case` added after it would be unreachable.
    expect(resolverSource).toMatch(/switch \(side\) \{/)
    expect(resolverSource).toContain('default: return assertNever(side)')
    const defaultIndex = resolverSource.indexOf('default: return assertNever(side)')
    expect(defaultIndex).toBeGreaterThan(resolverSource.lastIndexOf("case '"))
    expect(resolverSource.slice(defaultIndex)).not.toContain('case ')
    expect(component).toContain("import { assertNever } from '@/lib/assertNever'")

    // The clamp and the three inner-side branches, in the mapping the property asserts above.
    expect(resolverSource).toContain('const inset = -Math.max(0, reclaim)')
    expect(resolverSource).toMatch(/case 'left': return \{ order: -1, marginRight: inset \}/)
    expect(resolverSource).toMatch(/case 'right': return \{ marginLeft: inset \}/)
    expect(resolverSource).toMatch(/case 'floating': return \{\}/)

    // Requirement 3.6 at the source level: the resolver body is horizontal-only.
    expect(resolverSource).not.toMatch(/transform/i)
    expect(resolverSource).not.toMatch(/translate/i)
    expect(resolverSource).not.toContain('--portrait-dock-offset-y')
    expect(resolverSource).not.toMatch(/\btop\s*:/)
    expect(resolverSource).not.toMatch(/marginTop|marginBottom|\bbottom\s*:/)

    // `dockStyle` composes the resolver, with the persisted vertical offset still present,
    // unchanged, and immediately above it in the same docked branch.
    expect(component).toMatch(/top: panel\.rect\.y,\s*\.\.\.resolveDockReclaimStyle\(settings\.dockSide, layoutReclaim\),/)
    // The inline per-side ternaries the resolver replaced are gone from the style object.
    expect(component).not.toMatch(/marginRight:\s*-Math\.max/)
    expect(component).not.toMatch(/marginLeft:\s*-Math\.max/)
    // Neither forbidden custom property is written anywhere in the component.
    expect(component).not.toContain('--portrait-dock-offset-y')
    expect(component).not.toContain('--portrait-dock-layout-reclaim')
  })
})

// ---------------------------------------------------------------------------
// Property 10 support — saved non-default geometry survives image initialization
//
// WHAT THIS PROPERTY CLAIMS.
// `resolveDockedPortraitImageRect` is the one place a portrait image finishing initialization can
// resize the dock. Requirement 3.4 permits that fit-to-available sizing in exactly one situation:
// when `Canonical_Rect` still equals the untouched default portrait rectangle. For every other
// saved rectangle the saved width and height must come back out, and the fit size must be
// discarded. The randomized property below extends the single saved-size EXAMPLE in the
// `portrait dock placement` describe above (which is retained, unchanged) into that claim over
// randomized saved rects, fit sizes, dock sides, bounds, and viewports.
//
// HOW THE EXPECTED RESULT IS DERIVED, AND WHY IT IS NOT A RESTATEMENT OF THE SOURCE.
// `modelPlacedDockedRect` below is written from the placement contract in prose — side anchor at
// a 12 px viewport pad, extents clamped into the bounds, bounds themselves clamped into the
// viewport, origin clamped so the rect stays inside the viewport, negative coordinates floored at
// zero — and calls NOTHING from `PortraitDock.tsx`. It does not call
// `resolveDockedPortraitImageRect`, it does not call `placeDockedPortraitRect`, and it does not
// call `clampSurfaceRect`. The property never invokes the function under test twice and compares
// the two results against each other; the comparison is always against this model.
//
// WHERE THE TEETH ARE.
// The model is evaluated TWICE per iteration — once with the fit size and once with the saved
// size — and the property asserts the actual result matches the correct one AND differs from the
// other one whenever the two models disagree. `modelInvertedGateRect` names that other one
// explicitly: it is what the result would be if the gate were inverted (fit applied to
// non-default rects, saved size honoured for the default). Iterations where the two models
// disagree are counted, and the coverage block below requires that count to be positive, so a
// green run cannot be green because the fit size and the saved size happened to agree everywhere.
// The `fit-equals-saved-size` fit category deliberately generates the agreeing case as well, so
// both regimes are present rather than only the convenient one.
//
// SCOPE LIMITATION. This is arithmetic over the placement resolver. It says nothing about WHEN
// the component calls the resolver during image initialization, and nothing about rendered
// geometry; Requirement 3.3's "within 1 rendered CSS pixel" clause is runtime evidence (task 8.4).
// ---------------------------------------------------------------------------

/**
 * The dock sides `resolveDockedPortraitImageRect` actually accepts, taken from its own parameter
 * type so the input space cannot drift from the signature.
 *
 * NOTE ON `DOCK_SIDES`: the `Dock_Side` draw set declared with the Property 11 support above has
 * three members, because `Dock_Side` includes `floating`. This resolver's third parameter is
 * `'left' | 'right'` only — a floating portrait has no side anchor and never routes through
 * docked placement — so this property uses the narrower set and must NOT reuse `DOCK_SIDES`.
 */
type DockedDockSide = Parameters<typeof resolveDockedPortraitImageRect>[2]

/** Compile-time guard: a third docked side cannot appear without being added to the rotation. */
const DOCKED_DOCK_SIDE_COVERAGE = {
  left: true,
  right: true,
} as const satisfies Record<DockedDockSide, true>

const DOCKED_DOCK_SIDES = Object.keys(DOCKED_DOCK_SIDE_COVERAGE) as DockedDockSide[]

/** The resolver's own bounds and viewport parameter types, for the same drift reason. */
type DockedRectBounds = Parameters<typeof resolveDockedPortraitImageRect>[3]
type DockedViewport = Parameters<typeof resolveDockedPortraitImageRect>[4]

/**
 * The viewport pad the docked side anchor leaves, in layout px. Spelled as its own literal rather
 * than imported: `VIEWPORT_PAD` is module-private in `PortraitDock.tsx`, and a model that read it
 * would move together with the implementation instead of disagreeing with it.
 */
const MODEL_VIEWPORT_PAD = 12

/**
 * The placement contract, derived in prose above and implemented here without touching the
 * component. `savedY` is the persisted lane position, which docked placement always carries
 * through rather than recomputing.
 */
function modelPlacedDockedRect(
  size: Pick<SurfaceRectPrefs, 'width' | 'height'>,
  savedY: number,
  side: DockedDockSide,
  bounds: DockedRectBounds,
  viewport: DockedViewport,
): SurfaceRectPrefs {
  // Step 1 — the side anchor, computed from the size BEFORE the bounds clamp: `left` sits one pad
  // in from the left edge, `right` sits one pad in from the right edge but never left of the pad.
  const anchorX = side === 'left'
    ? MODEL_VIEWPORT_PAD
    : Math.max(MODEL_VIEWPORT_PAD, viewport.width - size.width - MODEL_VIEWPORT_PAD)

  // Step 2 — the box the rect has to live inside, never degenerate.
  const vw = Math.max(1, viewport.width)
  const vh = Math.max(1, viewport.height)

  // Step 3 — the extents: clamped into the bounds, and the bounds themselves clamped into the
  // viewport, because a dock can never be larger than the viewport it sits in.
  const minWidth = Math.min(Math.max(0, bounds.minWidth), vw)
  const minHeight = Math.min(Math.max(0, bounds.minHeight), vh)
  const maxWidth = Math.min(Math.max(minWidth, bounds.maxWidth ?? vw), vw)
  const maxHeight = Math.min(Math.max(minHeight, bounds.maxHeight ?? vh), vh)
  const width = Math.min(Math.max(minWidth, size.width), maxWidth)
  const height = Math.min(Math.max(minHeight, size.height), maxHeight)

  // Step 4 — the origin: negatives floor at zero, then the rect is pushed back inside the
  // viewport if the anchor or the saved lane position would hang it over an edge.
  const x = Math.min(Math.max(anchorX, 0), vw - width)
  const y = Math.min(Math.max(savedY, 0), vh - height)

  return { x, y, width, height }
}

/**
 * The negative control: what the resolver would return if Requirement 3.4's gate were INVERTED —
 * fit-to-available applied to saved non-default rects, and the saved size honoured for the
 * untouched default. The property asserts the actual result differs from this whenever the two
 * candidate sizes produce different placements.
 */
function modelInvertedGateRect(
  fitSize: Pick<SurfaceRectPrefs, 'width' | 'height'>,
  savedRect: SurfaceRectPrefs,
  side: DockedDockSide,
  bounds: DockedRectBounds,
  viewport: DockedViewport,
): SurfaceRectPrefs {
  const size = rectEqualsUntouchedDefault(savedRect) ? savedRect : fitSize
  return modelPlacedDockedRect(size, savedRect.y, side, bounds, viewport)
}

/**
 * Saved-rect shapes, rotated rather than sampled. The four `only-*-differs` members are the sharp
 * cases Requirement 3.4 turns on: each differs from the untouched default in EXACTLY ONE of the
 * four fields, so a gate that compared only the size (ignoring `x` and `y`), or only the origin
 * (ignoring `width` and `height`), or three fields out of four, fails on at least one of them.
 */
type SavedRectShape =
  | 'untouched-default'
  | 'only-x-differs'
  | 'only-y-differs'
  | 'only-width-differs'
  | 'only-height-differs'
  | 'two-fields-differ'
  | 'all-fields-differ'

const SAVED_RECT_SHAPE_COVERAGE = {
  'untouched-default': true,
  'only-x-differs': true,
  'only-y-differs': true,
  'only-width-differs': true,
  'only-height-differs': true,
  'two-fields-differ': true,
  'all-fields-differ': true,
} as const satisfies Record<SavedRectShape, true>

const SAVED_RECT_SHAPES = Object.keys(SAVED_RECT_SHAPE_COVERAGE) as SavedRectShape[]

/** The four single-field shapes, asserted reached individually by the coverage block. */
const SINGLE_FIELD_SAVED_RECT_SHAPES = [
  'only-x-differs',
  'only-y-differs',
  'only-width-differs',
  'only-height-differs',
] as const satisfies readonly SavedRectShape[]

/** A width inside the dock's own min/max that is guaranteed NOT to be the default width. */
function drawNonDefaultWidth(rng: Rng): number {
  const width = randomInt(rng, PORTRAIT_DOCK_MIN_WIDTH, 720)
  return width === DEFAULT_PORTRAIT_DOCK_SETTINGS.rect.width ? width + 1 : width
}

/** A height inside the dock's own min/max that is guaranteed NOT to be the default height. */
function drawNonDefaultHeight(rng: Rng): number {
  const height = randomInt(rng, PORTRAIT_DOCK_MIN_WIDTH, 860)
  return height === DEFAULT_PORTRAIT_DOCK_SETTINGS.rect.height ? height + 1 : height
}

function drawSavedRect(rng: Rng, shape: SavedRectShape): SurfaceRectPrefs {
  // Drawn from the same constant the component compares against, so the default case cannot
  // drift into "just another non-default rect".
  const defaultRect = DEFAULT_PORTRAIT_DOCK_SETTINGS.rect
  switch (shape) {
    case 'untouched-default': return { ...defaultRect }
    case 'only-x-differs': return { ...defaultRect, x: defaultRect.x + randomInt(rng, 1, 900) }
    case 'only-y-differs': return { ...defaultRect, y: defaultRect.y + randomInt(rng, 1, 700) }
    case 'only-width-differs': return { ...defaultRect, width: drawNonDefaultWidth(rng) }
    case 'only-height-differs': return { ...defaultRect, height: drawNonDefaultHeight(rng) }
    case 'two-fields-differ': return {
      ...defaultRect,
      y: defaultRect.y + randomInt(rng, 1, 700),
      width: drawNonDefaultWidth(rng),
    }
    case 'all-fields-differ': return {
      x: randomInt(rng, 1, 1200),
      y: randomInt(rng, 1, 700),
      width: drawNonDefaultWidth(rng),
      height: drawNonDefaultHeight(rng),
    }
    default: return assertNever(shape)
  }
}

/**
 * Fit sizes an initializing image can produce. `fit-equals-saved-size` and
 * `fit-equals-default-size` are the anti-coincidence categories: they make the fit size AGREE
 * with the size the property expects, so a passing run cannot be an accident of the two matching,
 * and the counted disagreement coverage below proves the other categories reach the discriminating
 * regime.
 */
type FitSizeCategory =
  | 'fit-equals-saved-size'
  | 'fit-equals-default-size'
  | 'independent'
  | 'larger-than-bounds'
  | 'smaller-than-bounds'

const FIT_SIZE_CATEGORY_COVERAGE = {
  'fit-equals-saved-size': true,
  'fit-equals-default-size': true,
  independent: true,
  'larger-than-bounds': true,
  'smaller-than-bounds': true,
} as const satisfies Record<FitSizeCategory, true>

const FIT_SIZE_CATEGORIES = Object.keys(FIT_SIZE_CATEGORY_COVERAGE) as FitSizeCategory[]

function drawFitSize(
  rng: Rng,
  category: FitSizeCategory,
  savedRect: SurfaceRectPrefs,
): Pick<SurfaceRectPrefs, 'width' | 'height'> {
  const defaultRect = DEFAULT_PORTRAIT_DOCK_SETTINGS.rect
  switch (category) {
    case 'fit-equals-saved-size': return { width: savedRect.width, height: savedRect.height }
    case 'fit-equals-default-size': return { width: defaultRect.width, height: defaultRect.height }
    case 'independent': return {
      width: randomInt(rng, PORTRAIT_DOCK_MIN_WIDTH, 720),
      height: randomInt(rng, PORTRAIT_DOCK_MIN_WIDTH, 860),
    }
    // Forces the extent clamp, so the "derives from the fit size" half of the claim is asserted
    // against a CLAMPED fit size rather than only against one that passes through untouched.
    case 'larger-than-bounds': return {
      width: randomInt(rng, 1000, 3000),
      height: randomInt(rng, 1000, 3000),
    }
    case 'smaller-than-bounds': return {
      width: randomInt(rng, 1, PORTRAIT_DOCK_MIN_WIDTH - 1),
      height: randomInt(rng, 1, PORTRAIT_DOCK_MIN_WIDTH - 1),
    }
    default: return assertNever(category)
  }
}

/**
 * 7 saved-rect shapes x 5 fit-size categories x 4 repeats. Every combination is reached exactly
 * four times, and the dock side rotates on a coprime cycle so every combination meets both sides.
 * Comfortably above the 100-iteration floor this spec sets, asserted below rather than assumed.
 */
const PROPERTY_10_ITERATIONS = SAVED_RECT_SHAPES.length * FIT_SIZE_CATEGORIES.length * 4

describe('portrait dock saved geometry across image initialization', () => {
  // Feature: portrait-dock-reload-anchoring, Property 10
  // For any saved Canonical_Rect that differs from the untouched default portrait rectangle, and
  // any fit size, docked image initialization preserves the saved width and height and applies
  // fit-to-available sizing only when the saved rectangle equals the default.
  // Validates: Requirements 3.4
  test('Feature: portrait-dock-reload-anchoring, Property 10 — saved non-default geometry survives image initialization', () => {
    expect(PROPERTY_10_ITERATIONS).toBeGreaterThanOrEqual(PROPERTY_ITERATIONS)
    // The narrower side set really is narrower than the full `Dock_Side` set, and `floating` is
    // absent from it. Asserted so a future widening of the resolver's signature surfaces here.
    expect([...DOCKED_DOCK_SIDES].sort()).toEqual(['left', 'right'])
    expect(DOCKED_DOCK_SIDES as readonly string[]).not.toContain('floating')
    expect(DOCK_SIDES.length).toBeGreaterThan(DOCKED_DOCK_SIDES.length)

    const observedShapes = new Set<SavedRectShape>()
    const observedFitCategories = new Set<FitSizeCategory>()
    const observedSides = new Set<DockedDockSide>()
    const observedCombinations = new Set<string>()
    let observedDefaultRects = 0
    let observedNonDefaultRects = 0
    let observedFitEqualledSavedSize = 0
    let observedDiscriminating = 0
    let observedSavedExtentsVerbatim = 0
    let observedWidthClamped = 0
    let observedYPreservedExactly = 0
    let observedYClamped = 0
    let observedRightEdgeAnchored = 0

    let drawIndex = 0

    forAll(
      'Property 10',
      (rng) => {
        // Deterministic rotation, so the four single-field-difference cases — the sharpest
        // inputs this property has — are each reached a fixed number of times rather than left to
        // the PRNG. `drawIndex % 2` over a 35-long combination cycle is coprime with it, so every
        // (shape, fit category) pair meets both dock sides.
        const shape = SAVED_RECT_SHAPES[drawIndex % SAVED_RECT_SHAPES.length] as SavedRectShape
        const fitCategory = FIT_SIZE_CATEGORIES[
          Math.floor(drawIndex / SAVED_RECT_SHAPES.length) % FIT_SIZE_CATEGORIES.length
        ] as FitSizeCategory
        const side = DOCKED_DOCK_SIDES[drawIndex % DOCKED_DOCK_SIDES.length] as DockedDockSide
        drawIndex += 1

        const savedRect = drawSavedRect(rng, shape)
        const fitSize = drawFitSize(rng, fitCategory, savedRect)

        // Viewports and bounds both narrow and generous, so the clamp branches are reached rather
        // than only the pass-through case.
        const viewport: DockedViewport = {
          width: randomInt(rng, 420, 2400),
          height: randomInt(rng, 320, 1400),
        }
        const bounds: DockedRectBounds = {
          minWidth: PORTRAIT_DOCK_MIN_WIDTH,
          minHeight: PORTRAIT_DOCK_MIN_WIDTH,
          maxWidth: randomInt(rng, 400, 900),
          maxHeight: randomInt(rng, 400, 1000),
        }

        return { shape, fitCategory, side, savedRect, fitSize, bounds, viewport }
      },
      ({ shape, fitCategory, side, savedRect, fitSize, bounds, viewport }) => {
        observedShapes.add(shape)
        observedFitCategories.add(fitCategory)
        observedSides.add(side)
        observedCombinations.add(`${shape}|${fitCategory}|${side}`)

        // The generator's own promise: only the `untouched-default` shape equals the default.
        const isDefault = rectEqualsUntouchedDefault(savedRect)
        expect(isDefault).toBe(shape === 'untouched-default')

        // The component's gate predicate agrees with the independent field-by-field comparison.
        // Asserted rather than assumed, because everything below is conditioned on it.
        expect(isDefaultPortraitRect(savedRect)).toBe(isDefault)

        if (isDefault) observedDefaultRects += 1
        else observedNonDefaultRects += 1
        if (fitSize.width === savedRect.width && fitSize.height === savedRect.height) {
          observedFitEqualledSavedSize += 1
        }

        const actual = resolveDockedPortraitImageRect(fitSize, savedRect, side, bounds, viewport)

        // The two candidate placements, both from the independent model.
        const fitApplied = modelPlacedDockedRect(fitSize, savedRect.y, side, bounds, viewport)
        const savedApplied = modelPlacedDockedRect(savedRect, savedRect.y, side, bounds, viewport)
        const expected = isDefault ? fitApplied : savedApplied

        // --- The gate itself ------------------------------------------------
        expect(actual).toEqual(expected)

        if (isDefault) {
          // Fit-to-available applied: the extents derive from the fit size.
          expect(actual.width).toBe(fitApplied.width)
          expect(actual.height).toBe(fitApplied.height)
        } else {
          // Fit-to-available did NOT apply: the extents come from the saved rect.
          expect(actual.width).toBe(savedApplied.width)
          expect(actual.height).toBe(savedApplied.height)
          // And when the saved extents are already inside the bounds, they come back verbatim —
          // the "266 x 832 stays 266 x 832" clause of Requirement 3.4, stated numerically.
          const savedFitsBounds = savedRect.width >= bounds.minWidth
            && savedRect.width <= Math.min(bounds.maxWidth ?? viewport.width, viewport.width)
            && savedRect.height >= bounds.minHeight
            && savedRect.height <= Math.min(bounds.maxHeight ?? viewport.height, viewport.height)
          if (savedFitsBounds) {
            observedSavedExtentsVerbatim += 1
            expect(actual.width).toBe(savedRect.width)
            expect(actual.height).toBe(savedRect.height)
          }
        }

        // Clamp coverage: the extent the gate SELECTED did not survive the bounds untouched.
        if (actual.width !== (isDefault ? fitSize.width : savedRect.width)) observedWidthClamped += 1

        // --- Teeth: the inverted gate produces a different answer -----------
        // Only assertable when the two candidate placements actually differ; when the fit size and
        // the saved size agree, no test could distinguish the two gates. The coverage block below
        // requires this branch to have been reached.
        const inverted = modelInvertedGateRect(fitSize, savedRect, side, bounds, viewport)
        if (fitApplied.width !== savedApplied.width || fitApplied.height !== savedApplied.height) {
          observedDiscriminating += 1
          expect(inverted).not.toEqual(expected)
          expect(actual).not.toEqual(inverted)
        } else {
          // Degenerate case, recorded rather than skipped silently: both gates agree here.
          expect(inverted).toEqual(expected)
        }

        // --- The saved lane position survives, subject to the same clamp ----
        const laneCeiling = Math.max(1, viewport.height) - actual.height
        expect(actual.y).toBe(Math.min(Math.max(savedRect.y, 0), laneCeiling))
        if (savedRect.y <= laneCeiling) {
          observedYPreservedExactly += 1
          expect(actual.y).toBe(savedRect.y)
        } else {
          observedYClamped += 1
          expect(actual.y).toBe(laneCeiling)
        }

        // --- The x coordinate is the side anchor, never the saved x ---------
        expect(actual.x).toBe(expected.x)
        if (side === 'left') {
          expect(actual.x).toBe(Math.min(MODEL_VIEWPORT_PAD, Math.max(1, viewport.width) - actual.width))
        } else if (
          actual.width === (isDefault ? fitSize.width : savedRect.width)
          && viewport.width - actual.width - MODEL_VIEWPORT_PAD >= MODEL_VIEWPORT_PAD
        ) {
          // Unclamped right anchor: the dock's outer edge sits exactly one pad in from the
          // viewport's right edge.
          observedRightEdgeAnchored += 1
          expect(actual.x + actual.width + MODEL_VIEWPORT_PAD).toBe(viewport.width)
        }
      },
      { iterations: PROPERTY_10_ITERATIONS },
    )

    // --- Input-space coverage ---------------------------------------------
    // Every one of these guards a way this property could pass while proving nothing.
    expect([...observedShapes].sort()).toEqual([...SAVED_RECT_SHAPES].sort())
    expect([...observedFitCategories].sort()).toEqual([...FIT_SIZE_CATEGORIES].sort())
    // Both dock sides reached.
    expect([...observedSides].sort()).toEqual([...DOCKED_DOCK_SIDES].sort())
    // Every shape met every fit category on both sides: 7 x 5 x 2.
    expect(observedCombinations.size)
      .toBe(SAVED_RECT_SHAPES.length * FIT_SIZE_CATEGORIES.length * DOCKED_DOCK_SIDES.length)
    // The default rect was reached, and so were non-default rects.
    expect(observedDefaultRects).toBeGreaterThan(0)
    expect(observedNonDefaultRects).toBeGreaterThan(0)
    // Each of the four single-field-difference cases was reached individually.
    for (const single of SINGLE_FIELD_SAVED_RECT_SHAPES) {
      expect(observedShapes.has(single)).toBe(true)
    }
    // At least one case where the fit size equalled the saved size, so a passing result cannot be
    // dismissed as the two never disagreeing...
    expect(observedFitEqualledSavedSize).toBeGreaterThan(0)
    // ...and many where they DID disagree, which is where the gate is observable at all.
    expect(observedDiscriminating).toBeGreaterThan(0)
    // The saved extents came back verbatim in the in-bounds case, and the clamp branch was also
    // reached, so the "derives from" claim was tested against both a passed-through and a clamped
    // extent.
    expect(observedSavedExtentsVerbatim).toBeGreaterThan(0)
    expect(observedWidthClamped).toBeGreaterThan(0)
    // The saved lane position was both preserved untouched and clamped.
    expect(observedYPreservedExactly).toBeGreaterThan(0)
    expect(observedYClamped).toBeGreaterThan(0)
    // The right-side anchor was exercised in its unclamped form.
    expect(observedRightEdgeAnchored).toBeGreaterThan(0)
  })

  test('Feature: portrait-dock-reload-anchoring, Property 10 — the fit-to-available gate is the default-rect comparison, in source', async () => {
    // The source half of the claim. A runtime call can show the resolver picks the saved size for
    // a non-default rect; that the CHOICE is gated on the untouched-default comparison over all
    // four fields is a claim about the source text, and Requirement 3.4 lives there.
    const component = await Bun.file(resolve(import.meta.dir, 'PortraitDock.tsx')).text()

    const gate = component.match(/export function isDefaultPortraitRect\([\s\S]*?\n\}/)?.[0]
    expect(gate).toBeDefined()
    const gateSource = gate as string

    // All four fields compared, against the shared default constant rather than literals.
    expect(gateSource).toContain('DEFAULT_PORTRAIT_DOCK_SETTINGS.rect')
    for (const field of CANONICAL_RECT_FIELDS) {
      expect(gateSource).toContain(`rect.${field} === defaultRect.${field}`)
    }

    const resolver = component.match(/export function resolveDockedPortraitImageRect\([\s\S]*?\n\}/)?.[0]
    expect(resolver).toBeDefined()
    const resolverSource = resolver as string

    // The gate decides the SIZE only, and the saved lane position is carried through unchanged.
    expect(resolverSource).toContain('const size = isDefaultPortraitRect(savedRect) ? fitSize : savedRect')
    expect(resolverSource).toContain('placeDockedPortraitRect(size, side, bounds, viewport, savedRect.y)')
    // Regression guard: the gate is not weakened to a size-only or origin-only comparison, and the
    // fit size is not applied unconditionally.
    expect(resolverSource).not.toMatch(/const size = fitSize/)
    expect(resolverSource).not.toMatch(/savedRect\.width === /)
  })
})
