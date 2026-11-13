export interface HomepagePreviewImageFitInput {
  frameWidth: number
  naturalWidth: number
  naturalHeight: number
  availableHeight?: number
  preferredMaxHeight: number
  absoluteMaxHeight: number
}

export interface HomepagePreviewImageSize {
  width: number
  height: number
  aspectRatio: number
  stableWidth: number
}

export function getHomepagePreviewAvailableImageHeight(
  bodyHeight: number,
  metadataHeight: number,
  rowGap: number,
): number {
  return bodyHeight - metadataHeight - rowGap
}

export function getHomepagePreviewAvailableImageHeightWithGrowth(
  bodyHeight: number,
  metadataHeight: number,
  rowGap: number,
  previewHeight: number,
  maximumPreviewHeight: number,
): number {
  const remainingPanelGrowth = Number.isFinite(maximumPreviewHeight)
    ? Math.max(0, maximumPreviewHeight - previewHeight)
    : 0
  return getHomepagePreviewAvailableImageHeight(
    bodyHeight + remainingPanelGrowth,
    metadataHeight,
    rowGap,
  )
}

export function fitHomepagePreviewImageSize({
  frameWidth,
  naturalWidth,
  naturalHeight,
  availableHeight,
  preferredMaxHeight,
  absoluteMaxHeight,
}: HomepagePreviewImageFitInput): HomepagePreviewImageSize | null {
  if (frameWidth <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return null

  const aspectHeight = frameWidth * (naturalHeight / naturalWidth)
  const stableHeight = Math.min(aspectHeight, preferredMaxHeight, absoluteMaxHeight)
  const limits = [stableHeight]
  if (availableHeight !== undefined) limits.push(Math.max(1, availableHeight))

  const height = Math.max(1, Math.floor(Math.min(...limits)))
  const aspectRatio = naturalWidth / naturalHeight
  const width = scaleHomepagePreviewImageWidth(height, aspectRatio, frameWidth)
  const stableWidth = scaleHomepagePreviewImageWidth(stableHeight, aspectRatio, frameWidth)
  return { width, height, aspectRatio, stableWidth }
}

export function scaleHomepagePreviewImageWidth(
  height: number,
  aspectRatio: number,
  maxWidth: number,
): number {
  return Math.max(1, Math.floor(Math.min(maxWidth, height * aspectRatio)))
}

export interface HomepagePreviewPaneWidthInput {
  imageWidth: number | null
  metadataMinWidth: number
  chromeWidth: number
  manualMaxWidth: number
}

export function fitHomepagePreviewPaneWidth({
  imageWidth,
  metadataMinWidth,
  chromeWidth,
  manualMaxWidth,
}: HomepagePreviewPaneWidthInput): number {
  if (imageWidth === null) return manualMaxWidth
  const desiredContentWidth = Math.max(metadataMinWidth, imageWidth)
  return Math.min(manualMaxWidth, Math.ceil(desiredContentWidth + Math.max(0, chromeWidth)))
}

export interface HomepagePreviewStableFrameWidthInput {
  panelMaxWidth: number
  layoutViewportWidth: number
  gutter: number
  chromeWidth: number
}

export function getHomepagePreviewStableFrameWidth({
  panelMaxWidth,
  layoutViewportWidth,
  gutter,
  chromeWidth,
}: HomepagePreviewStableFrameWidthInput): number {
  const paneWidth = Math.min(panelMaxWidth, Math.max(1, layoutViewportWidth - gutter))
  return Math.max(1, paneWidth - Math.max(0, chromeWidth))
}
