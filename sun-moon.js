// sun-moon.js
// Handles:
// - Sun times for the Field Info panel (updateSun)
// - Moon phases + next 7 days list for the Moon sheet (renderMoon)

(() => {
  if (typeof SunCalc === 'undefined') {
    console.warn('[BHH] SunCalc not loaded; sun/moon features disabled.');
    return;
  }

  if (typeof map === 'undefined') {
    console.warn('[BHH] Leaflet map not available yet when sun-moon.js ran.');
    // We still define updateSun/renderMoon so other code can call them later,
    // but we won't attach map listeners until map exists.
  }

  function updateSun() {
    if (typeof map === 'undefined' || !map.getCenter) return;

    const c = map.getCenter();
    const now = new Date();
    const t = SunCalc.getTimes(now, c.lat, c.lng);

    const fmt = d =>
      d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

    const sunriseEl = document.getElementById('pSunrise');
    const sunsetEl  = document.getElementById('pSunset');
    const dayEl     = document.getElementById('pDay');

    if (sunriseEl) sunriseEl.textContent = fmt(t.sunrise);
    if (sunsetEl)  sunsetEl.textContent  = fmt(t.sunset);

    const mins = Math.max(0, ((t.sunset - t.sunrise) / 60000) | 0);
    if (dayEl) dayEl.textContent = `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  function phaseName(phase) {
    const p = (phase + 1) % 1;
    if (p < 0.03 || p > 0.97) return 'New Moon';
    if (p < 0.22) return 'Waxing Crescent';
    if (p < 0.28) return 'First Quarter';
    if (p < 0.47) return 'Waxing Gibbous';
    if (p < 0.53) return 'Full Moon';
    if (p < 0.72) return 'Waning Gibbous';
    if (p < 0.78) return 'Last Quarter';
    return 'Waning Crescent';
  }

  function phaseEmoji(phase) {
    const p = (phase + 1) % 1;
    if (p < 0.03 || p > 0.97) return '🌑';
    if (p < 0.22) return '🌒';
    if (p < 0.28) return '🌓';
    if (p < 0.47) return '🌔';
    if (p < 0.53) return '🌕';
    if (p < 0.72) return '🌖';
    if (p < 0.78) return '🌗';
    return '🌘';
  }

  function renderMoon() {
    if (typeof map === 'undefined' || !map.getCenter) return;

    const c   = map.getCenter();
    const now = new Date();

    const illum = SunCalc.getMoonIllumination(now);
    const mt    = SunCalc.getMoonTimes(now, c.lat, c.lng, true);

    const fmt = d =>
      d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

    const pct = Math.round(illum.fraction * 100);

    let html =
      `<div class="row"><span>Today</span>` +
      `<strong class="tag">${phaseEmoji(illum.phase)} ${phaseName(illum.phase)} · ${pct}%</strong></div>` +
      `<div class="row"><span>Moonrise</span><strong class="tag">${fmt(mt.rise)}</strong></div>` +
      `<div class="row"><span>Moonset</span><strong class="tag">${fmt(mt.set)}</strong></div>` +
      `<p class="tag" style="margin-top:6px">Next 7 days</p>`;

    for (let i = 1; i <= 7; i++) {
      const d  = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const im = SunCalc.getMoonIllumination(d);
      const tt = SunCalc.getMoonTimes(d, c.lat, c.lng, true);

      html +=
        `<div class="row">` +
        `<span>${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>` +
        `<strong class="tag">` +
        `${phaseEmoji(im.phase)} ${Math.round(im.fraction * 100)}% · ${fmt(tt.rise)} / ${fmt(tt.set)}` +
        `</strong></div>`;
    }

    const moonContent = document.getElementById('moonContent');
    if (moonContent) moonContent.innerHTML = html;
  }

  // Attach to map if it exists now
  if (typeof map !== 'undefined' && map && map.on) {
    updateSun();
    map.on('moveend', updateSun);
  }

  // Expose to other scripts (e.g. field-info, sheets)
  window.updateSun  = updateSun;
  window.renderMoon = renderMoon;
})();

