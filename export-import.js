// export-import.js
// Handles:
// - Export (JSON, KML, GPX)
// - Import (JSON/GeoJSON, KML, GPX)
// - Delete Mode toggle button
//
// Now enriched so KML/GPX carry BHH metadata (type + notes + photo).

(() => {
  const btnExport = document.getElementById('btnExport');
  const btnImport = document.getElementById('btnImport');
  const btnDelete = document.getElementById('btnDeleteMode');
  const fileInput = document.getElementById('fileImport');

  /* ---------- helpers: generic ---------- */
  function downloadText(filename, text, mime = 'application/octet-stream') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function escapeXml(s) {
    return String(s || '').replace(/[<>&'"]/g, ch => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      "'": '&apos;',
      '"': '&quot;',
    }[ch]));
  }

  /* ---------- EXPORT BUILDERS ---------- */
  /** Collect current state */
  function collectAll() {
    const drawings = JSON.parse(
      localStorage.getItem('bhh_drawings_v6') ||
        '{"geojson":{"type":"FeatureCollection","features":[]},"circles":[]}'
    );

    const markers = (() => {
      const out = [];
      // markersLayer is defined in main.js
      if (typeof markersLayer !== 'undefined' && markersLayer.eachLayer) {
        markersLayer.eachLayer(m => {
          const { lat, lng } = m.getLatLng();
          out.push({
            id: m.options.id,
            name: m.options.name,
            type: m.options.type,
            lat,
            lng,
            notes: m.options.notes || '',
            photo: m.options.photo || '',
          });
        });
      }
      return out;
    })();

    const track = (() => {
      try {
        return JSON.parse(localStorage.getItem('bhh_track_v1') || '[]');
      } catch {
        return [];
      }
    })();

    return { drawings, markers, track };
  }

  /** Convert a Leaflet circle to a polygon ring (for KML/GPX export) */
  function circleToRing(lat, lng, radiusM, segments = 64) {
    // uses destPoint(lat, lng, bearing, distM) defined in main.js (wind section)
    if (typeof destPoint !== 'function') {
      console.warn('[BHH] destPoint missing; circles may not export correctly.');
      return [];
    }

    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const ang = (i / segments) * 360;
      pts.push(destPoint(lat, lng, ang, radiusM));
    }
    return pts;
  }

  /** Build KML (with BHH metadata for markers) */
  function buildKML() {
    const { drawings, markers, track } = collectAll();

    let kml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<kml xmlns="http://www.opengis.net/kml/2.2" ` +
      `xmlns:gx="http://www.google.com/kml/ext/2.2">\n` +
      `<Document><name>BuckeyeHunterHub</name>\n`;

    // Markers -> Placemark Points (+ ExtendedData bhh_json)
    kml += `<Folder><name>Markers</name>\n`;
    markers.forEach(m => {
      const meta = {
        t: m.type || 'stand',       // type
        n: m.notes || '',           // notes
        p: m.photo || '',           // photo data URL
      };
      const metaStr = escapeXml(JSON.stringify(meta));

      kml +=
        `<Placemark>` +
        `<name>${escapeXml(m.name)}</name>` +
        (m.notes ? `<description>${escapeXml(m.notes)}</description>` : '') +
        `<Point><coordinates>${m.lng},${m.lat},0</coordinates></Point>` +
        `<ExtendedData>` +
        `<Data name="bhh_json"><value>${metaStr}</value></Data>` +
        `</ExtendedData>` +
        `</Placemark>\n`;
    });
    kml += `</Folder>\n`;

    // Drawings -> polygons/polylines/circles
    kml += `<Folder><name>Drawings</name>\n`;

    // GeoJSON features
    const feats =
      drawings.geojson && drawings.geojson.features
        ? drawings.geojson.features
        : [];

    feats.forEach(f => {
      const props = f.properties || {};
      const nm = props.name || props.shapeType || 'Shape';
      if (!f.geometry) return;

      if (f.geometry.type === 'LineString') {
        const coords = f.geometry.coordinates
          .map(c => `${c[0]},${c[1]},0`)
          .join(' ');
        kml +=
          `<Placemark><name>${escapeXml(nm)}</name>` +
          `<LineString><tessellate>1</tessellate>` +
          `<coordinates>${coords}</coordinates>` +
          `</LineString></Placemark>\n`;
      } else if (f.geometry.type === 'Polygon') {
        const ring = (f.geometry.coordinates && f.geometry.coordinates[0]) || [];
        const coords = ring.map(c => `${c[0]},${c[1]},0`).join(' ');
        kml +=
          `<Placemark><name>${escapeXml(nm)}</name>` +
          `<Polygon><outerBoundaryIs><LinearRing>` +
          `<coordinates>${coords}</coordinates>` +
          `</LinearRing></outerBoundaryIs></Polygon>` +
          `</Placemark>\n`;
      } else if (f.geometry.type === 'MultiPolygon') {
        (f.geometry.coordinates || []).forEach((poly, idx) => {
          const ring = poly[0] || [];
          const coords = ring.map(c => `${c[0]},${c[1]},0`).join(' ');
          kml +=
            `<Placemark><name>${escapeXml(nm)} (${idx + 1})</name>` +
            `<Polygon><outerBoundaryIs><LinearRing>` +
            `<coordinates>${coords}</coordinates>` +
            `</LinearRing></outerBoundaryIs></Polygon>` +
            `</Placemark>\n`;
        });
      }
    });

    // Circles
    (drawings.circles || []).forEach(c => {
      const name = (c.properties && c.properties.name) || 'Circle';
      const ringPts = circleToRing(c.lat, c.lng, c.radius);
      const coords = ringPts.map(p => `${p.lng},${p.lat},0`).join(' ');
      kml +=
        `<Placemark><name>${escapeXml(name)}</name>` +
        `<Polygon><outerBoundaryIs><LinearRing>` +
        `<coordinates>${coords}</coordinates>` +
        `</LinearRing></outerBoundaryIs></Polygon>` +
        `</Placemark>\n`;
    });

    // Track -> gx:Track or LineString
    if (track && track.length) {
      const hasTime = track.every(p => typeof p.t === 'number');

      if (hasTime) {
        kml += `<Placemark><name>Track</name><gx:Track>\n`;
        track.forEach(p => {
          kml += `<when>${new Date(p.t).toISOString()}</when>\n`;
        });
        track.forEach(p => {
          kml += `<gx:coord>${p.lng} ${p.lat} 0</gx:coord>\n`;
        });
        kml += `</gx:Track></Placemark>\n`;
      } else {
        const coords = track.map(p => `${p.lng},${p.lat},0`).join(' ');
        kml +=
          `<Placemark><name>Track</name>` +
          `<LineString><tessellate>1</tessellate>` +
          `<coordinates>${coords}</coordinates></LineString>` +
          `</Placemark>\n`;
      }
    }

    kml += `</Document></kml>`;
    return kml;
  }

  /** Build GPX (markers->wpt with bhh_meta, shapes->rte, track->trk) */
  function buildGPX() {
    const { drawings, markers, track } = collectAll();

    let gpx =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="BuckeyeHunterHub" ` +
      `xmlns="http://www.topografix.com/GPX/1/1">\n`;

    // Waypoints (include BHH metadata in <extensions><bhh_meta>...</bhh_meta>)
    markers.forEach(m => {
      const meta = {
        t: m.type || 'stand',
        n: m.notes || '',
        p: m.photo || '',
      };
      const metaStr = escapeXml(JSON.stringify(meta));

      gpx +=
        `<wpt lat="${m.lat}" lon="${m.lng}">` +
        `<name>${escapeXml(m.name)}</name>` +
        (m.notes ? `<desc>${escapeXml(m.notes)}</desc>` : '') +
        `<extensions><bhh_meta>${metaStr}</bhh_meta></extensions>` +
        `</wpt>\n`;
    });

    // Routes from drawings
    const feats =
      drawings.geojson && drawings.geojson.features
        ? drawings.geojson.features
        : [];
    let rteIdx = 1;

    feats.forEach(f => {
      const props = f.properties || {};
      const nm = props.name || props.shapeType || `Route ${rteIdx}`;
      if (!f.geometry) return;

      if (f.geometry.type === 'LineString') {
        const line = f.geometry.coordinates;
        gpx += `<rte><name>${escapeXml(nm)}</name>\n`;
        line.forEach(c => {
          gpx += `<rtept lat="${c[1]}" lon="${c[0]}"></rtept>\n`;
        });
        gpx += `</rte>\n`;
        rteIdx++;
      } else if (f.geometry.type === 'Polygon') {
        const ring =
          (f.geometry.coordinates && f.geometry.coordinates[0]) || [];
        if (ring.length) {
          gpx += `<rte><name>${escapeXml(nm)} (polygon)</name>\n`;
          ring.forEach(c => {
            gpx += `<rtept lat="${c[1]}" lon="${c[0]}"></rtept>\n`;
          });
          gpx += `</rte>\n`;
          rteIdx++;
        }
      } else if (f.geometry.type === 'MultiPolygon') {
        (f.geometry.coordinates || []).forEach((poly, idx) => {
          const ring = poly[0] || [];
          if (ring.length) {
            gpx +=
              `<rte><name>${escapeXml(nm)} (part ${idx + 1})</name>\n`;
            ring.forEach(c => {
              gpx += `<rtept lat="${c[1]}" lon="${c[0]}"></rtept>\n`;
            });
            gpx += `</rte>\n`;
            rteIdx++;
          }
        });
      }
    });

    // Circles as closed route
    (drawings.circles || []).forEach(c => {
      const name = (c.properties && c.properties.name) || 'Circle';
      const ringPts = circleToRing(c.lat, c.lng, c.radius);
      gpx += `<rte><name>${escapeXml(name)}</name>\n`;
      ringPts.forEach(p => {
        gpx += `<rtept lat="${p.lat}" lon="${p.lng}"></rtept>\n`;
      });
      gpx += `</rte>\n`;
    });

    // Track
    if (track && track.length) {
      const name =
        'BHH Track ' +
        new Date(track[0].t || Date.now()).toISOString().slice(0, 10);
      gpx += `<trk><name>${escapeXml(name)}</name><trkseg>\n`;
      track.forEach(p => {
        gpx +=
          `<trkpt lat="${p.lat}" lon="${p.lng}">` +
          (p.t ? `<time>${new Date(p.t).toISOString()}</time>` : '') +
          `</trkpt>\n`;
      });
      gpx += `</trkseg></trk>\n`;
    }

    gpx += `</gpx>`;
    return gpx;
  }

  /* ---------- IMPORTERS ---------- */
  function parseKML(text) {
    const dom = new DOMParser().parseFromString(text, 'application/xml');
    const $ = (sel, root = dom) => Array.from(root.getElementsByTagName(sel));
    const gx = (sel, root = dom) =>
      Array.from(
        root.getElementsByTagNameNS(
          'http://www.google.com/kml/ext/2.2',
          sel
        )
      );

    // Points -> markers (+ BHH metadata)
    $('Placemark').forEach(pm => {
      const name =
        pm.getElementsByTagName('name')[0]?.textContent || 'Marker';
      const desc =
        pm.getElementsByTagName('description')[0]?.textContent || '';

      // BHH ExtendedData metadata
      let meta = null;
      const ed = pm.getElementsByTagName('ExtendedData')[0];
      if (ed) {
        const datas = ed.getElementsByTagName('Data');
        for (let i = 0; i < datas.length; i++) {
          if (datas[i].getAttribute('name') === 'bhh_json') {
            const v = datas[i].getElementsByTagName('value')[0];
            if (v && v.textContent) {
              try {
                meta = JSON.parse(v.textContent);
              } catch (e) {
                console.warn('Failed to parse bhh_json', e);
              }
            }
          }
        }
      }

      const pt = pm.getElementsByTagName('Point')[0];
      if (pt && typeof addMarker === 'function') {
        const coordTxt =
          pt.getElementsByTagName('coordinates')[0]?.textContent?.trim() ||
          '';
        const [lng, lat] = coordTxt.split(/[\s,]+/).map(Number);
        if (isFinite(lat) && isFinite(lng)) {
          const mType = (meta && meta.t) || 'stand';
          const mNotes = (meta && meta.n) || desc;
          const mPhoto = (meta && meta.p) || '';
          addMarker([lat, lng], mType, name, undefined, mNotes, mPhoto);
        }
        return;
      }

      // LineString -> polyline
      const ls = pm.getElementsByTagName('LineString')[0];
      if (ls && typeof L !== 'undefined' && typeof drawnItems !== 'undefined') {
        const coordTxt =
          ls.getElementsByTagName('coordinates')[0]?.textContent || '';
        const pairs = coordTxt
          .trim()
          .split(/\s+/)
          .map(s => s.split(',').map(Number));
        const latlngs = pairs.map(p => L.latLng(p[1], p[0]));
        const layer = L.polyline(latlngs, { color: '#6dbc5d' });
        layer._bhhName = name;
        drawnItems.addLayer(layer);
        return;
      }

      // Polygon -> polygon
      const poly = pm.getElementsByTagName('Polygon')[0];
      if (poly && typeof L !== 'undefined' && typeof drawnItems !== 'undefined') {
        const ringTxt =
          poly.getElementsByTagName('coordinates')[0]?.textContent || '';
        const pairs = ringTxt
          .trim()
          .split(/\s+/)
          .map(s => s.split(',').map(Number));
        const latlngs = pairs.map(p => L.latLng(p[1], p[0]));
        const layer = L.polygon(latlngs, {
          color: '#6dbc5d',
          fillOpacity: 0.15,
        });
        layer._bhhName = name;
        drawnItems.addLayer(layer);
        return;
      }

      // gx:Track -> trackPoints
      const trackNode = gx('Track', pm)[0];
      if (
        trackNode &&
        typeof L !== 'undefined' &&
        typeof trackLayer !== 'undefined'
      ) {
        const whens = Array.from(
          trackNode.getElementsByTagName('when')
        ).map(n => new Date(n.textContent).getTime());
        const coords = gx('coord', trackNode).map(n =>
          n.textContent
            .trim()
            .split(/\s+/)
            .map(Number)
        ); // lng lat alt

        const pts = [];
        for (let i = 0; i < coords.length; i++) {
          const [lng, lat] = coords[i];
          const t = whens[i] || Date.now();
          if (isFinite(lat) && isFinite(lng)) pts.push({ lat, lng, t });
        }

        if (pts.length) {
          if (typeof trackPoints !== 'undefined') {
            trackPoints = pts;
          }
          trackLayer.setLatLngs(pts.map(p => [p.lat, p.lng]));
          if (typeof saveTrack === 'function') {
            saveTrack();
          }
        }
      }
    });

    if (typeof saveDraw === 'function') saveDraw();
    if (typeof saveMarkers === 'function') saveMarkers();
  }

  function parseGPX(text) {
    const dom = new DOMParser().parseFromString(text, 'application/xml');
    const $ = (sel, root = dom) => Array.from(root.getElementsByTagName(sel));

    // wpt -> markers (+ BHH metadata)
    $('wpt').forEach(n => {
      const lat = parseFloat(n.getAttribute('lat'));
      const lon = parseFloat(n.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lon)) return;

      const name =
        n.getElementsByTagName('name')[0]?.textContent || 'Marker';
      const desc =
        n.getElementsByTagName('desc')[0]?.textContent || '';

      let meta = null;
      const exts = n.getElementsByTagName('extensions')[0];
      if (exts) {
        const bhh = exts.getElementsByTagName('bhh_meta')[0];
        if (bhh && bhh.textContent) {
          try {
            meta = JSON.parse(bhh.textContent);
          } catch (e) {
            console.warn('Failed to parse bhh_meta', e);
          }
        }
      }

      const mType = (meta && meta.t) || 'stand';
      const mNotes = (meta && meta.n) || desc;
      const mPhoto = (meta && meta.p) || '';

      if (typeof addMarker === 'function') {
        addMarker([lat, lon], mType, name, undefined, mNotes, mPhoto);
      }
    });

    // rte -> polyline or polygon
    $('rte').forEach(r => {
      const pts = Array.from(r.getElementsByTagName('rtept'))
        .map(p => [
          parseFloat(p.getAttribute('lat')),
          parseFloat(p.getAttribute('lon')),
        ])
        .filter(p => isFinite(p[0]) && isFinite(p[1]));
      const name =
        r.getElementsByTagName('name')[0]?.textContent || 'Route';

      if (!pts.length || typeof L === 'undefined' || typeof drawnItems === 'undefined') return;

      const isClosed =
        pts.length > 2 &&
        Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 &&
        Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6;

      const layer = isClosed
        ? L.polygon(pts, {
            color: '#6dbc5d',
            fillOpacity: 0.15,
          })
        : L.polyline(pts, { color: '#6dbc5d' });

      layer._bhhName = name;
      drawnItems.addLayer(layer);
    });

    // trk -> main track
    const trk = $('trk')[0];
    if (trk && typeof trackLayer !== 'undefined') {
      const pts = Array.from(trk.getElementsByTagName('trkpt'))
        .map(p => {
          const lat = parseFloat(p.getAttribute('lat'));
          const lon = parseFloat(p.getAttribute('lon'));
          const time =
            p.getElementsByTagName('time')[0]?.textContent;
          const t = time ? new Date(time).getTime() : Date.now();
          return { lat, lng: lon, t };
        })
        .filter(p => isFinite(p.lat) && isFinite(p.lng));

      if (pts.length) {
        if (typeof trackPoints !== 'undefined') {
          trackPoints = pts;
        }
        trackLayer.setLatLngs(pts.map(p => [p.lat, p.lng]));
        if (typeof saveTrack === 'function') {
          saveTrack();
        }
      }
    }

    if (typeof saveDraw === 'function') saveDraw();
    if (typeof saveMarkers === 'function') saveMarkers();
  }

  /* ---------- EXPORT ACTION ---------- */
  // ---- Export dialog UI ----
