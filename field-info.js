// field-info.js
// Handles the Field Info panel visibility + dragging of panel, layers button, state badge, and compass
(() => {
  const STORAGE_INFO_VIS = 'ui_info_visible';
  const infoPanel = document.getElementById('infoPanel');

  /** Show / hide the Field Info panel and remember the choice */
  function setInfoVisible(v) {
    if (!infoPanel) return;
    infoPanel.style.display = v ? 'block' : 'none';

    try {
      localStorage.setItem(STORAGE_INFO_VIS, v ? '1' : '0');
    } catch (_) {}

    // Safely call updateSun if it exists (defined in main.js)
    if (v && typeof window.updateSun === 'function') {
      window.updateSun();
    }
  }

  /** Read the saved visibility from localStorage */
  function getInfoVisible() {
    try {
      return localStorage.getItem(STORAGE_INFO_VIS) === '1';
    } catch (_) {
      return false;
    }
  }

  /** Generic draggable helper used for the panel, layers button, state badge, and compass */
  function makeDraggable(el, handleId, storageKey) {
    if (!el) return;
    const handle = document.getElementById(handleId);
    if (!handle) return;

    let sx = 0, sy = 0, sl = 0, st = 0, dragging = false;

    function point(e) {
      if (e.touches && e.touches[0]) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      return { x: e.clientX, y: e.clientY };
    }

    function apply(l, t) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      l = Math.max(4, Math.min(vw - w - 4, l));
      t = Math.max(60, Math.min(vh - h - 4, t));
      el.style.left = l + 'px';
      el.style.top = t + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }

    function savePos() {
      try {
        const r = el.getBoundingClientRect();
        localStorage.setItem(
          storageKey,
          JSON.stringify({ left: r.left, top: r.top })
        );
      } catch (_) {}
    }

    function move(e) {
      if (!dragging) return;
      const p = point(e);
      apply(sl + p.x - sx, st + p.y - sy);
      e.preventDefault();
    }

    function tmove(e) {
      if (!dragging) return;
      const p = point(e);
      apply(sl + p.x - sx, st + p.y - sy);
      e.preventDefault();
    }

    function up() {
      dragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', tmove);
      document.removeEventListener('touchend', up);
      savePos();
    }

    function start(x, y) {
      dragging = true;
      sx = x;
      sy = y;
      const r = el.getBoundingClientRect();
      sl = r.left;
      st = r.top;
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', tmove, { passive: false });
      document.addEventListener('touchend', up);
    }

    function down(e) {
      const p = point(e);
      start(p.x, p.y);
      e.preventDefault();
    }

    function tdown(e) {
      const p = point(e);
      start(p.x, p.y);
    }

    // Restore saved position if present
    try {
      const s = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (s && typeof s.left === 'number' && typeof s.top === 'number') {
        el.style.left = s.left + 'px';
        el.style.top = s.top + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
    } catch (_) {}

    handle.addEventListener('mousedown', down);
    handle.addEventListener('touchstart', tdown, { passive: false });
  }

  // ---- Init ----

  // Field Info panel
  if (infoPanel) {
    setInfoVisible(getInfoVisible());
    makeDraggable(infoPanel, 'infoHandle', 'ui_info_pos');
  }

  // Floating layers button
  const layersBtn = document.getElementById('bhhLayersBtn');
  if (layersBtn) {
    makeDraggable(layersBtn, 'bhhLayersBtnHandle', 'ui_layers_btn_pos');
  }

  // State badge
  const stateBadge = document.getElementById('stateBadge');
  if (stateBadge) {
    makeDraggable(stateBadge, 'stateBadge', 'ui_state_badge_pos');
  }

  // NEW: Compass widget (bottom-right)
  const compassWidget = document.getElementById('compassWidget');
  if (compassWidget) {
    makeDraggable(compassWidget, 'compassWidgetHandle', 'ui_compass_pos');
  }

  // Expose a small API for other scripts
  window.BHH = window.BHH || {};
  window.BHH.fieldInfo = {
    setVisible: setInfoVisible,
    isVisible: getInfoVisible,
  };

  // Backwards compatibility for existing code in main.js
  window.setInfoVisible = setInfoVisible;
  window.getInfoVisible = getInfoVisible;
})();
