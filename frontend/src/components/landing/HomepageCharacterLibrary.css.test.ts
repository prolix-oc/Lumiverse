import { describe, expect, test } from 'bun:test'

function selectorBlock(css: string, selector: string): string {
  const normalizedCss = css.replace(/\r\n/g, '\n')
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = normalizedCss.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm'))
  expect(match, `expected ${selector} CSS rule to exist`).not.toBeNull()
  return match![1]
}

function atRuleBlock(css: string, prelude: string): string {
  const start = css.indexOf(prelude)
  expect(start, `expected ${prelude} CSS at-rule to exist`).toBeGreaterThanOrEqual(0)

  const openingBrace = css.indexOf('{', start)
  let depth = 0
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(openingBrace + 1, index)
  }

  throw new Error(`expected ${prelude} CSS at-rule to close`)
}

function closingDivAfterOpeningDiv(source: string, className: string): number {
  const openingDiv = new RegExp(`<div\\b[^>]*className=\\{styles\\.${className}\\}[^>]*>`, 'm').exec(source)
  expect(openingDiv, `expected ${className} wrapper to exist`).not.toBeNull()

  const divToken = /<div\b[^>]*>|<\/div>/g
  divToken.lastIndex = openingDiv!.index
  let depth = 0
  for (let token = divToken.exec(source); token; token = divToken.exec(source)) {
    depth += token[0] === '</div>' ? -1 : 1
    if (depth === 0) return token.index
  }

  throw new Error(`expected ${className} wrapper to close`)
}