if (btnExport) {
  btnExport.onclick = () => {
    showExportDialog();
  };
}

function showExportDialog() {
  // Remove existing dialog if somehow still there
  const existing = document.getElementById('bhhExportOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bhhExportOverlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '1600';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  const panel = document.createElement('div');
  panel.style.minWidth = '260px';
  panel.style.maxWidth = '320px';
  panel.style.padding = '16px 18px';
  panel.style.borderRadius = '14px';
  panel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
  panel.style.background = 'var(--panel, #101f14)';
  panel.style.border = '1px solid #203325';
  panel.style.color = 'var(--text, #e7f1e8)';
  panel.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  panel.style.fontSize = '14px';

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h3 style="margin:0;font-size:15px;">Export data</h3>
      <button type="button" id="bhhExportClose" style="
        border:1px solid #25432b;
        background:#14271a;
        color:inherit;
        border-radius:10px;
        width:26px;
        height:26px;
        cursor:pointer;
        font-size:16px;
        line-height:22px;
        text-align:center;
      ">&times;</button>
    </div>
    <p style="margin:0 0 10px;color:#a3b7a6;font-size:13px;">
      Choose a format to export your map data.
    </p>

    <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;cursor:pointer;">
      <input type="radio" name="bhhExportFormat" value="json" checked
        style="margin-top:3px;">
      <div>
        <div style="font-weight:600;">JSON – Full BHH backup</div>
        <div style="font-size:12px;color:#a3b7a6;">
          Best for restoring or moving everything between browsers/devices.
          Keeps waypoints, types, icons, notes, photos, drawings, and track.
        </div>
      </div>
    </label>

    <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;cursor:pointer;">
      <input type="radio" name="bhhExportFormat" value="kml"
        style="margin-top:3px;">
      <div>
        <div style="font-weight:600;">KML – Map apps / Google Earth</div>
        <div style="font-size:12px;color:#a3b7a6;">
          Good for Google Earth and other map apps. Includes BHH metadata
          (types, notes, photos) when you import back into this map.
          Other apps may ignore the extra info.
        </div>
      </div>
    </label>

    <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;cursor:pointer;">
      <input type="radio" name="bhhExportFormat" value="gpx"
        style="margin-top:3px;">
      <div>
        <div style="font-weight:600;">GPX – GPS / hunting apps</div>
        <div style="font-size:12px;color:#a3b7a6;">
          Common for GPS devices and hunting apps. Also carries BHH metadata
          for re-import here, but most external apps will only use the basic
          points/lines/track.
        </div>
      </div>
    </label>

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
      <button type="button" id="bhhExportCancel" style="
        padding:6px 10px;
        border-radius:10px;
        border:1px solid #25432b;
        background:#14271a;
        color:inherit;
        cursor:pointer;
        font-size:13px;
      ">Cancel</button>
      <button type="button" id="bhhExportConfirm" style="
        padding:6px 12px;
        border-radius:10px;
        border:1px solid #6dbc5d;
        background:#1c3823;
        color:inherit;
        cursor:pointer;
        font-size:13px;
        font-weight:600;
      ">Export</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function closeDialog() {
    overlay.remove();
  }

  // Close on background click (but not when clicking the panel itself)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  panel.querySelector('#bhhExportClose').onclick = closeDialog;
  panel.querySelector('#bhhExportCancel').onclick = closeDialog;

  panel.querySelector('#bhhExportConfirm').onclick = () => {
    const selected = panel.querySelector('input[name="bhhExportFormat"]:checked');
    const choice = selected ? selected.value : 'json';
    closeDialog();
    doExport(choice);
  };
}

