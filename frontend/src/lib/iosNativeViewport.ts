import { isIOSFoldable, subscribeIOSLayout } from './ios-duo-layout'

/** Use the WKWebView's bounds, including the home-indicator area, instead of
 * WebKit viewport units that can exclude safe areas or resolve differently
 * under CSS zoom on older iOS releases.
 * These are scene dimensions, so rotation and iPad window resizing still work. */
export function subscribeIOSNativeViewport(onHeight: (height: number) => void): () => void {
  return subscribeIOSLayout(layout => {
    const root = document.documentElement
    root.style.setProperty('--ios-native-viewport-height', `${layout.height}px`)
    const foldable = isIOSFoldable(layout)
    root.toggleAttribute('data-ios-foldable', foldable)
    root.setAttribute('data-ios-hinge', layout.hingeStatus ?? 'unknown')
    // Composer alignment follows native side insets even with persistent
    // panes disabled, including on the folded outer display.
    const flatEdges = foldable ? (['left', 'right'] as const).filter(side => layout.safeArea[side] > 0) : []
    if (flatEdges.length) root.setAttribute('data-ios-composer-flat-edges', flatEdges.join(' '))
    else root.removeAttribute('data-ios-composer-flat-edges')
    onHeight(layout.height)
  })
}
