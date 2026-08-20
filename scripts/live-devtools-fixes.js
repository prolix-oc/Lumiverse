(() => {
  'use strict';

  const SCRIPT_ID = 'lumiverse-quicktoolbar-livefix';

  // 1. Cleanup any previous execution
  if (window.__LUMIVERSE_QUICKTOOLBAR_LIVEFIX__) {
    try {
      window.__LUMIVERSE_QUICKTOOLBAR_LIVEFIX__.cleanup();
    } catch (e) {
      console.warn('[QuickToolbar LiveFix] Cleanup warning:', e);
    }
  }

  // 2. Inject Persistent CSS Engine
  const styleEl = document.createElement('style');
  styleEl.id = SCRIPT_ID;
  styleEl.textContent = `
    /* =========================================================
       1. CHAT TOP DOCK: FULL WIDTH FILL & SEAMLESS SPAN
       ========================================================= */
    [class*="_chatToolbar_"][data-spindle-mount="chat_top_dock"],
    [data-spindle-mount="chat_top_dock"],
    [class*="_chatToolbar_"] {
      display: flex !important;
      justify-content: flex-start !important;
      align-items: center !important;
      width: 100% !important;
      max-width: 100% !important;
      gap: 6px !important;
    }

    /* Anchored QuickToolbar Root: Stretch across full dock slot */
    [data-component="QuickToolbar"][data-quick-toolbar-placement="chat_top_dock"],
    [data-component="QuickToolbar"][data-quick-toolbar-dock="chat_top_dock"] {
      flex: 1 1 auto !important;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      margin: 0 !important;
      display: flex !important;
      justify-content: flex-start !important;
      align-items: center !important;
      align-self: center !important;
    }

    /* Anchored Nav & Card Strip: Span 100% so background fills the dock */
    [data-component="QuickToolbar"][data-quick-toolbar-placement="chat_top_dock"] > nav,
    [data-component="QuickToolbar"][data-quick-toolbar-placement="chat_top_dock"] [class*="_toolbarAnchored_"],
    [data-component="QuickToolbar"][data-quick-toolbar-placement="chat_top_dock"] [class*="_cardStrip_"] {
      width: 100% !important;
      max-width: 100% !important;
      flex: 1 1 auto !important;
      justify-content: flex-start !important;
      margin: 0 !important;
    }

    /* =========================================================
       2. CARD SCROLLER: FLEX & 6PX UNIFORM RHYTHM
       ========================================================= */
    [data-component="QuickToolbar"] [class*="_cardScroller_"] {
      flex: 0 1 auto !important;
      min-width: 0 !important;
      max-width: 100% !important;
      width: max-content !important;
      gap: 6px !important;
    }

    [data-component="QuickToolbar"] [class*="_cardStrip_"] {
      gap: 6px !important;
    }

    /* =========================================================
       3. SPINDLE EMPTY MOUNT COLLAPSE (ZERO GHOST SPACING)
       ========================================================= */
    [data-spindle-mount="chat_top_dock"] > [data-spindle-extension-root]:not(:has(button, a, input, select, textarea, [role="button"], svg, img, canvas, [data-toolbar-action], [data-component])),
    [data-spindle-mount] > [data-spindle-extension-root]:empty,
    [data-spindle-mount] > [data-spindle-extension-root]:not(:has(*)) {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      flex: 0 0 0 !important;
      pointer-events: none !important;
    }

    [data-spindle-mount="chat_top_dock"] [data-spindle-host-surface="quick_toolbar.workspace"]:not(:has(button, a, input, select, textarea, [role="button"], svg, img, canvas, [data-toolbar-action], [data-component])) {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      flex: 0 0 0 !important;
    }

    /* =========================================================
       4. ELIMINATE FILL DOCK SPACER (HUG CARDS + OVERFLOW + GEAR)
       ========================================================= */
    [data-component="QuickToolbar"] [class*="_fillDockSpacer_"],
    [data-component="QuickToolbar"] ._fillDockSpacer_10rdb_191,
    [data-component="QuickToolbar"] nav > div[aria-hidden="true"]:not([class*="_card_"]):not([class*="_cardSlot_"]):not([class*="_item_"]) {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      flex: 0 0 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* =========================================================
       5. FLOATING V2: 100VW FULL BLEED (FILL ON ONLY)
       ========================================================= */
    [data-component="QuickToolbar"][class*="rootFree"][data-fill-screen="1"] {
      left: 0px !important;
      width: 100vw !important;
      max-width: 100vw !important;
      margin: 0px !important;
      --quick-toolbar-x: 0px !important;
      --quick-toolbar-width: 100vw !important;
    }

    [data-component="QuickToolbar"][class*="rootFree"][data-fill-screen="1"] > nav {
      width: 100vw !important;
      max-width: 100vw !important;
      border-radius: 0px !important;
      border-left: none !important;
      border-right: none !important;
      justify-content: flex-start !important;
    }

    /* =========================================================
       6. FLOATING V2: CONTENT HUGGING (AUTO-FIT ON & FILL OFF)
       ========================================================= */
    [data-component="QuickToolbar"][class*="rootFree"][data-autofit="1"]:not([data-fill-screen="1"]) {
      left: 0px !important;
      width: max-content !important;
      max-width: 100vw !important;
      --quick-toolbar-x: 0px !important;
    }

    [data-component="QuickToolbar"][class*="rootFree"][data-autofit="1"]:not([data-fill-screen="1"]) > nav {
      width: max-content !important;
      max-width: 100% !important;
      justify-content: flex-start !important;
    }
  `;

  document.head.appendChild(styleEl);

  // Helper: Extract quickToolbarSettings from React Fiber
  function getToolbarSettingsFromFiber(el) {
    if (!el) return null;
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    let fiber = el[fiberKey];
    while (fiber && (!fiber.memoizedState || !fiber.type || typeof fiber.type !== 'function')) {
      fiber = fiber.return;
    }
    if (!fiber) return null;
    let s = fiber.memoizedState;
    while (s) {
      if (s.memoizedState && typeof s.memoizedState === 'object' && 'quickToolbarPlacement' in s.memoizedState) {
        return s.memoizedState;
      }
      s = s.next;
    }
    return null;
  }

  // 3. DOM Reconciler Function
  function reconcileQuickToolbar() {
    // 3A. Spindle Ghost Extensions
    const spindleRoots = document.querySelectorAll(
      '[data-spindle-mount="chat_top_dock"] > [data-spindle-extension-root]'
    );
    for (const root of spindleRoots) {
      const hasInteractive = root.querySelector(
        'button, a, input, select, textarea, [role="button"], svg, img, canvas, [data-toolbar-action], [data-component]'
      );
      if (!hasInteractive) {
        root.style.setProperty('display', 'none', 'important');
        root.style.setProperty('width', '0', 'important');
        root.style.setProperty('height', '0', 'important');
        root.style.setProperty('flex', '0 0 0', 'important');
        root.style.setProperty('margin', '0', 'important');
        root.style.setProperty('padding', '0', 'important');
      } else {
        root.style.removeProperty('display');
        root.style.removeProperty('width');
      }
    }

    // 3B. QuickToolbar Components & Mode Synchronization
    const toolbars = document.querySelectorAll('[data-component="QuickToolbar"]');
    for (const tb of toolbars) {
      const settings = getToolbarSettingsFromFiber(tb);
      const isDocked = tb.getAttribute('data-quick-toolbar-placement') === 'chat_top_dock' || settings?.quickToolbarPlacement === 'chat_top_dock';
      const autoFit = settings ? settings.autoFitBounds !== false : true;
      const fillScreen = settings ? settings.fillTopDockWidth === true : false;

      tb.setAttribute('data-autofit', autoFit ? '1' : '0');
      tb.setAttribute('data-fill-screen', fillScreen ? '1' : '0');

      if (isDocked) {
        tb.style.setProperty('flex', '1 1 auto', 'important');
        tb.style.setProperty('width', '100%', 'important');
        tb.style.setProperty('max-width', '100%', 'important');
        tb.style.setProperty('margin', '0', 'important');

        const nav = tb.querySelector('nav');
        if (nav) {
          nav.style.setProperty('width', '100%', 'important');
          nav.style.setProperty('max-width', '100%', 'important');
          nav.style.setProperty('justify-content', 'flex-start', 'important');
        }
      } else if (fillScreen || tb.getAttribute('data-fill-screen') === '1') {
        tb.style.setProperty('left', '0px', 'important');
        tb.style.setProperty('width', '100vw', 'important');
        tb.style.setProperty('max-width', '100vw', 'important');
        tb.style.setProperty('margin', '0px', 'important');
        tb.style.setProperty('--quick-toolbar-x', '0px', 'important');
        tb.style.setProperty('--quick-toolbar-width', '100vw', 'important');

        const nav = tb.querySelector('nav');
        if (nav) {
          nav.style.setProperty('width', '100vw', 'important');
          nav.style.setProperty('max-width', '100vw', 'important');
          nav.style.setProperty('border-radius', '0px', 'important');
          nav.style.setProperty('justify-content', 'flex-start', 'important');
        }
      } else if (autoFit) {
        tb.style.setProperty('width', 'max-content', 'important');
        tb.style.setProperty('margin', '0px', 'important');
      }

      // Eliminate any spacer
      const spacers = tb.querySelectorAll('[class*="_fillDockSpacer_"], nav > div[aria-hidden="true"]');
      for (const sp of spacers) {
        sp.style.setProperty('display', 'none', 'important');
        sp.style.setProperty('width', '0', 'important');
        sp.style.setProperty('height', '0', 'important');
        sp.style.setProperty('flex', '0 0 0', 'important');
        sp.style.setProperty('margin', '0', 'important');
      }
    }
  }

  // Initial execution
  reconcileQuickToolbar();

  // 4. MutationObserver for React Re-renders & Tab Switches
  const observer = new MutationObserver(() => {
    reconcileQuickToolbar();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-spindle-mount',
      'data-quick-toolbar-placement',
      'data-fill-top-dock',
      'data-dead-space',
      'class',
      'style',
    ],
  });

  // 5. Expose Control API
  window.__LUMIVERSE_QUICKTOOLBAR_LIVEFIX__ = {
    reconcile: reconcileQuickToolbar,
    cleanup: () => {
      observer.disconnect();
      const injected = document.getElementById(SCRIPT_ID);
      if (injected) injected.remove();
      delete window.__LUMIVERSE_QUICKTOOLBAR_LIVEFIX__;
      console.log('[QuickToolbar LiveFix] Disconnected and cleaned up.');
    },
  };

  console.info('%c[Lumiverse QuickToolbar LiveFix v4.0] Active & Locked across all 3 scenarios.', 'color: #10b981; font-weight: bold;');
})();