function doExport(choice) {
  const fmt = (choice || 'json').trim().toLowerCase();

  try {
    if (fmt === 'kml') {
      const kml = buildKML();
      downloadText(
        'buckeyehunterhub.kml',
        kml,
        'application/vnd.google-earth.kml+xml'
      );
    } else if (fmt === 'gpx') {
      const gpx = buildGPX();
      downloadText('buckeyehunterhub.gpx', gpx, 'application/gpx+xml');
    } else {
      const all = collectAll();
      downloadText(
        'buckeyehunterhub-export.json',
        JSON.stringify(all, null, 2),
        'application/json'
      );
    }
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
}


  /* ---------- IMPORT ACTION ---------- */
  if (btnImport && fileInput) {
    btnImport.onclick = () => fileInput.click();

    fileInput.onchange = ev => {
      const f = ev.target.files[0];
      if (!f) return;

      const name = f.name.toLowerCase();
      const ext = name.endsWith('.kml')
        ? 'kml'
        : name.endsWith('.gpx')
        ? 'gpx'
        : name.endsWith('.geojson')
        ? 'geojson'
        : name.endsWith('.json')
        ? 'json'
        : 'auto';

      const r = new FileReader();
      r.onload = () => {
        try {
          const text = r.result;

          if (ext === 'kml') {
            parseKML(text);
          } else if (ext === 'gpx') {
            parseGPX(text);
          } else {
            // JSON / GeoJSON fallback (legacy)
            const obj = JSON.parse(text);

            if (
              obj.drawings &&
              (obj.drawings.geojson || obj.drawings.circles)
            ) {
              localStorage.setItem(
                'bhh_drawings_v6',
                JSON.stringify(obj.drawings)
              );

              if (
                typeof drawnItems !== 'undefined' &&
                typeof segmentLabelsGroup !== 'undefined'
              ) {
                drawnItems.clearLayers();
                segmentLabelsGroup.clearLayers();
              }

              if (typeof restoreDraw === 'function') {
                restoreDraw();
              }
            } else if (
              obj.type === 'FeatureCollection' ||
              obj.type === 'Feature'
            ) {
              // plain GeoJSON into drawings
              if (typeof L !== 'undefined' && typeof drawnItems !== 'undefined') {
                L.geoJSON(obj, {
                  onEachFeature: (_, l) => drawnItems.addLayer(l),
                });
              }
              localStorage.setItem(
                'bhh_drawings_v6',
                JSON.stringify({ geojson: obj, circles: [] })
              );
            }

            if (obj.markers && typeof deserializeMarkers === 'function') {
              deserializeMarkers(obj.markers);
            }

            if (obj.track) {
              localStorage.setItem('bhh_track_v1', JSON.stringify(obj.track));
              try {
                const raw = localStorage.getItem('bhh_track_v1');
                if (raw && typeof trackLayer !== 'undefined') {
                  trackPoints = JSON.parse(raw) || [];
                  trackLayer.setLatLngs(
                    trackPoints.map(p => [p.lat, p.lng])
                  );
                }
              } catch {}
            }
          }

          if (typeof refreshWaypointsUI === 'function') {
            refreshWaypointsUI();
          }
          if (typeof updateTrackStats === 'function') {
            updateTrackStats();
          }
        } catch (e) {
          alert('Import failed: ' + e.message);
        } finally {
          ev.target.value = '';
        }
      };

      r.readAsText(f);
    };
  }

  /* ---------- DELETE MODE BUTTON ---------- */
  if (btnDelete) {
    btnDelete.onclick = () => {
      // deleteMode is the shared global flag used by markers/waypoints
      if (typeof deleteMode === 'undefined') {
        // should already exist from main.js, but just in case
        window.deleteMode = false;
      }
      deleteMode = !deleteMode;
      btnDelete.textContent = `Delete: ${deleteMode ? 'On' : 'Off'}`;
    };
  }
})();
