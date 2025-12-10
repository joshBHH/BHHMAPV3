// hunt-score.js
// Handles the Hunt Score (next 48h) panel logic

(() => {
  if (typeof map === 'undefined') {
    console.warn('[BHH] map not available when hunt-score.js ran.');
    return;
  }

  const scoreList      = document.getElementById('scoreList');
  const scoreRefreshBtn = document.getElementById('scoreRefresh');
  const scoreLocRadios = Array.from(document.querySelectorAll('input[name="scoreLoc"]'));

  if (!scoreList || !scoreRefreshBtn || !scoreLocRadios.length) {
    console.warn('[BHH] Hunt Score DOM elements not found; skipping hunt-score init.');
    return;
  }

  function gauss(x, mu, sigma) {
    const z = (x - mu) / sigma;
    return Math.exp(-0.5 * z * z);
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  async function fetchForecast(lat, lng) {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}` +
      `&longitude=${lng}` +
      `&hourly=temperature_2m,wind_speed_10m,precipitation_probability,cloud_cover,surface_pressure` +
      `&daily=sunrise,sunset` +
      `&forecast_days=3` +
      `&timezone=auto` +
      `&wind_speed_unit=mph`;

    const r = await fetch(url);
    if (!r.ok) throw new Error('forecast fetch failed');
    return r.json();
  }

  function buildSunWindows(daily) {
    const windows = {};
    if (!daily || !daily.time) return windows;

    for (let i = 0; i < daily.time.length; i++) {
      windows[daily.time[i]] = {
        sr: new Date(daily.sunrise[i]),
        ss: new Date(daily.sunset[i]),
      };
    }
    return windows;
  }

  function lunarBoost(date, lat, lng) {
    if (typeof SunCalc === 'undefined') return 0;

    const ill = SunCalc.getMoonIllumination(date);
    const pos = SunCalc.getMoonPosition(date, lat, lng);

    const frac = ill.fraction;
    const alt  = pos.altitude;

    let boost = 0;

    // Dark-moon, low-altitude bonus
    if (frac < 0.3) {
      boost += clamp((0.3 - frac) / 0.3, 0, 1) *
               clamp((0.2 - Math.abs(alt)) / 0.2, 0, 1) *
               12;
    }
    // Bright full-moon, high-altitude slight bonus
    else if (frac > 0.7) {
      boost += clamp((frac - 0.7) / 0.3, 0, 1) *
               clamp((alt - 0.4) / 0.6, 0, 1) *
               8;
    }

    return boost;
  }

  async function computeHuntScore() {
    scoreList.innerHTML = '<p class="tag">Loading forecast…</p>';

    let anchor = map.getCenter();
    const which = (scoreLocRadios.find(r => r.checked) || {}).value || 'gps';

    // If GPS chosen, try to use current position
    if (which === 'gps' && navigator.geolocation) {
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(
            p => res(p),
            e => rej(e),
            { enableHighAccuracy: true, timeout: 6000 }
          )
        );
        anchor = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (_) {
        // fall back to map center
      }
    }

    let data;
    try {
      data = await fetchForecast(anchor.lat, anchor.lng);
    } catch (e) {
      scoreList.innerHTML = '<p class="tag">Forecast unavailable.</p>';
      return;
    }

    const hourly = data.hourly || {};
    const times  = (hourly.time || []).map(t => new Date(t));
    const ws     = hourly.wind_speed_10m || [];
    const tp     = hourly.temperature_2m || [];
    const pr     = hourly.precipitation_probability || [];
    const cc     = hourly.cloud_cover || [];

    const sun = buildSunWindows(data.daily || { time: [], sunrise: [], sunset: [] });

    // Median temp by day to bias “cooler than average”
    const byDay = {};
    times.forEach((d, i) => {
      const key = d.toISOString().slice(0, 10);
      (byDay[key] || (byDay[key] = { temps: [] })).temps.push(tp[i]);
    });

    const medByDay = {};
    Object.keys(byDay).forEach(k => {
      const arr = byDay[k].temps.slice().sort((a, b) => a - b);
      const m = arr[Math.floor(arr.length / 2)] ?? arr[0] ?? 0;
      medByDay[k] = m;
    });

    const rows = [];

    for (let i = 0; i < times.length; i++) {
      const d       = times[i];
      const dateKey = d.toISOString().slice(0, 10);

      // Light weighting around sunrise/sunset
      let light = 0.2;
      const dayWin = sun[dateKey];

      if (dayWin) {
        const minsFrom = a => Math.abs((d - a) / 60000);
        light = Math.max(
          gauss(minsFrom(dayWin.sr), 0, 65),
          gauss(minsFrom(dayWin.ss), 0, 65)
        );
      }
      light = clamp(light, 0, 1);

      const w      = ws[i] ?? 0;
      const wind   = Math.max(gauss(w, 8, 4), gauss(w, 10, 5));

      const t      = tp[i] ?? 0;
      const med    = medByDay[dateKey] ?? t;
      const temp   = clamp((med - t) / 12, -0.5, 1);

      const p      = pr[i] ?? 0;
      const precip = 1 - clamp((p - 30) / 70, 0, 1);

      const cloud  = 1 - (cc[i] || 0) / 300;

      const lunar  = lunarBoost(d, anchor.lat, anchor.lng) / 12;

      const score =
        clamp(
          (light * 0.38 +
            wind * 0.22 +
            (temp + 0.5) * 0.16 +
            precip * 0.18 +
            cloud * 0.02 +
            lunar * 0.04) * 100,
          0,
          100
        );

      rows.push({ d, score: Math.round(score) });
    }

    const now = new Date();
    const next48 = rows.filter(r => r.d - now >= 0 && r.d - now <= 48 * 3600 * 1000);

    next48.sort((a, b) => b.score - a.score);
    const top = next48.slice(0, 16).sort((a, b) => a.d - b.d);

    scoreList.innerHTML =
      top
        .map(r => {
          const bar  = Math.round(r.score);
          const time = r.d.toLocaleString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
          });
          return (
            `<div class="score-item">` +
            `<div class="tag">${time}</div>` +
            `<div class="bar"><span style="width:${bar}%"></span></div>` +
            `<div class="tag" style="text-align:right">${bar} / 100</div>` +
            `</div>`
          );
        })
        .join('') || '<p class="tag">No forecast rows.</p>';
  }

  // Wire the refresh button
  scoreRefreshBtn.onclick = () => computeHuntScore();

  // Expose for sheets.js / main.js (openSheet('score'))
  window.computeHuntScore = computeHuntScore;
})();
