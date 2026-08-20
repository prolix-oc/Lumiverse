/**
 * QuickToolbar layout probe — measure-only.
 * Paste this entire file into the DevTools console on a running Lumiverse chat.
 *
 * Does not inject CSS, does not mutate layout, does not run live-devtools-fixes.js.
 * One snapshot cannot certify every mode. Read report.runPlan and report.verdicts.
 *
 * Copy the JSON printed between the BEGIN/END markers (also window.LUMIVERSE_TOOLBAR_PROBE_REPORT).
 */
(() => {
  'use strict';

  const SCRIPT = 'lumiverse-quicktoolbar-layout-probe';
  const VERSION = '1.2.0';
  const VIEWPORT_MARGIN = 24;
  const HUG_GAP = 6;
  const EDGE = 2;
  const SELECT_W = 28;
  const DOCK_PAD_X = 8;

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const near = (a, b, tol = EDGE) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

  function box(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const b = el.getBoundingClientRect();
    return { left: r2(b.left), top: r2(b.top), right: r2(b.right), bottom: r2(b.bottom), width: r2(b.width), height: r2(b.height) };
  }

  function css(el, prop) {
    if (!el) return null;
    try { return getComputedStyle(el).getPropertyValue(prop); } catch { return null; }
  }

  function varPx(el, name) {
    const n = Number.parseFloat(css(el, name) || '');
    return Number.isFinite(n) ? r2(n) : null;
  }

  function cls(el) {
    if (!el) return '';
    return typeof el.className === 'string' ? el.className : String(el.className || '');
  }

  function desc(el) {
    if (!el) return null;
    return {
      tag: el.tagName,
      className: cls(el),
      ariaLabel: el.getAttribute?.('aria-label'),
      title: el.getAttribute?.('title'),
      dataComponent: el.getAttribute?.('data-component'),
      box: box(el),
    };
  }

  function attrBool(el, name) {
    if (!el || !el.hasAttribute(name)) return null;
    const v = el.getAttribute(name);
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return null;
  }

  function elementsInBand(x0, x1, y0, y1) {
    const hits = [];
    const seen = new Set();
    if (!(x1 > x0) || !(y1 > y0)) return hits;
    for (let i = 0; i <= 4; i += 1) {
      const x = Math.min(window.innerWidth - 1, Math.max(0, x0 + ((x1 - x0) * i) / 4));
      const y = Math.min(window.innerHeight - 1, Math.max(0, y0 + (y1 - y0) * 0.5));
      let stack = [];
      try { stack = document.elementsFromPoint(x, y); } catch { stack = []; }
      for (const el of stack) {
        if (seen.has(el)) continue;
        seen.add(el);
        const b = el.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        if (b.right <= x0 || b.left >= x1) continue;
        hits.push(desc(el));
      }
    }
    return hits.slice(0, 16);
  }

  function readFiberSettings(el) {
    if (!el) return { found: false, value: null };
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!fiberKey) return { found: false, value: null };
    let fiber = el[fiberKey];
    let depth = 0;
    while (fiber && depth < 50) {
      const cand = [fiber.memoizedProps?.settings, fiber.memoizedProps?.quickToolbarSettings];
      let hook = fiber.memoizedState;
      let hops = 0;
      while (hook && hops < 50) {
        cand.push(hook.memoizedState);
        hook = hook.next;
        hops += 1;
      }
      for (const value of cand) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if ('autoFitBounds' in value || 'fillTopDockWidth' in value || 'quickToolbarPlacement' in value) {
            return {
              found: true,
              value: {
                autoFitBounds: value.autoFitBounds,
                fillTopDockWidth: value.fillTopDockWidth,
                quickToolbarPlacement: value.quickToolbarPlacement,
                showNativeSelectMessages: value.showNativeSelectMessages,
                variant: value.variant,
              },
            };
          }
        }
      }
      fiber = fiber.return;
      depth += 1;
    }
    return { found: false, value: null };
  }

  function inferMode(tb) {
    const fiber = readFiberSettings(tb);
    const dataPlacement = tb.getAttribute('data-quick-toolbar-placement');
    const dataFillDock = attrBool(tb, 'data-fill-top-dock');
    const dataFillScreen = attrBool(tb, 'data-fill-screen');
    const dataAutofit = attrBool(tb, 'data-autofit');
    const resizeHandleCount = tb.querySelectorAll('[data-toolbar-resize-handle]').length;
    const placement = dataPlacement || fiber.value?.quickToolbarPlacement || 'unknown';
    let autoFitBounds = null;
    let autoFitSource = 'unknown';
    if (dataAutofit != null) {
      autoFitBounds = dataAutofit;
      autoFitSource = 'data-autofit';
    } else if (fiber.value && 'autoFitBounds' in fiber.value && fiber.value.autoFitBounds != null) {
      autoFitBounds = fiber.value.autoFitBounds !== false;
      autoFitSource = 'react-fiber';
    } else if (resizeHandleCount > 0) {
      autoFitBounds = false;
      autoFitSource = 'resize-handles-present';
    }
    let fillTopDockWidth = null;
    let fillSource = 'unknown';
    if (dataFillDock != null || dataFillScreen != null) {
      fillTopDockWidth = dataFillScreen === true || dataFillDock === true;
      fillSource = 'data-fill-*';
    } else if (fiber.value && 'fillTopDockWidth' in fiber.value && fiber.value.fillTopDockWidth != null) {
      fillTopDockWidth = fiber.value.fillTopDockWidth !== false;
      fillSource = 'react-fiber';
    }
    const confidence = [
      dataPlacement ? 1 : 0,
      autoFitSource !== 'unknown' ? 1 : 0,
      fillSource !== 'unknown' ? 1 : 0,
      fiber.found ? 1 : 0,
    ].reduce((a, b) => a + b, 0) / 4;
    return {
      placement,
      variant: tb.getAttribute('data-quick-toolbar-variant') || fiber.value?.variant || null,
      autoFitBounds,
      autoFitSource,
      fillTopDockWidth,
      fillSource,
      resizeHandleCount,
      fiberFound: fiber.found,
      showNativeSelectMessages: fiber.value?.showNativeSelectMessages ?? null,
      dataAutofit,
      dataFillTopDock: dataFillDock,
      dataFillScreen,
      confidence: r2(confidence),
    };
  }

  function findDrawerTabs() {
    const set = new Set();
    document.querySelectorAll('[class*="drawerTab"], button[aria-label="Drag to reposition"]').forEach((el) => set.add(el));
    return [...set].filter((el) => {
      const c = cls(el);
      return /drawerTab/i.test(c) || el.getAttribute('aria-label') === 'Drag to reposition';
    });
  }

  function classifyTab(tab) {
    const b = box(tab);
    const c = cls(tab);
    const compact = /drawerTabCompact/i.test(c) || (b && near(b.width, 32, 4));
    const side = b && b.left > (window.innerWidth / 2) ? 'right' : 'left';
    return {
      tab: desc(tab),
      side,
      compact,
      width: b?.width ?? null,
      left: b?.left ?? null,
      expectedWidth: compact ? 32 : 48,
    };
  }

  function findSpacer(tb, nav) {
    const hashed = tb.querySelector('[class*="fillDockSpacer"]');
    if (hashed && !/measureRail/i.test(cls(hashed))) return hashed;
    if (!nav) return null;
    return [...nav.children].find((node) => (
      node instanceof HTMLElement
      && node.tagName === 'DIV'
      && node.getAttribute('aria-hidden') === 'true'
      && !/measureRail|cardScroller|cardSlot/i.test(cls(node))
      && !node.querySelector('[data-toolbar-action], button')
    )) || null;
  }

  const liveFixActive = Boolean(globalThis.__LUMIVERSE_QUICKTOOLBAR_LIVEFIX__)
    || Boolean(document.getElementById('lumiverse-quicktoolbar-livefix'));

  const screenW = window.visualViewport?.width ?? window.innerWidth;
  const screenH = window.visualViewport?.height ?? window.innerHeight;
  const uiScale = Number.parseFloat(css(document.documentElement, '--lumiverse-ui-scale') || '1') || 1;
  const layoutWidth = r2(screenW / (uiScale || 1));
  const viewport = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualWidth: window.visualViewport?.width ?? null,
    visualHeight: window.visualViewport?.height ?? null,
    visualOffsetLeft: window.visualViewport?.offsetLeft ?? 0,
    visualOffsetTop: window.visualViewport?.offsetTop ?? 0,
    uiScale,
    layoutWidth,
    screenW,
    screenH,
    devtoolsLikelySideDocked: Math.abs(window.outerWidth - window.innerWidth) > 120,
  };

  const toolbars = [...document.querySelectorAll('[data-component="QuickToolbar"]')];
  const drawerTabs = findDrawerTabs().map(classifyTab);
  const dock = document.querySelector('[data-spindle-mount="chat_top_dock"]');
  const column = document.querySelector('[data-lumiverse-surface="chat-column-inner"]');
  const selectBtn = dock?.querySelector('button[aria-label="Select messages"], button[aria-label*="selection" i], button[title="Select messages"]') || null;

  const checks = [];
  const verdicts = {};
  function addCheck(id, feature, status, detail, evidence) {
    const row = { id, feature, status, detail, evidence };
    checks.push(row);
    verdicts[feature] = { status, detail, evidence };
    return row;
  }

  const toolbarReports = toolbars.map((tb, index) => {
    const mode = inferMode(tb);
    const nav = tb.querySelector('nav');
    const scroller = tb.querySelector('[class*="cardScroller"]');
    const spacer = findSpacer(tb, nav);
    const overflow = tb.querySelector('[class*="overflowButton"], button[aria-label^="Show "][aria-label*="more toolbar"]');
    const gear = tb.querySelector('button[aria-label="Customize toolbar"]');
    const visibleCards = [...tb.querySelectorAll('[data-toolbar-action]')].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 1 && b.height > 1 && css(el, 'visibility') !== 'hidden';
    });
    const lastCard = visibleCards[visibleCards.length - 1] || null;
    const tbBox = box(tb);
    const spacerBox = box(spacer);
    const lastCardBox = box(lastCard);
    const overflowBox = box(overflow);
    const gearBox = box(gear);
    const paintedX = varPx(tb, '--quick-toolbar-x');
    const paintedW = varPx(tb, '--quick-toolbar-width');
    const currentX = paintedX ?? tbBox?.left ?? null;
    const currentW = (paintedW && paintedW > 1) ? paintedW : (tbBox?.width ?? null);
    const minX = VIEWPORT_MARGIN;
    const maxX = currentW != null ? r2(Math.max(minX, layoutWidth - currentW - VIEWPORT_MARGIN)) : null;
    const dockBox = box(dock);
    const columnBox = box(column);
    const rightTabs = drawerTabs.filter((d) => d.side === 'right');
    const primaryRightTab = rightTabs.sort((a, b) => (a.left ?? 0) - (b.left ?? 0))[0] || null;
    const actualRightGap = tbBox ? r2(screenW - tbBox.right) : null;
    const overlapWithTab = (tbBox && primaryRightTab?.tab.box)
      ? r2(Math.min(tbBox.right, primaryRightTab.tab.box.right) - Math.max(tbBox.left, primaryRightTab.tab.box.left))
      : null;
    const gapToolbarToTab = (tbBox && primaryRightTab?.left != null)
      ? r2(primaryRightTab.left - tbBox.right)
      : null;
    const atOldRightClamp = currentX != null && maxX != null && near(currentX, maxX);
    const flushToTab = Boolean(primaryRightTab && (
      (overlapWithTab != null && overlapWithTab > 1)
      || (gapToolbarToTab != null && near(gapToolbarToTab, 0, EDGE))
      || (actualRightGap != null && primaryRightTab.width != null && actualRightGap <= primaryRightTab.width + EDGE)
    ));
    const flushToViewport = actualRightGap != null && actualRightGap <= EDGE;
    const parkedRight = atOldRightClamp || flushToTab || flushToViewport;
    const parkedLeft = currentX != null && currentX <= minX + EDGE;
    const atRightClamp = parkedRight;
    const atLeftClamp = parkedLeft;

    let leftCauseId = 'not-at-a-clamp';
    let leftCause = 'Bar is not parked on a clamp. Drag fully left (run C) or fully right (run B).';
    if (mode.autoFitBounds === true && mode.fillTopDockWidth !== true && dockBox && currentX != null && near(currentX, dockBox.left)) {
      leftCauseId = 'dock-rail-lock';
      leftCause = 'Auto-fit ON + fill OFF locks x to chat_top_dock.left via resolveFloatingV2Rail(dockRect).';
    } else if (mode.autoFitBounds === true && mode.fillTopDockWidth !== true && columnBox && currentX != null && near(currentX, columnBox.left)) {
      leftCauseId = 'column-rail-lock';
      leftCause = 'Auto-fit ON + fill OFF locks x to chat-column-inner.left.';
    } else if (mode.fillTopDockWidth === true && mode.placement === 'floating' && currentX != null && near(currentX, VIEWPORT_MARGIN + (viewport.visualOffsetLeft || 0))) {
      leftCauseId = 'fill-viewport-margin';
      leftCause = 'Fill-screen uses visualViewport.offsetLeft + FLOATING_V2_VIEWPORT_MARGIN=24, not x=0.';
    } else if (atOldRightClamp) {
      leftCauseId = 'right-clamp-leftover';
      leftCause = `currentX=${currentX} is the RIGHT clamp (layoutWidth - width - 24 = ${maxX}). That leftover is not a left-side obstacle. Drag fully left to test minX.`;
    } else if (parkedLeft && currentX != null && currentX > EDGE) {
      leftCauseId = 'floating-v2-viewport-margin';
      leftCause = 'Parked on the left clamp. Source floors x at FLOATING_V2_VIEWPORT_MARGIN=24, so x=0 is unreachable.';
    }

    const hugGaps = {
      cardToOverflow: lastCardBox && overflowBox ? r2(overflowBox.left - lastCardBox.right) : null,
      overflowToGear: overflowBox && gearBox ? r2(gearBox.left - overflowBox.right) : null,
      cardToGear: !overflow && lastCardBox && gearBox ? r2(gearBox.left - lastCardBox.right) : null,
    };
    const hugMeasured = [hugGaps.cardToOverflow, hugGaps.overflowToGear, hugGaps.cardToGear].filter((n) => n != null);
    const hugOk = hugMeasured.length > 0 && hugMeasured.every((n) => near(n, HUG_GAP, 2));

    const floating = mode.placement === 'floating';
    const autofitOn = mode.autoFitBounds === true;
    const autofitOff = mode.autoFitBounds === false;
    const fillOn = mode.fillTopDockWidth === true;

    if (!floating) {
      addCheck(`f1-spacer-${index}`, 'autofit-hug-canyon', 'SKIP', 'Not a floating toolbar. Use run A (floating, auto-fit ON, fill OFF).', { mode });
    } else if (!autofitOn) {
      addCheck(`f1-spacer-${index}`, 'autofit-hug-canyon', autofitOff ? 'SKIP' : 'INCONCLUSIVE',
        autofitOff ? 'Auto-fit is OFF. Switch Auto-fit ON and Fill OFF (run A) to certify the canyon.' : 'Could not determine auto-fit. Set Auto-fit ON, Fill OFF, then re-run.',
        { mode, spacerPresent: Boolean(spacer), spacerWidth: spacerBox?.width ?? 0 });
    } else if (liveFixActive) {
      addCheck(`f1-spacer-${index}`, 'autofit-hug-canyon', 'INCONCLUSIVE',
        'live-devtools-fixes.js is injected and can hide fillDockSpacer. Remove it and re-run run A.',
        { liveFixActive: true, spacerPresent: Boolean(spacer), spacerWidth: spacerBox?.width ?? 0 });
    } else if (!lastCard || !gear) {
      addCheck(`f1-spacer-${index}`, 'autofit-hug-canyon', 'SKIP', 'Need a visible last card and Customize gear to measure hug gaps.', { lastCard: Boolean(lastCard), gear: Boolean(gear) });
    } else {
      const spacerWide = Boolean(spacer) && (spacerBox?.width ?? 0) > 1;
      const status = spacerWide ? 'FAIL' : (hugOk ? 'PASS' : 'FAIL');
      addCheck(`f1-spacer-${index}`, 'autofit-hug-canyon', status,
        spacerWide
          ? `fillDockSpacer is flexing: display=${css(spacer, 'display')}, flex=${css(spacer, 'flex')}, width=${spacerBox.width}px (canyon).`
          : (hugOk
            ? 'Spacer gone or zero-width and card/+N/gear gaps are ~6px.'
            : `Spacer collapsed but hug gaps are not 6px: ${JSON.stringify(hugGaps)}.`),
        {
          spacerPresent: Boolean(spacer),
          spacerDisplay: spacer ? css(spacer, 'display') : null,
          spacerFlex: spacer ? css(spacer, 'flex') : null,
          spacerWidth: spacerBox?.width ?? 0,
          hugGaps,
          expectedGap: HUG_GAP,
        });
    }

    if (!floating) {
      addCheck(`f2-right-${index}`, 'autofit-off-right-edge', 'SKIP', 'Not floating. Use run B.', { mode });
    } else if (!autofitOff) {
      addCheck(`f2-right-${index}`, 'autofit-off-right-edge', autofitOn ? 'SKIP' : 'INCONCLUSIVE',
        autofitOn ? 'Auto-fit ON is a hug/fill rail, not free-drag. Switch Auto-fit OFF and drag fully right (run B).' : 'Auto-fit unknown. Switch Auto-fit OFF and drag fully right.',
        { mode, actualRightGap, drawerTab: primaryRightTab });
    } else if (!atRightClamp) {
      addCheck(`f2-right-${index}`, 'autofit-off-right-edge', 'INCONCLUSIVE',
        `Not parked on the right clamp (currentX=${currentX}, maxX=${maxX}). Drag the move handle fully right, then re-run.`,
        { currentX, maxX, actualRightGap, atRightClamp, drawerTab: primaryRightTab });
    } else {
      const tabW = primaryRightTab?.width ?? null;
      let blockedBy = 'viewport-margin-24';
      if (primaryRightTab && overlapWithTab != null && overlapWithTab > 1) blockedBy = 'viewport-margin-24-under-drawer-tab';
      else if (primaryRightTab && gapToolbarToTab != null && near(gapToolbarToTab, 0, EDGE)) blockedBy = 'none-flush-to-tab';
      else if (!primaryRightTab && actualRightGap != null && actualRightGap <= EDGE) blockedBy = 'none';
      const pass = blockedBy === 'none-flush-to-tab' || blockedBy === 'none';
      addCheck(`f2-right-${index}`, 'autofit-off-right-edge', pass ? 'PASS' : 'FAIL',
        pass
          ? 'Right edge is flush to the drawer tab or the viewport.'
          : `At right clamp. actualRightGap=${actualRightGap}px, sourceClampReserve=24px, drawerTabWidth=${tabW}px, overlapWithTab=${overlapWithTab}px, blockedBy=${blockedBy}. After fix: toolbar.right should meet tab.left (gap≈0) or viewport if no tab.`,
        {
          blockedBy,
          actualRightGapPx: actualRightGap,
          sourceClampReservePx: VIEWPORT_MARGIN,
          drawerTabWidthPx: tabW,
          overlapWithTabPx: overlapWithTab,
          gapToolbarToTabPx: gapToolbarToTab,
          currentX,
          maxX,
          toolbarRight: tbBox?.right ?? null,
          viewportRight: screenW,
        });
    }

    if (!floating) {
      addCheck(`f3-left-${index}`, 'autofit-off-left-edge', 'SKIP', 'Not floating. Use run C.', { mode });
    } else if (!autofitOff) {
      addCheck(`f3-left-${index}`, 'autofit-off-left-edge', autofitOn ? 'SKIP' : 'INCONCLUSIVE',
        autofitOn ? `Auto-fit ON. ${leftCause}` : 'Auto-fit unknown. Switch Auto-fit OFF and drag fully left (run C).',
        { mode, causeId: leftCauseId, currentX, minX });
    } else if (atRightClamp) {
      addCheck(`f3-left-${index}`, 'autofit-off-left-edge', 'INCONCLUSIVE',
        leftCause,
        { causeId: leftCauseId, currentX, minX, maxX, atRightClamp: true, leftoverIfAtRightClamp: currentX, paintedWidth: currentW, layoutWidth });
    } else if (!atLeftClamp) {
      addCheck(`f3-left-${index}`, 'autofit-off-left-edge', 'INCONCLUSIVE',
        `Not parked on the left clamp (currentX=${currentX}, minX=${minX}). Drag fully left, then re-run.`,
        { causeId: leftCauseId, currentX, minX, maxX, atLeftClamp, leftBandHits: tbBox ? elementsInBand(0, Math.max(0, tbBox.left), tbBox.top, tbBox.bottom) : [] });
    } else {
      const pass = currentX != null && currentX <= EDGE;
      addCheck(`f3-left-${index}`, 'autofit-off-left-edge', pass ? 'PASS' : 'FAIL',
        pass
          ? 'Parked at x≈0. Left edge is reachable.'
          : `${leftCause} FAIL because atLeftClamp and currentX=${currentX} (source minX=24). After fix currentX should be 0.`,
        {
          causeId: leftCauseId,
          currentX,
          computedLeft: tbBox?.left ?? null,
          minX,
          maxX,
          atLeftClamp,
          dockLeft: dockBox?.left ?? null,
          columnLeft: columnBox?.left ?? null,
          visualOffsetLeft: viewport.visualOffsetLeft,
          paintedWidth: currentW,
          layoutWidth,
          leftBandHits: tbBox ? elementsInBand(0, Math.max(0, tbBox.left), tbBox.top, tbBox.bottom) : [],
        });
    }

    if (floating && fillOn && autofitOn) {
      const flush = tbBox && near(tbBox.left, 0, EDGE) && near(tbBox.width, screenW, 3);
      addCheck(`f5-fill-${index}`, 'autofit-on-fill-on-100vw', flush ? 'PASS' : 'FAIL',
        flush ? 'Fill-ON is edge-to-edge.' : `Fill-ON is not 100vw. left=${tbBox?.left}, width=${tbBox?.width}, screenW=${screenW}, cssX=${paintedX}, cssW=${paintedW}. Source still applies 24px FLOATING_V2_VIEWPORT_MARGIN.`,
        { left: tbBox?.left, width: tbBox?.width, screenW, paintedX, paintedW });
    } else {
      addCheck(`f5-fill-${index}`, 'autofit-on-fill-on-100vw', 'SKIP', 'Enable Auto-fit ON + Fill the entire top of the screen to certify 100vw.', { mode });
    }

    return {
      index,
      mode,
      attrs: {
        dock: tb.getAttribute('data-quick-toolbar-dock'),
        placement: tb.getAttribute('data-quick-toolbar-placement'),
        variant: tb.getAttribute('data-quick-toolbar-variant'),
        fillTopDock: tb.getAttribute('data-fill-top-dock'),
        deadSpace: tb.getAttribute('data-dead-space'),
      },
      cssVars: { x: paintedX, y: varPx(tb, '--quick-toolbar-y'), width: paintedW, height: css(tb, '--quick-toolbar-height') },
      boxes: { root: tbBox, nav: box(nav), scroller: box(scroller), lastCard: lastCardBox, overflow: overflowBox, gear: gearBox, spacer: spacerBox },
      spacer: {
        present: Boolean(spacer),
        display: spacer ? css(spacer, 'display') : null,
        flex: spacer ? css(spacer, 'flex') : null,
        width: spacerBox?.width ?? 0,
        className: spacer ? cls(spacer) : null,
      },
      hugGaps,
      clampMath: { layoutWidth, viewportMargin: VIEWPORT_MARGIN, minX, maxX, currentX, currentW, atLeftClamp, atRightClamp },
      leftCause: { id: leftCauseId, summary: leftCause },
      rightTab: primaryRightTab,
    };
  });

  if (!dock) {
    addCheck('dock-right-void', 'chat-top-dock-width', 'SKIP', 'No [data-spindle-mount=chat_top_dock] in this document.', {});
  } else {
    const dockedTb = dock.querySelector('[data-component="QuickToolbar"]');
    if (!dockedTb) {
      addCheck('dock-right-void', 'chat-top-dock-width', 'SKIP', 'QuickToolbar is not a child of chat_top_dock (floating-only snapshot). Switch placement to chat top dock for this check.', { dock: desc(dock) });
    } else {
      const dockBox = box(dock);
      const tbBox = box(dockedTb);
      const selectBox = box(selectBtn);
      const ghostRoots = [...dock.querySelectorAll('[data-spindle-extension-root], [data-spindle-ext]')].map((root) => {
        const interactive = root.querySelector('button, a, input, select, textarea, [role="button"], [data-toolbar-action], [data-component]');
        const visual = root.querySelector('svg, img, canvas');
        const b = box(root);
        const vacant = !interactive && !visual;
        return {
          vacant,
          emptySelectorWouldMatch: root.childElementCount === 0,
          display: css(root, 'display'),
          flex: css(root, 'flex'),
          width: b?.width ?? 0,
          hasEmptyWorkspace: Boolean(root.querySelector('[data-surface-id="quick_toolbar.workspace"]')),
          dockRequest: root.getAttribute('data-dock-request'),
          surfaceIds: [...root.querySelectorAll('[data-surface-id]')].map((surface) => ({
            id: surface.getAttribute('data-surface-id'),
            lifecycle: surface.getAttribute('data-lifecycle'),
            box: box(surface),
          })),
          childElementCount: root.childElementCount,
          textPresent: Boolean(root.textContent?.trim()),
          directChildCount: root.querySelectorAll(':scope > *').length,
          minWidth: css(root, 'min-width'),
          overflow: css(root, 'overflow'),
        };
      });
      const ghostVacantNonEmpty = ghostRoots.some((g) => g.vacant && g.width > 1 && !g.emptySelectorWouldMatch);
      const retainedDockRoots = ghostRoots.filter((g) => g.dockRequest === 'strip');
      const retainedDockVacancies = retainedDockRoots.filter((g) => g.vacant || g.width <= 1);
      const retainedDockReasons = [];
      if (retainedDockRoots.length > 1) retainedDockReasons.push('duplicate-strip-roots');
      if (retainedDockVacancies.length > 0) retainedDockReasons.push('strip-root-without-mounted-content');
      if (retainedDockRoots.some((g) => g.surfaceIds.length === 0)) retainedDockReasons.push('strip-root-without-host-surface');
      const retainedDockContract = {
        rootCount: retainedDockRoots.length,
        vacantCount: retainedDockVacancies.length,
        width: r2(retainedDockRoots.reduce((sum, root) => sum + root.width, 0)),
        reasons: retainedDockReasons,
      };
      const reserved = (selectBox?.width || 0) + (selectBtn ? HUG_GAP : 0) + DOCK_PAD_X;
      const rawVoid = dockBox && tbBox ? r2(dockBox.right - tbBox.right) : null;
      const unexplainedVoid = rawVoid != null ? r2(Math.max(0, rawVoid - reserved)) : null;
      const fillOff = dockedTb.getAttribute('data-fill-top-dock') === '0';
      const fail = (unexplainedVoid != null && unexplainedVoid > 8) || ghostVacantNonEmpty;
      addCheck('dock-right-void', 'chat-top-dock-width', fail ? 'FAIL' : 'PASS',
        fail
          ? `Dock leftover unexplainedVoid=${unexplainedVoid}px (raw ${rawVoid}px minus select/pad ${reserved}px). ghostVacantNonEmpty=${ghostVacantNonEmpty}. fill attr=${dockedTb.getAttribute('data-fill-top-dock')}.`
          : `Dock leftover explained or small (unexplainedVoid=${unexplainedVoid}px).`,
        {
          dockBox,
          toolbarBox: tbBox,
          rawVoid,
          unexplainedVoid,
          reserved,
          fillTopDockAttr: dockedTb.getAttribute('data-fill-top-dock'),
          fillOff,
          selectMessages: { rendered: Boolean(selectBtn), box: selectBox },
          ghostRoots,
          ghostVacantNonEmpty,
          retainedDockContract,
        });
      addCheck('retained-dock-contract', 'retained-dock-lifecycle', retainedDockReasons.length === 0 ? 'PASS' : 'FAIL',
        retainedDockReasons.length === 0
          ? 'Retained strip ownership has one mounted host root with usable content.'
          : `Retained dock contract issues: ${retainedDockReasons.join(', ')}.`,
        retainedDockContract);
    }
  }

  if (toolbars.length === 0) {
    addCheck('toolbar-missing', 'presence', 'FAIL', 'No [data-component=QuickToolbar]. Open a chat first.', {});
  }

  const report = {
    script: SCRIPT,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    liveFixActive,
    humanInstructions: [
      'Open a chat. Undock DevTools or put it on the bottom so innerWidth is the real window.',
      'Do not leave scripts/live-devtools-fixes.js running (liveFixActive must be false).',
      'Run A: floating + Auto-fit ON + Fill OFF, enough cards that +N and the gear are visible.',
      'Run B: Auto-fit OFF, drag the grip fully RIGHT, then paste this script again.',
      'Run C: Auto-fit OFF, drag the grip fully LEFT, then paste this script again.',
      'Optional dock run: switch placement to chat top dock. Toggle Select messages if you care about that leftover.',
      'Copy the JSON between BEGIN and END (or window.LUMIVERSE_TOOLBAR_PROBE_REPORT).',
    ],
    runPlan: {
      A: { proves: 'autofit-hug-canyon', need: 'floating, auto-fit ON, fill OFF, +N + gear visible' },
      B: { proves: 'autofit-off-right-edge', need: 'auto-fit OFF, dragged fully right, drawer tab visible' },
      C: { proves: 'autofit-off-left-edge', need: 'auto-fit OFF, dragged fully left' },
      D: { proves: 'chat-top-dock-width + retained-dock-lifecycle', need: 'toolbar mounted inside chat_top_dock or a retained floating host transition' },
      E: { proves: 'autofit-on-fill-on-100vw', need: 'floating, auto-fit ON, fill ON' },
    },
    note: 'Measure-only. Target source is G:\\AI\\All lumiverse repos\\Lumiverse. Workspace G:\\AI\\Lumiverse is an older checkout without fillDockSpacer / quickToolbarDock.ts.',
    expectedAfterSourceFix: {
      pointerHoldMs: 500,
      currentSourceHoldMs: 1000,
      autofitOnFillOff: 'width:max-content; card/+N/gear gap 6px; fillDockSpacer gone or 0x0',
      autofitOnFillOn: 'left:0; width:100vw; no 24px FLOATING_V2_VIEWPORT_MARGIN',
      autofitOff: 'minX=0; max right edge meets drawer tab (32 compact / 48 regular), not a hardcoded 24px both sides',
      leftMysteryOnWideBar: 'x≈66 with width≈1830 at a ~1896–1920 viewport is layoutWidth-width-24 (right clamp leftover), not a 66px left chrome widget',
    },
    viewport,
    chrome: {
      dock: desc(dock),
      column: desc(column),
      selectMessages: desc(selectBtn),
      drawerTabs,
    },
    toolbars: toolbarReports,
    checks,
    verdicts,
    summary: {
      total: checks.length,
      fail: checks.filter((c) => c.status === 'FAIL').length,
      pass: checks.filter((c) => c.status === 'PASS').length,
      skip: checks.filter((c) => c.status === 'SKIP').length,
      inconclusive: checks.filter((c) => c.status === 'INCONCLUSIVE').length,
      failedIds: checks.filter((c) => c.status === 'FAIL').map((c) => c.id),
      inconclusiveIds: checks.filter((c) => c.status === 'INCONCLUSIVE').map((c) => c.id),
    },
  };

  const json = JSON.stringify(report, null, 2);
  globalThis.LUMIVERSE_TOOLBAR_PROBE_REPORT = report;
  console.log('===== BEGIN LUMIVERSE_TOOLBAR_PROBE_REPORT =====');
  console.log(json);
  console.log('===== END LUMIVERSE_TOOLBAR_PROBE_REPORT =====');
  console.table(checks.map((c) => ({ id: c.id, feature: c.feature, status: c.status, detail: c.detail.slice(0, 140) })));
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(json).then(
      () => console.info(`[${SCRIPT}] JSON copied to clipboard.`),
      () => console.info(`[${SCRIPT}] Clipboard blocked. Copy the BEGIN/END blob.`),
    );
  }
  return report;
})();
