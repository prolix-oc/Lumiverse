/* Liquid Glass Lab - standalone, no dependencies */
(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Toggle ----
  const toggle = document.querySelector('.liquid-toggle');
  const toggleLabel = toggle && toggle.querySelector('.liquid-toggle__label');
  if (toggle) {
    const setState = (pressed) => {
      toggle.setAttribute('aria-pressed', String(pressed));
      if (toggleLabel) toggleLabel.textContent = pressed ? 'on' : 'off';
    };
    const flip = () => setState(toggle.getAttribute('aria-pressed') !== 'true');
    toggle.addEventListener('click', flip);
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });
  }

  // ---- Slider ----
  const slider = document.getElementById('slider');
  const progress = document.getElementById('slider-progress');
  const thumb = document.getElementById('slider-thumb');
  if (slider && progress && thumb) {
    let rect = slider.getBoundingClientRect();
    let dragging = false;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const update = (pct) => {
      pct = clamp(pct, 0, 100);
      const px = (pct / 100) * rect.width;
      progress.style.width = pct + '%';
      thumb.style.left = px + 'px';
      thumb.setAttribute('aria-valuenow', String(Math.round(pct)));
    };

    const pctFromX = (x) => ((x - rect.left) / rect.width) * 100;

    const start = (x) => { dragging = true; rect = slider.getBoundingClientRect(); thumb.classList.add('active'); update(pctFromX(x)); };
    const move = (x) => { if (dragging) update(pctFromX(x)); };
    const stop = () => { dragging = false; thumb.classList.remove('active'); };

    thumb.addEventListener('mousedown', (e) => { e.preventDefault(); start(e.clientX); });
    thumb.addEventListener('touchstart', (e) => { if (e.touches[0]) start(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('mousemove', (e) => move(e.clientX));
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', (e) => { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: false });
    document.addEventListener('touchend', stop);

    slider.addEventListener('mousedown', (e) => { rect = slider.getBoundingClientRect(); update(pctFromX(e.clientX)); });
    slider.addEventListener('touchstart', (e) => { if (e.touches[0]) { rect = slider.getBoundingClientRect(); update(pctFromX(e.touches[0].clientX)); } }, { passive: true });

    thumb.addEventListener('keydown', (e) => {
      const cur = parseFloat(thumb.getAttribute('aria-valuenow') || '0');
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); update(cur - 5); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); update(cur + 5); }
      if (e.key === 'Home') { e.preventDefault(); update(0); }
      if (e.key === 'End') { e.preventDefault(); update(100); }
    });

    window.addEventListener('resize', () => { rect = slider.getBoundingClientRect(); });
    // init
    rect = slider.getBoundingClientRect();
    update(40);
  }

  // ---- Graceful SVG filter probe ----
  if (!CSS.supports('filter: url(#x)')) {
    document.documentElement.dataset.noSvgFilter = 'true';
  }
  if (reducedMotion) {
    document.documentElement.dataset.reducedMotion = 'true';
  }
})();
