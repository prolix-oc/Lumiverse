(() => {
  'use strict';

  const toolbar = document.querySelector('[data-component="QuickToolbar"]');
  const nav = toolbar?.querySelector('nav');
  const scroller = toolbar?.querySelector('[class*="_cardScroller_"]');
  const spacer = toolbar?.querySelector('[class*="_fillDockSpacer_"]');
  const overflow = toolbar?.querySelector('button[aria-controls="quick-toolbar-overflow"]');
  const gear = toolbar?.querySelector('button[aria-label="Customize toolbar"]');
  const composerGear = document.querySelector('button[aria-label="Customize composer"]');
  const picker = document.querySelector('[data-lumiverse-connections-launcher="true"]');
  const nativeLink = document.querySelector('[data-composer-action="connections"]');
  const pickerAction = document.querySelector('[data-composer-action="connectionsPicker"]');
  const drawerTab = document.querySelector('[class*="_drawerTab_"][aria-label], button[class*="_drawerTab_"]');
  const viewportW = window.visualViewport?.width || window.innerWidth;
  const tb = toolbar?.getBoundingClientRect();
  const drawer = drawerTab?.getBoundingClientRect();
  const cs = spacer ? getComputedStyle(spacer) : null;
  const scrollerCs = scroller ? getComputedStyle(scroller) : null;
  const gearCs = gear ? getComputedStyle(gear) : null;
  const composerGearCs = composerGear ? getComputedStyle(composerGear) : null;

  const placement = toolbar?.getAttribute('data-quick-toolbar-placement') || '';
  const autofit = toolbar?.getAttribute('data-autofit');
  const fillScreen = toolbar?.getAttribute('data-fill-screen');
  const fillDock = toolbar?.getAttribute('data-fill-top-dock');
  const left = tb ? Number(tb.left.toFixed(2)) : null;
  const rightGap = tb ? Number((viewportW - tb.right).toFixed(2)) : null;
  const width = tb ? Number(tb.width.toFixed(2)) : null;
  const spacerGone = !spacer || cs.display === 'none' || cs.flexGrow === '0' || cs.width === '0px';
  const cardsToOverflow = (() => {
    if (!scroller || !overflow) return null;
    const a = scroller.getBoundingClientRect();
    const b = overflow.getBoundingClientRect();
    return Number((b.left - a.right).toFixed(1));
  })();
  const overflowToGear = (() => {
    const leftEl = overflow || scroller;
    if (!leftEl || !gear) return null;
    const a = leftEl.getBoundingClientRect();
    const b = gear.getBoundingClientRect();
    return Number((b.left - a.right).toFixed(1));
  })();

  const rows = [
    ['toolbar present', Boolean(toolbar)],
    ['placement', placement],
    ['data-autofit', autofit],
    ['data-fill-screen', fillScreen],
    ['data-fill-top-dock', fillDock],
    ['left px', left],
    ['width px', width],
    ['right gap px', rightGap],
    ['fillDockSpacer gone', spacerGone],
    ['cardScroller width', scrollerCs?.width],
    ['cards → +N gap', cardsToOverflow],
    ['+N/cards → gear gap', overflowToGear],
    ['customize toolbar cursor', gearCs?.cursor],
    ['customize composer cursor', composerGearCs?.cursor],
    ['composer gear pinned', composerGear ? !composerGear.closest('[data-composer-action]') : null],
    ['connectionsPicker action', Boolean(pickerAction)],
    ['waypoints launcher attr', Boolean(picker)],
    ['native Link2 connections distinct', Boolean(nativeLink) && pickerAction !== nativeLink],
    ['drawer tab right', drawer ? Number(drawer.left.toFixed(1)) : 'none'],
    ['toolbar can reach x=0 (autofit off)', autofit === '0' ? left === 0 || left <= 1 : 'n/a'],
    ['fill-on is 100vw', fillScreen === '1' ? Math.abs((width || 0) - viewportW) <= 1 && (left || 0) <= 1 : 'n/a'],
  ];

  console.table(rows.map(([check, value]) => ({ check, value })));
  console.info('[QuickToolbar verify] viewport=%s toolbar=%o drawer=%o', viewportW, tb, drawer);
  return Object.fromEntries(rows);
})();