describe('HomepageCharacterLibrary preview overflow contract', () => {
  test('keeps preview content width-contained and vertically scrollable', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const previewBody = selectorBlock(css, '.previewBody')

    expect(previewBody).toMatch(/min-width:\s*0/)
    expect(previewBody).toMatch(/max-width:\s*100%/)
    expect(previewBody).toMatch(/min-height:\s*0/)
    expect(previewBody).toMatch(/align-content:\s*start/)
    expect(previewBody).toMatch(/overflow-y:\s*auto/)
    expect(previewBody).toMatch(/overflow-x:\s*hidden/)
    expect(previewBody).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  test('keeps mobile cards in two constrained fluid columns', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const mobile = atRuleBlock(css, '@media (max-width: 760px)')
    const mobileLibrary = selectorBlock(mobile, '.library')
    const mobileGrid = selectorBlock(mobile, ".grid[data-view-mode='grid']")
    const mobileCardImages = selectorBlock(
      mobile,
      ".grid[data-view-mode='grid'] .imageFrame,\n  .grid[data-view-mode='single'] .imageFrame",
    )
    const gridState = selectorBlock(css, '.grid > .state')

    expect(mobileLibrary).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(mobileLibrary).toMatch(/min-width:\s*0/)
    expect(mobileGrid).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(mobileCardImages).toMatch(/height:\s*min\(var\(--character-image-height,\s*226px\),\s*62vw\)/)
    expect(mobile).not.toMatch(/(?:^|\n)\s*\.imageFrame\s*\{/)
    expect(gridState).toMatch(/grid-column:\s*1\s*\/\s*-1/)
    expect(gridState).toMatch(/min-width:\s*0/)
  })

  test('reserves the fitted pinned pane width beside the character grid', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const openBody = selectorBlock(css, ".body[data-panel-open='true']")

    expect(openBody).toMatch(/--homepage-preview-layout-width/)
    expect(openBody).not.toMatch(/minmax\(360px/)
    expect(openBody).not.toMatch(/44vw/)
    expect(openBody).toMatch(/100vw\s*\/\s*var\(--lumiverse-ui-scale/)
    expect(openBody).toMatch(/minmax\(0,/)
  })

  test('supports single and compact horizontal list card layouts', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const single = selectorBlock(css, ".grid[data-view-mode='single'],\n.grid[data-view-mode='list']")
    const listCard = selectorBlock(css, ".grid[data-view-mode='list'] .card,\n.grid[data-view-mode='list'] .cardSelected")
    const listFooter = selectorBlock(css, ".grid[data-view-mode='list'] .cardFooter,\n.grid[data-view-mode='list'] .card[data-footer-mode='compact'] .cardFooter,\n.grid[data-view-mode='list'] .cardSelected[data-footer-mode='compact'] .cardFooter")

    expect(single).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(listCard).toMatch(/flex-direction:\s*row/)
    expect(listFooter).toMatch(/position:\s*static/)
    expect(listFooter).toMatch(/max-height:\s*none/)
  })

  test('renders description metadata and wires the selected view mode', async () => {
    const [css, tsx] = await Promise.all([
      Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text(),
      Bun.file(new URL('./HomepageCharacterLibrary.tsx', import.meta.url)).text(),
    ])
    const description = selectorBlock(css, '.cardDescription')

    expect(tsx).toMatch(/showDescription=\{showDescription\}/)
    expect(tsx).toMatch(/showDescription && character\.preview_description/)
    expect(tsx).toMatch(/data-view-mode=\{display\.viewMode\}/)
    expect(tsx).toMatch(/descriptionMaxHeight = showDescription \? 36 : 0/)
    expect(tsx).toMatch(/compactFooterMaxHeight = 44 \+ descriptionMaxHeight \+ tagRowsMaxHeight/)
    expect(description).toMatch(/-webkit-line-clamp:\s*2/)
  })

  test('keeps the preview image in natural-aspect flow without a blurred duplicate', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const previewFrame = selectorBlock(css, '.previewImageFrame')
    const previewImage = selectorBlock(css, '.previewImageFrame > img')

    expect(css).not.toMatch(/\.previewImageFrame::before/)
    expect(previewFrame).toMatch(/height:\s*auto/)
    expect(previewFrame).toMatch(/width:\s*min\(100%,\s*var\(--homepage-preview-image-width,\s*100%\)\)/)
    expect(previewFrame).toMatch(/margin-inline:\s*auto/)
    expect(previewImage).toMatch(/position:\s*relative/)
    expect(previewImage).toMatch(/width:\s*100% !important/)
    expect(previewImage).toMatch(/height:\s*auto !important/)
  })

  test('fits each image from intrinsic dimensions and the remaining metadata space', async () => {
    const tsx = await Bun.file(new URL('./HomepageCharacterLibrary.tsx', import.meta.url)).text()

    expect(tsx).toMatch(/fitHomepagePreviewImageSize\(\{/)
    expect(tsx).toMatch(/const requestedImageHeight = liveImageHeight \?\? preferredImageHeight/)
    expect(tsx).toMatch(/const panelImageHeight = autoImageSize\?\.height \?\? requestedImageHeight/)
    expect(tsx).toMatch(/scaleHomepagePreviewImageWidth\(panelImageHeight, autoImageSize\.aspectRatio, autoImageSize\.width\)/)
    expect(tsx).toMatch(/frameWidth:\s*constrained \? stableFrameWidth : \(body\.clientWidth \|\| frame\.clientWidth\)/)
    expect(tsx).toMatch(/const viewportWidth = layoutViewportSize\(\)\.width/)
    expect(tsx).toMatch(/getHomepagePreviewStableFrameWidth\(\{/)
    expect(tsx).toMatch(/imageWidth: autoImageSize\?\.stableWidth \?\? null/)
    expect(tsx).toMatch(/previewStyle\.paddingLeft/)
    expect(tsx).not.toMatch(/previewElement\.offsetWidth - body\.clientWidth/)
    expect(tsx).toMatch(/--homepage-preview-auto-width': `\$\{previewAutoWidth\}px`/)
    expect(tsx).toMatch(/--homepage-preview-layout-width': `\$\{settings\.panelPinned \? previewAutoWidth : panelWidth\}px`/)
    expect(tsx).toMatch(/naturalWidth:\s*image\.naturalWidth/)
    expect(tsx).toMatch(/naturalHeight:\s*image\.naturalHeight/)
    expect(tsx).toMatch(/preferredMaxHeight:\s*requestedImageHeight/)
    expect(tsx).toMatch(/const maximumPreviewHeight = Number\.parseFloat\(previewStyle\.maxHeight\)/)
    expect(tsx).toMatch(/const bodyHeight = body\.getBoundingClientRect\(\)\.height/)
    expect(tsx).toMatch(/const metadataHeight = metadata\.getBoundingClientRect\(\)\.height/)
    expect(tsx).toMatch(/const previewHeight = previewElement\.getBoundingClientRect\(\)\.height/)
    expect(tsx).toMatch(/getHomepagePreviewAvailableImageHeightWithGrowth\(/)
    expect(tsx).not.toMatch(/rowGap\s*-\s*2/)
    expect(tsx).toMatch(/observer\?\.observe\(previewBodyRef\.current\)/)
    expect(tsx).toMatch(/observer\?\.observe\(previewMetadataRef\.current\)/)
    expect(tsx).toMatch(/onLoad=\{fitPreviewImage\}/)
    expect(tsx).toMatch(/--homepage-preview-image-width': panelImageWidth \? `\$\{panelImageWidth\}px` : '100%'/)
    expect(tsx).toMatch(/min=\{HOMEPAGE_PANEL_IMAGE_HEIGHT_MIN\}/)
    expect(tsx).toMatch(/max=\{HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX\}/)
    expect(tsx).toMatch(/value=\{requestedImageHeight\}/)
    expect(tsx).toMatch(/<span>\{requestedImageHeight\}px<\/span>/)
    expect(tsx).toMatch(/onPointerUp=\{\(event\) => commitImageHeight\(Number\(event\.currentTarget\.value\)\)\}/)
    expect(tsx).toMatch(/onKeyUp=\{\(event\) => commitImageHeight\(Number\(event\.currentTarget\.value\)\)\}/)
    expect(tsx).toMatch(/onBlur=\{\(event\) => commitImageHeight\(Number\(event\.currentTarget\.value\)\)\}/)
    expect(tsx).toMatch(/setPanelImageHeight\(committedHeight\)[\s\S]*setLiveImageHeight\(null\)/)
    expect(tsx).not.toMatch(/setLiveImageHeight\(null\)\s*\}, \[selectedAvatarUrl\]\)/)
  })

  test('gates every preview metadata section and renders the selected description', async () => {
    const tsx = await Bun.file(new URL('./HomepageCharacterLibrary.tsx', import.meta.url)).text()

    expect(tsx).toMatch(/showCreator && selectedCharacter\.creator/)
    expect(tsx).toMatch(/showDescription && selectedDescription/)
    expect(tsx).toMatch(/showTags && selectedTagSummary\.visibleTags\.map/)
    expect(tsx).toMatch(/showLorebooks && \(/)
    expect(tsx).toMatch(/showLastChat && \(/)
    expect(tsx).toMatch(/className=\{styles\.previewDescription\}/)
    expect(tsx).toMatch(/previewLoading && \(showLorebooks \|\| showLastChat\)/)
  })

  test('opens the mobile preview as a bounded viewport overlay', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const mobile = atRuleBlock(css, '@media (max-width: 760px)')
    const mobileBody = selectorBlock(mobile, '.body')
    const mobileOpenBody = selectorBlock(mobile, ".body[data-panel-open='true']")
    const mobilePreview = selectorBlock(mobile, '.preview[data-pinned]')
    const mobileBackdrop = selectorBlock(mobile, '.previewBackdrop')
    const mobileGlow = selectorBlock(mobile, '.previewBackdropGlow')
    const mobileViewportLayer = selectorBlock(mobile, '.previewBackdropViewportLayer')
    const mobileGridLayer = selectorBlock(mobile, '.preview[data-pinned]::after')
    const mobileControls = selectorBlock(mobile, '.previewControls')

    expect(mobileBody).toMatch(/min-width:\s*0/)
    expect(mobileBody).toMatch(/width:\s*100%/)
    expect(mobileBody).toMatch(/overflow:\s*hidden/)
    expect(mobileOpenBody).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(mobilePreview).toMatch(/position:\s*fixed/)
    expect(mobilePreview).toMatch(/inset-block-start:\s*calc\(64px\s*\+\s*env\(safe-area-inset-top\)\)/)
    expect(mobilePreview).toMatch(/inset-block-end:\s*auto/)
    expect(mobilePreview).toMatch(/left:\s*50%/)
    expect(mobilePreview).toMatch(/right:\s*auto/)
    expect(mobilePreview).toMatch(/--homepage-preview-auto-width/)
    expect(mobilePreview).toMatch(/calc\(\(100vw\s*\/\s*var\(--lumiverse-ui-scale,\s*1\)\)\s*-\s*24px\)/)
    expect(mobilePreview).toMatch(/transform:\s*translateX\(-50%\)/)
    expect(mobilePreview).not.toMatch(/^\s*(?:height|min-height):/m)
    expect(mobilePreview).toMatch(/max-height:\s*calc\(100dvh\s*-\s*76px\s*-\s*env\(safe-area-inset-top\)\s*-\s*env\(safe-area-inset-bottom\)\)/)
    expect(mobilePreview).toMatch(/background-color:\s*var\(--lumiverse-bg-deep,\s*#0a0812\)/)
    expect(mobilePreview).not.toMatch(/--homepage-preview-page-/)
    expect(mobilePreview).not.toMatch(/60px\s+60px/)
    expect(mobilePreview).not.toMatch(/--lumiverse-primary-010/)
    expect(mobileGridLayer).toMatch(/background-image:\s*var\(--homepage-preview-grid-image,\s*none\)/)
    expect(mobileGridLayer).toMatch(/background-size:\s*var\(--homepage-preview-grid-size,\s*auto\)/)
    expect(mobileGridLayer).toMatch(/opacity:\s*var\(--homepage-preview-grid-opacity,\s*0\)/)
    expect(mobileGridLayer).not.toMatch(/60px\s+60px/)
    expect(mobileGridLayer).not.toMatch(/--lumiverse-primary-010/)
    expect(mobileBackdrop).toMatch(/position:\s*absolute/)
    expect(mobileBackdrop).toMatch(/overflow:\s*hidden/)
    expect(mobileGlow).toMatch(/position:\s*absolute/)
    expect(mobileViewportLayer).toMatch(/position:\s*absolute/)
    expect(mobileViewportLayer).toMatch(/pointer-events:\s*none/)
    expect(mobilePreview).toMatch(/isolation:\s*isolate/)
    expect(mobilePreview).toMatch(/overflow:\s*hidden/)
    expect(mobileControls).toMatch(/position:\s*relative/)
    expect(mobileControls).toMatch(/z-index:\s*10/)
  })

  test('gives preview controls explicit accessible names and keyboard focus styling', async () => {
    const [css, tsx, landingTsx] = await Promise.all([
      Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text(),
      Bun.file(new URL('./HomepageCharacterLibrary.tsx', import.meta.url)).text(),
      Bun.file(new URL('./LandingPage.tsx', import.meta.url)).text(),
    ])
    const focusStyle = selectorBlock(css, '.previewControls button:focus-visible')

    expect(tsx).toMatch(/aria-label=\{settings\.panelPinned \? 'Unpin preview' : 'Pin preview'\}/)
    expect(tsx).toMatch(/aria-label="Close preview"/)
    expect(tsx).toMatch(/role=\{isMobileViewport \? 'dialog' : undefined\}/)
    expect(tsx).toMatch(/aria-modal=\{isMobileViewport \|\| undefined\}/)
    expect(tsx).toMatch(/window\.getComputedStyle\(document\.documentElement\)/)
    expect(tsx).toMatch(/window\.getComputedStyle\(document\.body, '::before'\)/)
    expect(tsx).toMatch(/window\.getComputedStyle\(document\.body, '::after'\)/)
    expect(tsx).toMatch(/document\.querySelector<HTMLElement>\('\[data-landing-background-grid\]'\)/)
    expect(tsx).toMatch(/className=\{styles\.previewBackdropViewportLayer\}/)
    expect(tsx).toMatch(/mixBlendMode:\s*layer\.mixBlendMode/)
    expect(tsx).toMatch(/--homepage-preview-grid-image': pageBackground\.gridImage/)
    expect(tsx).toMatch(/data-landing-background-glow/)
    expect(tsx).toMatch(/className=\{styles\.previewBackdrop\}/)
    expect(landingTsx).toMatch(/data-landing-background-glow/)
    expect(landingTsx).toMatch(/data-landing-background-grid/)
    expect(tsx).not.toMatch(/homepage-preview-(?:stars|nebula)/)
    expect(tsx).toMatch(/aria-labelledby=\{isMobileViewport \? 'homepage-character-preview-title' : undefined\}/)
    expect(tsx).toMatch(/isMobileViewport && event\.key === 'Escape'/)
    expect(tsx).toMatch(/closePreviewButtonRef\.current\?\.focus\(\)/)
    expect(focusStyle).toMatch(/outline:\s*2px\s+solid\s+var\(--lumiverse-primary\)/)
  })

  test('prevents the image intrinsic width from expanding the preview body grid', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const imageFrame = selectorBlock(css, '.previewImageFrame')

    expect(imageFrame).toMatch(/width:\s*min\(100%,\s*var\(--homepage-preview-image-width,\s*100%\)\)/)
    expect(imageFrame).toMatch(/min-width:\s*0/)
    expect(imageFrame).toMatch(/max-width:\s*100%/)
  })

  test('keeps the outer preview clipped and reserves space for its bottom action', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const preview = selectorBlock(css, '.preview')

    expect(preview).toMatch(/overflow:\s*hidden/)
    expect(preview).toMatch(/padding(?:-bottom)?:[^;]*(?:62px|var\(--homepage-preview-action-clearance)/)
  })

  test('uses UI-scale-compensated viewport width for pinned preview clearance', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const pinnedPreview = selectorBlock(css, ".preview[data-pinned='true']")

    expect(pinnedPreview).toMatch(
      /width:\s*min\([^;]*calc\(\(100vw\s*\/\s*var\(--lumiverse-ui-scale,\s*1\)\)\s*-\s*48px\)\s*\)/,
    )
    expect(pinnedPreview).toMatch(/--homepage-preview-auto-width/)
    expect(pinnedPreview).toMatch(/bottom:\s*auto/)
    expect(pinnedPreview).not.toMatch(/^\s*(?:height|min-height):/m)
    expect(pinnedPreview).toMatch(/max-height:\s*calc\(100dvh\s*-\s*126px\)/)
  })

  test('uses a shrinkable content column for the preview grid', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const preview = selectorBlock(css, '.preview')

    expect(preview).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  test('keeps the image height control within its preview width', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const imageHeightControl = selectorBlock(css, '.imageHeightControl')

    expect(imageHeightControl).toMatch(/min-width:\s*0/)
    expect(imageHeightControl).toMatch(/max-width:\s*100%/)
  })

  test('allows the image height input to shrink within its available width', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const imageHeightInput = selectorBlock(css, '.imageHeightControl input')

    expect(imageHeightInput).toMatch(/min-width:\s*0/)
    expect(imageHeightInput).toMatch(/width:\s*100%/)
    expect(imageHeightInput).toMatch(/max-width:\s*100%/)
  })

  test('ellipsizes long preview names and creator text', async () => {
    const css = await Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text()
    const headerText = css.match(/\.previewHeader h3,\s*\.previewHeader p\s*\{([\s\S]*?)\n\}/m)?.[1]

    expect(headerText, 'expected shared preview title and creator rule to exist').toBeDefined()
    expect(headerText).toMatch(/overflow:\s*hidden/)
    expect(headerText).toMatch(/text-overflow:\s*ellipsis/)
    expect(headerText).toMatch(/white-space:\s*nowrap/)
  })

  test('keeps the chat action separately positioned outside the scroll body', async () => {
    const [css, tsx] = await Promise.all([
      Bun.file(new URL('./HomepageCharacterLibrary.module.css', import.meta.url)).text(),
      Bun.file(new URL('./HomepageCharacterLibrary.tsx', import.meta.url)).text(),
    ])
    const openChatButton = selectorBlock(css, '.openChatBtn')

    expect(openChatButton).toMatch(/position:\s*absolute/)
    expect(openChatButton).toMatch(/inset:\s*auto\s+12px\s+12px/)
    expect(tsx).toMatch(/className=\{styles\.previewBody\}/)
    expect(tsx).toMatch(/className=\{styles\.openChatBtn\}/)
    expect(tsx.indexOf('className={styles.openChatBtn}')).toBeGreaterThan(
      closingDivAfterOpeningDiv(tsx, 'previewBody'),
    )
  })
})
