/*******************
 * MAP & BASELAYERS
 *******************/
// [BHH: MAP INIT START]
const map = L.map('map').setView([40.4173, -82.9071], 7);

// MapTiler basemaps (replace key if needed)
const basic = L.tileLayer(
  'https://api.maptiler.com/maps/basic/{z}/{x}/{y}.png?key=VLOZCnjQYBtgpZ3BXBK3',
  { attribution: '&copy; MapTiler & OpenStreetMap contributors' }
);
const satellite = L.tileLayer(
  'https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=VLOZCnjQYBtgpZ3BXBK3',
  { attribution: '&copy; MapTiler' }
);
const topo = L.tileLayer(
  'https://api.maptiler.com/maps/topo/{z}/{x}/{y}.png?key=VLOZCnjQYBtgpZ3BXBK3',
  { attribution: '&copy; MapTiler & OpenStreetMap contributors' }
);
const hybrid = L.tileLayer(
  'https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.jpg?key=VLOZCnjQYBtgpZ3BXBK3',
  { attribution: '&copy; MapTiler' }
);

// Default to Hybrid on first load; then respect saved choice
hybrid.addTo(map);
const baseByKey = { basic, satellite, topo, hybrid };
const STORAGE_BASE = 'ui_basemap_key';

function setBasemap(key) {
  Object.values(baseByKey).forEach(l => map.removeLayer(l));
  (baseByKey[key] || hybrid).addTo(map);
  localStorage.setItem(STORAGE_BASE, key);
}

(function restoreBasemap() {
  const k = localStorage.getItem(STORAGE_BASE);
  if (k && baseByKey[k]) setBasemap(k);
})();
// [BHH: MAP INIT END]


/*******************
 * DRAWING LAYERS (toolbar removed, storage intact)
 *******************/
// [BHH: DRAW – STORAGE START]
const drawnItems = new L.FeatureGroup().addTo(map);
const segmentLabelsGroup = L.layerGroup().addTo(map); // used by distance & area labels
const STORAGE_DRAW = 'bhh_drawings_v6';

// helper: detect shape type
function featureTypeFromLayer(l) {
  if (l instanceof L.Circle) return 'circle';
  if (l instanceof L.Rectangle) return 'rectangle';
  if (l instanceof L.Polygon && !(l instanceof L.Rectangle)) return 'polygon';
  if (l instanceof L.Polyline && !(l instanceof L.Polygon)) return 'polyline';
  return 'shape';
}

function defaultShapeName(type) {
  const base = {
    polyline: 'Line',
    polygon: 'Area',
    rectangle: 'Plot',
    circle: 'Circle',
    shape: 'Shape'
  }[type] || 'Shape';

  let n = 1;
  drawnItems.eachLayer(l => {
    if (featureTypeFromLayer(l) === type) n++;
  });
  return `${base} ${n}`;
}

// label cleanup helpers
function removeSegLabels(layer) {
  if (layer._segLabels) {
    layer._segLabels.forEach(lbl => segmentLabelsGroup.removeLayer(lbl));
    layer._segLabels = null;
  }
}
function removeTotalLabel(layer) {
  if (layer._totalLabel) {
    segmentLabelsGroup.removeLayer(layer._totalLabel);
    layer._totalLabel = null;
  }
}
function removeShapeLabel(layer) {
  if (layer._shapeLabel) {
    segmentLabelsGroup.removeLayer(layer._shapeLabel);
    layer._shapeLabel = null;
  }
}

// Save drawings (circles handled separately)
function saveDraw() {
  const geojson = { type: 'FeatureCollection', features: [] };
  const circles = [];

  drawnItems.eachLayer(l => {
    const type = featureTypeFromLayer(l);
    if (type === 'circle') {
      const c = l.getLatLng();
      circles.push({
        lat: c.lat,
        lng: c.lng,
        radius: l.getRadius(),
        properties: {
          name: l._bhhName || defaultShapeName('circle'),
          shapeType: 'circle'
        }
      });
    } else {
      const f = l.toGeoJSON();
      f.properties = Object.assign({}, f.properties || {}, {
        name: l._bhhName || defaultShapeName(type),
        shapeType: type
      });
      geojson.features.push(f);
    }
  });

  const bundle = { geojson, circles };
  localStorage.setItem(STORAGE_DRAW, JSON.stringify(bundle));
}

// attach “tap to delete” for shapes when Delete mode is on
function attachShapeDeleteHandler(layer) {
  layer.on('click', () => {
    if (!deleteMode) return;
    drawnItems.removeLayer(layer);
    removeSegLabels(layer);
    removeTotalLabel(layer);
    removeShapeLabel(layer);
    saveDraw();
    refreshWaypointsUI();
  });
}

// Restore drawings
function restoreDraw() {
  const raw = localStorage.getItem(STORAGE_DRAW);
  if (!raw) return;

  try {
    const data = JSON.parse(raw);
    if (data && data.geojson) {
      L.geoJSON(data.geojson, {
        onEachFeature: (feat, layer) => {
          const type = featureTypeFromLayer(layer);
          layer._bhhName =
            (feat.properties && feat.properties.name) ||
            defaultShapeName(type);

          drawnItems.addLayer(layer);

          if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
            // Distance labels for polylines
            labelPolylineSegments(layer);
            updatePolylineTotalLabel(layer);
          } else if (
            layer instanceof L.Polygon ||
            layer instanceof L.Rectangle ||
            layer instanceof L.Circle
          ) {
            // Area / perimeter metrics
            updateShapeMetrics(layer);
          }

          attachShapeDeleteHandler(layer);
        }
      });

      (data.circles || []).forEach(c => {
        const layer = L.circle([c.lat, c.lng], { radius: c.radius });
        layer._bhhName =
          (c.properties && c.properties.name) ||
          defaultShapeName('circle');
        drawnItems.addLayer(layer);
        updateShapeMetrics(layer);
        attachShapeDeleteHandler(layer);
      });

    } else if (data.type === 'FeatureCollection') { // legacy
      L.geoJSON(data, {
        onEachFeature: (_, layer) => {
          const type = featureTypeFromLayer(layer);
          layer._bhhName = defaultShapeName(type);
          drawnItems.addLayer(layer);
          if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
            labelPolylineSegments(layer);
            updatePolylineTotalLabel(layer);
          }
          attachShapeDeleteHandler(layer);
        }
      });
    }
  } catch (e) {
    console.warn('restore drawings failed', e);
  }
}
restoreDraw();
// [BHH: DRAW – STORAGE END]


// [BHH: DRAW – CONTROLS START]
let activeDrawHandler = null;

function ensureDrawPlugin() {
  if (!L.Draw || !L.Draw.Polyline) {
    alert('Drawing tools not available (Leaflet.draw not loaded).');
    return false;
  }
  return true;
}

function startDraw(shapeType) {
  if (!ensureDrawPlugin()) return;

  // Disable any previous drawing session
  if (activeDrawHandler) {
    activeDrawHandler.disable();
    activeDrawHandler = null;
  }

  const baseOpts = {
    shapeOptions: {
      color: '#f97316',
      weight: 3,
      opacity: 0.9
    }
  };

  switch (shapeType) {
    case 'line':
      activeDrawHandler = new L.Draw.Polyline(map, baseOpts);
      break;
    case 'polygon':
      activeDrawHandler = new L.Draw.Polygon(map, baseOpts);
      break;
    case 'rectangle':
      activeDrawHandler = new L.Draw.Rectangle(map, baseOpts);
      break;
    case 'circle':
      activeDrawHandler = new L.Draw.Circle(map, {
        shapeOptions: baseOpts.shapeOptions
      });
      break;
    default:
      return;
  }

  activeDrawHandler.enable();
}

// When a shape is finished, add it to drawnItems + save
map.on(L.Draw.Event.CREATED, function (e) {
  const layer = e.layer;
  const type = featureTypeFromLayer(layer);

  // give it a name up front
  layer._bhhName = defaultShapeName(type);
  drawnItems.addLayer(layer);

  // Distance labels for polylines
  if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
    labelPolylineSegments(layer);
    updatePolylineTotalLabel(layer);
  } else if (
    layer instanceof L.Polygon ||
    layer instanceof L.Rectangle ||
    layer instanceof L.Circle
  ) {
    updateShapeMetrics(layer);
  }

  attachShapeDeleteHandler(layer);
  saveDraw();

  // Stop drawing after one shape
  if (activeDrawHandler) {
    activeDrawHandler.disable();
    activeDrawHandler = null;
  }
});

// Wire buttons in the Tools sheet
const drawLineBtn = document.getElementById('drawLineBtn');
const drawPolygonBtn = document.getElementById('drawPolygonBtn');
const drawRectBtn = document.getElementById('drawRectBtn');
const drawCircleBtn = document.getElementById('drawCircleBtn');

if (drawLineBtn) {
  drawLineBtn.onclick = () => {
    closeSheets();
    startDraw('line');
  };
}
if (drawPolygonBtn) {
  drawPolygonBtn.onclick = () => {
    closeSheets();
    startDraw('polygon');
  };
}
if (drawRectBtn) {
  drawRectBtn.onclick = () => {
    closeSheets();
    startDraw('rectangle');
  };
}
if (drawCircleBtn) {
  drawCircleBtn.onclick = () => {
    closeSheets();
    startDraw('circle');
  };
}
// [BHH: DRAW – CONTROLS END]


/*******************
 * DISTANCE + AREA LABELS
 *******************/
function fmtFeetMiles(m) {
  const ft = m * 3.28084;
  if (m >= 1609.344) return (m / 1609.344).toFixed(2) + ' mi';
  return Math.round(ft) + ' ft';
}

// Per-segment labels
function labelPolylineSegments(layer) {
  removeSegLabels(layer);
  const latlngs = layer.getLatLngs();
  const pts = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
  const labels = [];

  // If this is just a single segment, skip per-segment tags.
  if (pts.length <= 2) {
    layer._segLabels = [];
    return;
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = map.distance(a, b);
    const mid = L.latLng(
      (a.lat + b.lat) / 2,
      (a.lng + b.lng) / 2
    );

    const marker = L.marker(mid, {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: `<div class="seglabel">${fmtFeetMiles(d)}</div>`
      })
    });

    marker.addTo(segmentLabelsGroup);
    labels.push(marker);
  }

  layer._segLabels = labels;
}

function polylineTotalDistance(layer) {
  const latlngs = layer.getLatLngs();
  const pts = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += map.distance(pts[i - 1], pts[i]);
  }
  return d;
}

function updatePolylineTotalLabel(layer) {
  removeTotalLabel(layer);
  const latlngs = layer.getLatLngs();
  const pts = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
  if (pts.length < 2) return;

  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const anchor = L.latLng(
    (a.lat * 0.3 + b.lat * 0.7),
    (a.lng * 0.3 + b.lng * 0.7)
  );
  const total = fmtFeetMiles(polylineTotalDistance(layer));

  const marker = L.marker(anchor, {
    interactive: false,
    icon: L.divIcon({
      className: '',
      html: `<div class="seglabel"><b>Total:</b> ${total}</div>`
    })
  });

  marker.addTo(segmentLabelsGroup);
  layer._totalLabel = marker;
}

// Area + perimeter metrics for polygons / rectangles / circles
function updateShapeMetrics(layer) {
  if (!(layer instanceof L.Polygon) &&
      !(layer instanceof L.Rectangle) &&
      !(layer instanceof L.Circle)) {
    return;
  }

  removeShapeLabel(layer);

  let center = null;
  const labelLines = [];

  if (layer instanceof L.Circle) {
    const r = layer.getRadius(); // meters
    const areaM2 = Math.PI * r * r;
    const acres = areaM2 / 4046.85642;

    const ft = r * 3.28084;
    let radiusText;
    if (ft >= 5280) {
      radiusText = (ft / 5280).toFixed(2) + ' mi radius';
    } else {
      radiusText = Math.round(ft) + ' ft radius';
    }

    let areaText;
    if (acres >= 1) {
      areaText = acres.toFixed(2) + ' ac';
    } else {
      areaText = Math.round(areaM2) + ' m²';
    }

    center = layer.getLatLng();
    layer._bhhMetrics = {
      kind: 'circle',
      radiusM: r,
      radiusText,
      areaM2,
      acres,
      areaText
    };

    labelLines.push(radiusText, areaText);

  } else { // Polygon / Rectangle
    const latlngs = layer.getLatLngs();
    const pts = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
    if (pts.length < 3) return;

    // Project to meters and use shoelace formula for area
    const proj = pts.map(ll => map.options.crs.project(ll)); // {x,y} in meters
    let area = 0;
    for (let i = 0, j = proj.length - 1; i < proj.length; j = i++) {
      area += (proj[j].x * proj[i].y - proj[i].x * proj[j].y);
    }
    const areaM2 = Math.abs(area) / 2;
    const acres = areaM2 / 4046.85642;

    let areaText;
    if (acres >= 1) {
      areaText = acres.toFixed(2) + ' ac';
    } else {
      areaText = Math.round(areaM2) + ' m²';
    }

    // Perimeter
    let perM = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      perM += map.distance(a, b);
    }

    const perFt = perM * 3.28084;
    let perimeterText;
    if (perFt >= 5280) {
      perimeterText = (perFt / 5280).toFixed(2) + ' mi';
    } else {
      perimeterText = Math.round(perFt) + ' ft';
    }

    center = layer.getBounds().getCenter();
    layer._bhhMetrics = {
      kind: 'polygon',
      areaM2,
      acres,
      areaText,
      perimeterM: perM,
      perimeterText
    };

    labelLines.push(areaText, perimeterText);
  }

  if (center && labelLines.length) {
    const html =
      `<div class="seglabel">${labelLines.join('<br>')}</div>`;

    const m = L.marker(center, {
      interactive: false,
      icon: L.divIcon({ className: '', html })
    }).addTo(segmentLabelsGroup);

    layer._shapeLabel = m;
  }
}

function relabelPolyline(layer) {
  labelPolylineSegments(layer);
}


/*******************
 * OVERLAYS: Ohio Public Hunting
 *******************/
// [BHH: OVERLAYS – OHIO PUBLIC START]
const ohioPublic = L.geoJSON(null, {
  style: { color: '#8b5cf6', weight: 2, fillOpacity: 0.15 },
  onEachFeature: (feat, layer) => {
    const p = feat && feat.properties ? feat.properties : {};
    const preferred = [
      'NAME', 'AREA_NAME', 'UNIT_NAME', 'PARK_NAME', 'SITE_NAME',
      'COUNTY', 'ACRES', 'AREA_ACRES', 'OWNER', 'AGENCY', 'STATUS',
      'TYPE', 'ACCESS', 'SEASON'
    ];
    const headerKey =
      preferred.find(k => k in p) ||
      Object.keys(p)[0];
    const name = headerKey ? String(p[headerKey]) : 'Public Hunting Area';

    const keysOrdered = [
      ...new Set([
        ...preferred.filter(k => k in p),
        ...Object.keys(p)
      ])
    ].slice(0, 12);

    const rows = keysOrdered.map(k =>
      `<div><span style="color:#a3b7a6">${k}:</span> ${String(p[k])}</div>`
    ).join('');

    layer.bindPopup(
      `<b>${name}</b><div style="margin-top:6px">${rows}</div>`
    );

    layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
    layer.on('mouseout', () => layer.setStyle({ weight: 2 }));
  }
});

async function loadOhioPublic() {
  try {
    const localResp = await fetch('ohio_public_hunting.geojson', { cache: 'reload' });
    if (localResp.ok) {
      const localJson = await localResp.json();
      ohioPublic.addData(localJson);
      return;
    }
  } catch (e) {
    /* ignore local fail */
  }

  try {
    const odnrResp = await fetch(
      'https://gis2.ohiodnr.gov/ArcGIS/rest/services/OIT_Services/DNR_Fed_Lands_Nav_Base/MapServer/2/query?where=1%3D1&outFields=*&outSR=4326&f=geojson'
    );
    const odnrJson = await odnrResp.json();
    ohioPublic.addData(odnrJson);
  } catch (err) {
    console.warn('ODNR public layer fetch failed', err);
  }
}
loadOhioPublic();
// [BHH: OVERLAYS – OHIO PUBLIC END]

/*******************
 * OVERLAYS: Indiana Public Hunting (points + lands)
 *******************/
const indianaPublic = L.layerGroup();

// Shared popup builder for both points & polygons
function bindIndianaHuntingPopup(feat, layer) {
  const p = (feat && feat.properties) ? feat.properties : {};

  const preferred = [
    'NAME', 'AREA_NAME', 'UNIT_NAME', 'TRACT_NAME', 'PROPERTY',
    'PROP_NAME', 'SITE_NAME', 'HUNT_NAME',
    'COUNTY', 'ACRES', 'AREA_ACRES', 'TYPE'
  ];

  const headerKey =
    preferred.find(k => k in p) ||
    Object.keys(p)[0];

  const name = headerKey ? String(p[headerKey]) : 'Hunting Area';

  const keysOrdered = [
    ...new Set([
      ...preferred.filter(k => k in p),
      ...Object.keys(p)
    ])
  ].slice(0, 12);

  const rows = keysOrdered.map(k =>
    `<div><span style="color:#a3b7a6">${k}:</span> ${String(p[k])}</div>`
  ).join('');

  layer.bindPopup(
    `<b>${name}</b>${
      rows ? `<div style="margin-top:6px">${rows}</div>` : ''
    }`
  );

  // Only polygons/lines have setStyle – guard for points
  if (layer.setStyle) {
    layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
    layer.on('mouseout',  () => layer.setStyle({ weight: 2 }));
  }
}

// Points: "Indiana Hunting Area Points"
const indianaPublicPoints = L.geoJSON(null, {
  pointToLayer: (feat, latlng) =>
    L.circleMarker(latlng, {
      radius: 4,
      color: '#22c55e',
      fillColor: '#22c55e',
      fillOpacity: 0.9,
      weight: 1
    }),
  onEachFeature: (feat, layer) => bindIndianaHuntingPopup(feat, layer)
});

// Polygons: "Hunting Lands" layer (full areas)
const indianaHuntingLands = L.geoJSON(null, {
  style: { color: '#22c55e', weight: 2, fillOpacity: 0.15 },
  onEachFeature: (feat, layer) => bindIndianaHuntingPopup(feat, layer)
});

// Put both into one group so your existing toggle uses a single layer
indianaPublic.addLayer(indianaPublicPoints);
indianaPublic.addLayer(indianaHuntingLands);

async function loadIndianaPublic() {
  // Points
  try {
    const ptsResp = await fetch(
      'https://gisdata.in.gov/server/rest/services/Hosted/Hunting_Areas_RO/FeatureServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=geojson',
      { cache: 'reload' }
    );
    if (ptsResp.ok) {
      const ptsJson = await ptsResp.json();
      indianaPublicPoints.addData(ptsJson);
    }
  } catch (e) {
    console.warn('Indiana public hunting points load failed', e);
  }

  // Hunting Lands polygons
  try {
    const polyResp = await fetch(
      'https://gisdata.in.gov/server/rest/services/Hosted/Hunting_Areas_RO/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson',
      { cache: 'reload' }
    );
    if (polyResp.ok) {
      const polyJson = await polyResp.json();
      indianaHuntingLands.addData(polyJson);
    }
  } catch (e) {
    console.warn('Indiana hunting lands polygons load failed', e);
  }
}

loadIndianaPublic();

/*******************
 * OVERLAYS: Public Hunting (other states via remote services / local GeoJSON)
 *******************/
// These layers all use the same popup builder we used for Indiana:
//   bindIndianaHuntingPopup(feat, layer)

/*******************
 * OVERLAYS: Michigan Public Hunting
 *******************/
const michiganPublic = L.geoJSON(null, {
  style: {
    color: '#22c55e',
    weight: 2,
    fillOpacity: 0.15
  },
  onEachFeature: (feat, layer) => {
    const p = (feat && feat.properties) ? feat.properties : {};

    // Try to guess a good display name
    const preferred = [
      'NAME', 'AREA_NAME', 'UNIT_NAME', 'TRACT_NAME', 'PROPERTY',
      'PROP_NAME', 'SITE_NAME', 'HUNT_NAME', 'AREANAME',
      'COUNTY', 'ACRES', 'TYPE'
    ];

    const headerKey =
      preferred.find(k => k in p) ||
      Object.keys(p)[0];

    const name = headerKey ? String(p[headerKey]) : 'Public Hunting Area';

    const keysOrdered = [
      ...new Set([
        ...preferred.filter(k => k in p),
        ...Object.keys(p)
      ])
    ].slice(0, 12);

    const rows = keysOrdered.map(k =>
      `<div><span style="color:#a3b7a6">${k}:</span> ${String(p[k])}</div>`
    ).join('');

    layer.bindPopup(
      `<b>${name}</b>${
        rows ? `<div style="margin-top:6px">${rows}</div>` : ''
      }`
    );

    if (layer.setStyle) {
      layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
      layer.on('mouseout',  () => layer.setStyle({ weight: 2 }));
    }
  }
});

async function loadMichiganPublic() {
  // MIHUNT group-layer 30 has several polygon sublayers (31–34)
  const subLayerIds = [31, 32, 33, 34];

  // Optional: clear in case this gets called more than once
  michiganPublic.clearLayers();

  for (const id of subLayerIds) {
    try {
      const url =
        `https://gisp.mcgi.state.mi.us/arcgis/rest/services/DNR/MIHUNT/MapServer/${id}/query` +
        '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

      const resp = await fetch(url, { cache: 'reload' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      const json = await resp.json();
      michiganPublic.addData(json);
    } catch (e) {
      console.warn('Michigan public hunting sublayer', id, 'load failed', e);
    }
  }
}

loadMichiganPublic();



/*******************
 * OVERLAYS: Kentucky Public Hunting (remote ArcGIS service)
 *******************/
const kentuckyPublic = L.geoJSON(null, {
  style: { color: '#22c55e', weight: 2, fillOpacity: 0.15 },
  onEachFeature: (feat, layer) => bindIndianaHuntingPopup(feat, layer)
});

async function loadKentuckyPublic() {
  try {
    // Ky_Public_Hunting_Areas_WGS84WM – layer 1 = HuntingAreas 
    const url =
      'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Public_Hunting_Areas_WGS84WM/MapServer/1/query' +
      '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

    const r = await fetch(url, { cache: 'reload' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    kentuckyPublic.addData(j);
  } catch (e) {
    console.warn('Kentucky public hunting load failed', e);
  }
}


/*******************
 * OVERLAYS: West Virginia Public Hunting (Wildlife Management Areas)
 *******************/
const wvPublic = L.geoJSON(null, {
  style: { color: '#22c55e', weight: 2, fillOpacity: 0.15 },
  onEachFeature: (feat, layer) => bindIndianaHuntingPopup(feat, layer)
});

async function loadWvPublic() {
  try {
    // WV Boundaries FeatureServer/6 – Wildlife_Management_Areas 
    const url =
      'https://gis.transportation.wv.gov/arcgis/rest/services/Boundaries/FeatureServer/6/query' +
      '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

    const r = await fetch(url, { cache: 'reload' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    wvPublic.addData(j);
  } catch (e) {
    console.warn('West Virginia public hunting load failed', e);
  }
}


/*******************
 * OVERLAYS: Pennsylvania Public Hunting (State Game Lands)
 *******************/
const paPublic = L.geoJSON(null, {
  style: { color: '#22c55e', weight: 2, fillOpacity: 0.15 },
  onEachFeature: (feat, layer) => bindIndianaHuntingPopup(feat, layer)
});

async function loadPaPublic() {
  try {
    const url =
      'https://mapservices.pasda.psu.edu/server/rest/services/pasda/PennsylvaniaGameCommission/MapServer/4/query' +
      '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

    const resp = await fetch(url, { cache: 'reload' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const json = await resp.json();
    paPublic.clearLayers();
    paPublic.addData(json);
  } catch (e) {
    console.warn('Pennsylvania public hunting load failed', e);
  }
}



// Illinois – live from IL DNR ArcGIS service
const ilPublic = L.geoJSON(null, {
  style: { color: '#22c55e', weight: 2, fillOpacity: 0.15 },
  onEachFeature: (feat, layer) => bindIndianaHuntingPopup(feat, layer)
});

// Base ArcGIS service URL for Illinois public-hunting polygons
// (layer 19 of FedAid_and_LandUse FeatureServer)
const IL_PUBLIC_SERVICE =
  'https://gis.prairie.illinois.edu/arcgis/rest/services/OMLP/FedAid_and_LandUse/FeatureServer/19';

async function loadIlPublic() {
  if (!IL_PUBLIC_SERVICE) {
    console.warn('IL_PUBLIC_SERVICE not configured');
    return;
  }

  try {
    // Only parcels where Hunting = 'Y' (your original URL used 'N')
    const where = encodeURIComponent("Hunting = 'Y'");

    const url =
      IL_PUBLIC_SERVICE +
      '/query?where=' + where +
      '&outFields=*' +
      '&outSR=4326' +
      '&f=geojson';

    const r = await fetch(url, { cache: 'reload' });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const j = await r.json();
    ilPublic.addData(j);
  } catch (e) {
    console.warn('Illinois public hunting load failed', e);
  }
}


// Wisconsin – now wired to WI DNR managed lands MapServer (owned, easement, leased)
const wiPublic = L.geoJSON(null, {
  style: { color: '#22c55e', weight: 2, fillOpacity: 0.15 },
  onEachFeature: (feat, layer) => bindIndianaHuntingPopup(feat, layer)
});

async function loadWiPublic() {
  // First try the live WI DNR service
  const base =
    'https://dnrmaps.wi.gov/arcgis/rest/services/LF_DML/' +
    'LF_DNR_MGD_LAND_NoAnno_WTM_Ext/MapServer';

  const layerIds = [2, 3, 4]; // Owned, Easement, Leased

  let loadedAny = false;

  for (const id of layerIds) {
    try {
      const url =
        `${base}/${id}/query` +
        '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

      const r = await fetch(url, { cache: 'reload' });
      if (!r.ok) continue;

      const j = await r.json();
      // Add each set of features into the same Wisconsin layer
      wiPublic.addData(j);
      loadedAny = true;
    } catch (e) {
      console.warn('Wisconsin public hunting load failed for layer', id, e);
    }
  }

  // Fallback: if for some reason none of the service calls worked,
  // fall back to your local GeoJSON file (if present).
  if (!loadedAny) {
    try {
      const rLocal = await fetch('wi_public_hunting.geojson', { cache: 'reload' });
      if (rLocal.ok) {
        const jLocal = await rLocal.json();
        wiPublic.addData(jLocal);
      }
    } catch (e) {
      console.warn('Wisconsin local public hunting fallback failed', e);
    }
  }
}



// Kick off loads
loadMichiganPublic();
loadKentuckyPublic();
loadWvPublic();
loadPaPublic();
loadIlPublic();
loadWiPublic();

// Registry so UI can treat “Public Hunting” generically per state
const PUBLIC_BY_STATE = {
  OH: ohioPublic,
  IN: indianaPublic,
  MI: michiganPublic,
  KY: kentuckyPublic,
  WV: wvPublic,
  PA: paPublic,
  IL: ilPublic,
  WI: wiPublic
};





/*******************
 * OVERLAYS: Counties + Labels (multi-state)
 *******************/
// [BHH: OVERLAYS – COUNTIES START]

// FIPS codes for each supported state
const COUNTY_FIPS = {
  OH: '39',
  IN: '18',
  MI: '26',
  KY: '21',
  WV: '54',
  PA: '42',
  IL: '17',
  WI: '55'
};

const COUNTY_STATE_NAMES = {
  OH: 'Ohio',
  IN: 'Indiana',
  MI: 'Michigan',
  KY: 'Kentucky',
  WV: 'West Virginia',
  PA: 'Pennsylvania',
  IL: 'Illinois',
  WI: 'Wisconsin'
};

// Registry: state -> { counties: L.GeoJSON, labels: L.LayerGroup }
const COUNTY_REG = {};

function makeCountyLayersForState(stateCode) {
  const counties = L.geoJSON(null, {
    style: { color: '#94a3b8', weight: 1, fill: false, opacity: 0.9 },
    onEachFeature: (feat, layer) => {
      const p = feat.properties || {};
      const name =
        p.County_Name ||
        p.COUNTY_NAME ||
        p.NAME ||
        p.County ||
        p.COUNTY ||
        'County';

      layer.on('mouseover', () => layer.setStyle({ weight: 2 }));
      layer.on('mouseout',  () => layer.setStyle({ weight: 1 }));
      layer._countyName = String(name);
    }
  });

  const labels = L.layerGroup();

  COUNTY_REG[stateCode] = { counties, labels };
  return { counties, labels };
}

// Concrete layers (for compatibility with rest of code)
const { counties: ohioCounties,      labels: countyLabels }          = makeCountyLayersForState('OH');
const { counties: indianaCounties,   labels: indianaCountyLabels }   = makeCountyLayersForState('IN');
const { counties: michiganCounties,  labels: michiganCountyLabels }  = makeCountyLayersForState('MI');
const { counties: kentuckyCounties,  labels: kentuckyCountyLabels }  = makeCountyLayersForState('KY');
const { counties: wvCounties,        labels: wvCountyLabels }        = makeCountyLayersForState('WV');
const { counties: paCounties,        labels: paCountyLabels }        = makeCountyLayersForState('PA');
const { counties: illinoisCounties,  labels: illinoisCountyLabels }  = makeCountyLayersForState('IL');
const { counties: wisconsinCounties, labels: wisconsinCountyLabels } = makeCountyLayersForState('WI');


// Label font size based on zoom
function labelFontForZoom(z) {
  if (z >= 11) return 14;
  if (z >= 9)  return 12;
  if (z >= 7)  return 10;
  return 0;
}

function refreshAllCountyLabels() {
  const fs = labelFontForZoom(map.getZoom());
  Object.values(COUNTY_REG).forEach(entry => {
    entry.labels.eachLayer(m => {
      const el = m.getElement();
      if (!el) return;
      if (fs === 0) {
        el.style.display = 'none';
      } else {
        el.style.display = 'block';
        el.style.fontSize = fs + 'px';
      }
    });
  });
}

function buildCountyLabelsFor(stateCode) {
  const entry = COUNTY_REG[stateCode];
  if (!entry) return;
  const { counties, labels } = entry;

  labels.clearLayers();
  counties.eachLayer(layer => {
    try {
      const center = layer.getBounds().getCenter();
      const name = layer._countyName || 'County';
      const lbl = L.marker(center, {
        interactive: false,
        pane: 'tooltipPane',
        icon: L.divIcon({
          className: 'county-label',
          html: name
        })
      });
      labels.addLayer(lbl);
    } catch (_) {}
  });

  refreshAllCountyLabels();
  if (map.hasLayer(counties) && !map.hasLayer(labels)) {
    labels.addTo(map);
  }
}

async function loadStateCounties(stateCode) {
  const fips = COUNTY_FIPS[stateCode];
  const stateName = COUNTY_STATE_NAMES[stateCode];
  const entry = COUNTY_REG[stateCode];
  if (!fips || !stateName || !entry) return;

  const primary =
    'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';
  try {
    const r = await fetch(primary, { cache: 'reload' });
    if (r.ok) {
      const j = await r.json();
      const fc = {
        type: 'FeatureCollection',
        features: (j.features || [])
          .filter(f => (f.id || '').toString().slice(0, 2) === fips)
          .map(f => ({
            type: 'Feature',
            geometry: f.geometry,
            properties: {
              County_Name:
                (f.properties && (f.properties.NAME || f.properties.County_Name)) ||
                'County'
            }
          }))
      };

      if (fc.features.length) {
        entry.counties.addData(fc);
        buildCountyLabelsFor(stateCode);
        return;
      }
    }
  } catch (e) {
    console.warn('Primary counties source failed for', stateCode, e);
  }

  // Fallback – ArcGIS USA_Counties
  try {
    const url =
      'https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/USA_Counties/FeatureServer/0/query' +
      '?where=STATE_NAME%3D' + encodeURIComponent(`'${stateName}'`) +
      '&outFields=NAME,STATE_NAME&outSR=4326&f=geojson';

    const r = await fetch(url, { cache: 'reload' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();

    const normalized = {
      type: 'FeatureCollection',
      features: (j.features || []).map(f => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          County_Name:
            (f.properties && (f.properties.NAME || f.properties.County_Name)) ||
            'County'
        }
      }))
    };

    entry.counties.addData(normalized);
    buildCountyLabelsFor(stateCode);
  } catch (e) {
    console.warn('Counties layer fetch failed for', stateCode, e);
  }
}

// Load all states' counties once
['OH','IN','MI','KY','WV','PA','IL','WI'].forEach(loadStateCounties);

map.on('zoomend', refreshAllCountyLabels);

// [BHH: OVERLAYS – COUNTIES END]




/*******************
 * OVERLAYS: Waterfowl Zones (OH + IN)
 *******************/
// [BHH: OVERLAYS – WATERFOWL ZONES START]

// One overlay toggle in the UI controls this group.
// Contents depend on currentState (OH or IN).
const waterfowlZones = L.layerGroup();

// Shared helper to infer a zone name from feature properties
function inferZoneName(props) {
  if (!props) return '';

  const candidateKeys = [
    'Zone_', 'ZONE_', 'ZONE_NAME', 'ZoneName',
    'ZONE', 'ZONE_LABEL', 'LABEL', 'NAME'
  ];

  for (const k of candidateKeys) {
    if (props[k] != null && props[k] !== '') {
      return String(props[k]);
    }
  }

  // Fallback: any string value that mentions "zone"
  for (const v of Object.values(props)) {
    if (typeof v === 'string' && /zone/i.test(v)) {
      return v;
    }
  }

  return '';
}

/* ---------- OHIO WATERFOWL ZONES ---------- */

function ohioZoneStyle(feat) {
  const name = inferZoneName(feat.properties).toUpperCase();
  let color = '#22c55e'; // default green

  if (name.includes('NORTH')) {
    color = '#22c55e';          // North Zone
  } else if (name.includes('SOUTH')) {
    color = '#f97316';          // South Zone
  } else if (
    name.includes('LAKE') ||
    name.includes('MARSH') ||
    name.includes('ERIE')
  ) {
    color = '#38bdf8';          // Lake Erie Marsh Zone
  }

  return {
    color,
    weight: 2,
    fillOpacity: 0.18
  };
}

function onEachOhioWaterfowl(feat, layer) {
  const raw = inferZoneName(feat.properties);
  const name = raw || 'Ohio Waterfowl Zone';

  // Ohio: ONLY show the zone label (no dates/seasons)
  layer.bindPopup(`<b>${name}</b>`);

  layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
  layer.on('mouseout',  () => layer.setStyle({ weight: 2 }));
}

const ohioWaterfowlZones = L.geoJSON(null, {
  style: ohioZoneStyle,
  onEachFeature: onEachOhioWaterfowl
});

async function loadOhioWaterfowlZones() {
  try {
    const url =
      'https://gis2.ohiodnr.gov/ArcGIS/rest/services/DOW_Services/Hunting_Regulations/MapServer/2/query' +
      '?where=1%3D1&outFields=*&outSR=4326&f=geojson';
    const r = await fetch(url, { cache: 'reload' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    ohioWaterfowlZones.addData(j);
  } catch (e) {
    console.warn('Ohio waterfowl zones load failed', e);
  }
}

/* ---------- INDIANA WATERFOWL ZONES ---------- */

function indianaZoneStyle(feat) {
  const name = inferZoneName(feat.properties).toUpperCase();
  let color = '#22c55e'; // default

  if (name.includes('NORTH')) {
    color = '#22c55e';          // North
  } else if (name.includes('CENTRAL')) {
    color = '#eab308';          // Central
  } else if (name.includes('SOUTH')) {
    color = '#f97316';          // South
  }

  return {
    color,
    weight: 2,
    fillOpacity: 0.18
  };
}

function onEachIndianaWaterfowl(feat, layer) {
  const raw = inferZoneName(feat.properties);
  let name = raw || 'Indiana Waterfowl Zone';

  // If the value is just "North", "Central", or "South", make it a full label
  const upper = name.toUpperCase();
  if (/NORTH\b/i.test(name) && !/WATERFOWL/i.test(name)) {
    name = 'North Waterfowl Zone';
  } else if (/CENTRAL\b/i.test(name) && !/WATERFOWL/i.test(name)) {
    name = 'Central Waterfowl Zone';
  } else if (/SOUTH\b/i.test(name) && !/WATERFOWL/i.test(name)) {
    name = 'South Waterfowl Zone';
  }

  layer.bindPopup(`<b>${name}</b>`);

  layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
  layer.on('mouseout',  () => layer.setStyle({ weight: 2 }));
}

// --- Indiana-specific popup + styling ---
function decorateIndianaWaterfowlFeature(feat, layer) {
  const p = feat.properties || {};

  // Field is "zone" in the Indiana service: North / Central / South
  const rawZone = (p.zone || p.ZONE || '').toString().trim();
  const zoneName = rawZone
    ? `${rawZone} Waterfowl Zone`          // e.g. "North Waterfowl Zone"
    : 'Indiana Waterfowl Zone';

  // Optional description field if they ever use it
  const desc = (p.description || p.DESCRIPTION || '').toString().trim();
  const body = desc
    ? `<div style="margin-top:6px">${desc}</div>`
    : '';

  layer.bindPopup(`<b>${zoneName}</b>${body}`);

  layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
  layer.on('mouseout', () => layer.setStyle({ weight: 2 }));
}

// Indiana waterfowl polygons (from IN DNR service)
const indianaWaterfowlZones = L.geoJSON(null, {
  style: (feat) => {
    const p = feat.properties || {};
    const z = (p.zone || p.ZONE || '').toString().toLowerCase();

    // Different colors for each zone
    let color = '#22c55e';       // default / North
    if (z === 'central') color = '#3b82f6';   // blue
    else if (z === 'south') color = '#f97316'; // orange

    return {
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.25
    };
  },
  onEachFeature: decorateIndianaWaterfowlFeature
});


// Indiana DNR hosted waterfowl zones service (polygon layer)
const IN_WATERFOWL_SERVICE =
  'https://gisdata.in.gov/server/rest/services/Hosted/Hunting_Areas_Waterfowl_Zones/FeatureServer/0';

async function loadIndianaWaterfowlZones() {
  if (!IN_WATERFOWL_SERVICE) {
    console.warn('Indiana waterfowl service URL not configured yet.');
    return;
  }

  try {
    const url =
      IN_WATERFOWL_SERVICE +
      '/query?where=1%3D1&outFields=*&outSR=4326&f=geojson';

    const r = await fetch(url, { cache: 'reload' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    indianaWaterfowlZones.addData(j);
  } catch (e) {
    console.warn('Indiana waterfowl zones load failed', e);
  }
}

/* ---------- STATE-AWARE VISIBILITY ---------- */

function updateWaterfowlVisibility() {
  if (!ovlWaterfowl) return;

  // Always clear everything first so only one state is active at a time
  waterfowlZones.clearLayers();

  if (!ovlWaterfowl.checked) {
    if (map.hasLayer(waterfowlZones)) map.removeLayer(waterfowlZones);
    return;
  }

  if (currentState === 'OH') {
    waterfowlZones.addLayer(ohioWaterfowlZones);
  } else if (currentState === 'IN') {
    waterfowlZones.addLayer(indianaWaterfowlZones);
  }

  if (!map.hasLayer(waterfowlZones)) {
    waterfowlZones.addTo(map);
  }
}

// Kick off both data loads (they just populate the layers)
function loadWaterfowlZones() {
  loadOhioWaterfowlZones();
  loadIndianaWaterfowlZones();
}
loadWaterfowlZones();
// [BHH: OVERLAYS – WATERFOWL ZONES END]




/*******************
 * OVERLAYS & BASEMAP: Sheet wiring
 *******************/
// [BHH: SHEET – BASEMAP & OVERLAYS START]
// Basemap radios
const radios = Array.from(document.querySelectorAll('input[name="basemap"]'));

function syncBaseRadio() {
  const k = localStorage.getItem(STORAGE_BASE) || 'hybrid';
  const r = radios.find(r => r.value === k);
  if (r) r.checked = true;
}

radios.forEach(r =>
  r.addEventListener('change', () => setBasemap(r.value))
);
syncBaseRadio();

// Overlay checkboxes
const ovlOhio = document.getElementById('ovlOhio');
const ovlCounties = document.getElementById('ovlCounties');
const ovlWaterfowl = document.getElementById('ovlWaterfowl');
const ovlDraw = document.getElementById('ovlDraw');
const ovlMarks = document.getElementById('ovlMarks');
const ovlTrack = document.getElementById('ovlTrack');

// These layers get toggled by the sheet
function syncOverlayChecks() {
  if (!ovlOhio || !ovlCounties || !ovlWaterfowl || !ovlDraw || !ovlMarks || !ovlTrack) return;

  // Public hunting: any state that has a registered layer
  const pubLayer = PUBLIC_BY_STATE[currentState];
  if (pubLayer) {
    ovlOhio.checked = map.hasLayer(pubLayer);
  } else {
    ovlOhio.checked = false;
  }

  const countyEntry = COUNTY_REG[currentState];
  if (countyEntry) {
    ovlCounties.checked = map.hasLayer(countyEntry.counties);
  } else {
    ovlCounties.checked = false;
  }

  ovlWaterfowl.checked = map.hasLayer(waterfowlZones);
  ovlDraw.checked      = map.hasLayer(drawnItems);
  ovlMarks.checked     = map.hasLayer(markersLayer);
  ovlTrack.checked     = map.hasLayer(trackLayer);
}




ovlOhio.onchange = () => {
  const pubLayer = PUBLIC_BY_STATE[currentState];
  if (!pubLayer) {
    ovlOhio.checked = false;
    return;
  }
  if (ovlOhio.checked) {
    pubLayer.addTo(map);
  } else {
    map.removeLayer(pubLayer);
  }
};




ovlCounties.onchange = () => {
  const entry = COUNTY_REG[currentState];
  if (!entry) return;

  if (ovlCounties.checked) {
    entry.counties.addTo(map);
    entry.labels.addTo(map);
    refreshAllCountyLabels();
  } else {
    map.removeLayer(entry.counties);
    map.removeLayer(entry.labels);
  }
};


ovlWaterfowl.onchange = () => {
  updateWaterfowlVisibility();
};


ovlDraw.onchange =
  () => {
    if (ovlDraw.checked) {
      drawnItems.addTo(map);
      segmentLabelsGroup.addTo(map);
    } else {
      map.removeLayer(drawnItems);
      map.removeLayer(segmentLabelsGroup);
    }
  };
// ovlMarks & ovlTrack handlers wired further below

// Make entire .option row toggle the inner input
document.querySelectorAll('.sheet .option').forEach(opt => {
  opt.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'SELECT' || ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
    const input = opt.querySelector('input');
    if (!input) return;

    if (input.type === 'radio') {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (input.type === 'checkbox') {
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
});
// [BHH: SHEET – BASEMAP & OVERLAYS END]


/*******************
 * MARKERS (WAYPOINTS) + PHOTO NOTES
 *******************/
// [BHH: WAYPOINTS – DATA START]
const markersLayer = L.featureGroup().addTo(map);
const STORAGE_MARK = 'bhh_markers_v6';

// mobile vs desktop pin size
const IS_MOBILE = matchMedia('(max-width:640px)').matches;
const PIN_SZ    = IS_MOBILE ? 38 : 42;

/* ---------- INLINE SVG ICONS (use --wp-pin-icon color) ---------- */
const ICON_SVGS = {
  default: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="6.2"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.8"/>
      <line x1="12" y1="4" x2="12" y2="7"
        stroke="var(--wp-pin-icon)" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="12" y1="17" x2="12" y2="20"
        stroke="var(--wp-pin-icon)" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="4" y1="12" x2="7" y2="12"
        stroke="var(--wp-pin-icon)" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="17" y1="12" x2="20" y2="12"
        stroke="var(--wp-pin-icon)" stroke-width="1.6" stroke-linecap="round"/>
    </svg>
  `,


  blood: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.2 7.5 L6.6 11
               A3.2 3.2 0 0 0 10.2 11 Z"
        fill="var(--wp-pin-icon)" />
      <path d="M12 6.2 L10.4 11.2
               A3.4 3.4 0 0 0 13.6 11.2 Z"
        fill="var(--wp-pin-icon)" />
      <path d="M15.8 7.8 L14.2 11.3
               A3.2 3.2 0 0 0 17.8 11.3 Z"
        fill="var(--wp-pin-icon)" />
    </svg>
  `,

  trail: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 18 Q9.5 15 11.5 15
               Q13.5 15 15 13.4
               Q16.2 12.2 18 12"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round"
        stroke-dasharray="2.4 2.4" />
    </svg>
  `,

  stand: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="7" width="8" height="4" rx="0.8" ry="0.8"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.8"/>
      <line x1="10" y1="11" x2="10" y2="18"
        stroke="var(--wp-pin-icon)" stroke-width="1.7" stroke-linecap="round"/>
      <line x1="14" y1="11" x2="14" y2="18"
        stroke="var(--wp-pin-icon)" stroke-width="1.7" stroke-linecap="round"/>
      <line x1="10" y1="13" x2="14" y2="13"
        stroke="var(--wp-pin-icon)" stroke-width="1.3"/>
      <line x1="10" y1="15" x2="14" y2="15"
        stroke="var(--wp-pin-icon)" stroke-width="1.3"/>
      <line x1="10" y1="17" x2="14" y2="17"
        stroke="var(--wp-pin-icon)" stroke-width="1.3"/>
    </svg>
  `,

  blind: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="8" width="12" height="8" rx="1.4" ry="1.4"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.8"/>
      <rect x="9" y="10" width="6" height="2.6"
        fill="var(--wp-pin-icon)"/>
    </svg>
  `,

  scrape: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="9" cy="10" rx="1.4" ry="2.3"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.7"/>
      <ellipse cx="15" cy="10" rx="1.4" ry="2.3"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.7"/>
      <path d="M6 16 Q10 14 18 16"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.9"
        stroke-linecap="round"/>
    </svg>
  `,

  rub: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <rect x="10.5" y="6" width="3" height="11" rx="1.3"
        fill="var(--wp-pin-icon)"/>
      <path d="M9 8 L7.4 9.6
               M9 11 L7.3 12.4
               M15 9.4 L16.6 7.8
               M15 12.2 L16.7 10.9"
        fill="none" stroke="#0f172a" stroke-width="1.3"
        stroke-linecap="round"/>
    </svg>
  `,

  camera: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="8" width="12" height="8" rx="1.6"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.8"/>
      <circle cx="12" cy="12" r="3.1"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.6"/>
      <circle cx="9" cy="9.5" r="0.8"
        fill="var(--wp-pin-icon)"/>
    </svg>
  `,

    food: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <!-- Corn kernels (yellow) -->
      <path d="M12 17 Q13 14 13 11 Q13 8 12 6
               Q11 8 11 11 Q11 14 12 17 Z"
        fill="#facc15"/>
      <!-- Left green husk -->
      <path d="M9 10 Q6.7 10.1 6.1 12
               Q7.8 12.2 9 11.3"
        fill="none" stroke="#22c55e" stroke-width="1.4"
        stroke-linecap="round"/>
      <!-- Right green husk -->
      <path d="M15 10 Q17.3 10.1 17.9 12
               Q16.2 12.2 15 11.3"
        fill="none" stroke="#22c55e" stroke-width="1.4"
        stroke-linecap="round"/>
    </svg>
  `,


  water: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 5 L8.4 11.4
               A4.6 4.6 0 0 0 15.6 11.4 Z"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.9"/>
    </svg>
  `,

  camp: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 18 L12 7 L18 18 Z"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.9"
        stroke-linejoin="round"/>
      <line x1="10" y1="18" x2="14" y2="18"
        stroke="var(--wp-pin-icon)" stroke-width="1.9" stroke-linecap="round"/>
    </svg>
  `,

  truck: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <rect x="5" y="10" width="9" height="5" rx="1.2"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.8"/>
      <path d="M14 11 H17.6 L19 13.1 V15 H14 Z"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.8"
        stroke-linejoin="round"/>
      <circle cx="9" cy="16.4" r="1.5"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.6"/>
      <circle cx="17" cy="16.4" r="1.5"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.6"/>
    </svg>
  `,

  hazard: `
    <svg viewBox="0 0 24 24" class="wp-svg" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 18 L12 6 L19 18 Z"
        fill="none" stroke="var(--wp-pin-icon)" stroke-width="1.9"
        stroke-linejoin="round"/>
      <line x1="12" y1="10" x2="12" y2="14.2"
        stroke="var(--wp-pin-icon)" stroke-width="1.9" stroke-linecap="round"/>
      <circle cx="12" cy="16.6" r="0.9"
        fill="var(--wp-pin-icon)"/>
    </svg>
  `
};

/* ---------- MARKER HELPERS ---------- */

// HTML used both on map and inside the waypoint list
// HTML used both on map and inside the waypoint list
function markerIconHTML(type) {
  // Buck & Doe: empty div, shape comes from CSS mask
  if (type === 'buck' || type === 'doe') {
    return `<div class="wp-pin wp-${type}"></div>`;
  }

  // All other markers still use the inline SVGs
  const svg = ICON_SVGS[type] || ICON_SVGS.default;
  return `<div class="wp-pin wp-${type}">${svg}</div>`;
}




// Leaflet icon wrapper (divIcon)
function makePinIcon(type) {
  return L.divIcon({
    className: '',
    html: markerIconHTML(type),
    iconSize: [PIN_SZ, PIN_SZ],
    iconAnchor: [PIN_SZ / 2, PIN_SZ / 2],
    popupAnchor: [0, -PIN_SZ / 2]
  });
}

// All supported waypoint types
const markerTypes = {
  stand:  { label:'Tree Stand',      icon: makePinIcon('stand')  },
  blind:  { label:'Ground Blind',    icon: makePinIcon('blind')  },
  buck:   { label:'Buck',            icon: makePinIcon('buck')   },
  doe:    { label:'Doe',             icon: makePinIcon('doe')    },
  blood:  { label:'Blood Trail',     icon: makePinIcon('blood')  },
  scrape: { label:'Scrape',          icon: makePinIcon('scrape') },
  rub:    { label:'Rub',             icon: makePinIcon('rub')    },
  trail:  { label:'Trail',           icon: makePinIcon('trail')  },
  camera: { label:'Trail Camera',    icon: makePinIcon('camera') },
  food:   { label:'Food Plot',       icon: makePinIcon('food')   },
  water:  { label:'Water Source',    icon: makePinIcon('water')  },
  camp:   { label:'Camp',            icon: makePinIcon('camp')   },
  truck:  { label:'Truck / Parking', icon: makePinIcon('truck')  },
  hazard: { label:'Hazard',          icon: makePinIcon('hazard') }
};

let activeType = null;
let deleteMode = false;

function setActiveType(type){
  activeType = type;
  document.getElementById('map').classList.toggle('placing', !!type);
}

function uid(){
  return Date.now().toString(36)+Math.random().toString(36).slice(2,7);
}

function defaultMarkerName(type){
  const base = markerTypes[type]?.label || 'Marker';
  let n = 1;
  markersLayer.eachLayer(m => {
    if (m.options.type === type) n++;
  });
  return `${base} ${n}`;
}

function markerPopupHTML(m){
  const cfg = markerTypes[m.options.type] || {label:'Marker'};
  const img = m.options.photo
    ? `<div style="margin-top:6px"><img src="${m.options.photo}" alt="photo" style="max-width:160px;border-radius:8px;border:1px solid #203325"/></div>`
    : '';
  const notes = m.options.notes
    ? `<div class="tag" style="margin-top:6px">${m.options.notes.replace(/</g,'&lt;')}</div>`
    : '';
  return `
    <b>${m.options.name}</b>
    <div class="tag">${cfg.label}</div>
    ${img}${notes}
    <div style="margin-top:8px; display:flex; gap:6px;">
      <button class="edit">Edit</button>
      <button class="del">Delete</button>
    </div>`;
}

function addMarker(latlng, type, name, id, notes, photo){
  const cfg = markerTypes[type] || { label:'Marker', icon: makePinIcon('default') };
  const markerId   = id   || uid();
  const markerName = name || defaultMarkerName(type || 'default');

  const m = L.marker(latlng, {
    icon: cfg.icon,
    draggable:true,
    type,
    id: markerId,
    name: markerName,
    notes: notes || '',
    photo: photo || ''
  });

  const setPopup = () => m.bindPopup(markerPopupHTML(m), {autoPan:false});
  setPopup();

  m.on('dragend', () => {
    saveMarkers();
    refreshWaypointsUI();
  });

  m.on('click', () => {
    if (deleteMode){
      markersLayer.removeLayer(m);
      saveMarkers();
      refreshWaypointsUI();
    }
  });

  m.on('popupopen', (e) => {
    const root = e.popup.getElement();
    if (!root) return;
    const btnDel  = root.querySelector('button.del');
    const btnEdit = root.querySelector('button.edit');

    if (btnDel){
      btnDel.addEventListener('click', () => {
        markersLayer.removeLayer(m);
        saveMarkers();
        refreshWaypointsUI();
      });
    }
    if (btnEdit){
      btnEdit.addEventListener('click', () => {
        openWaypointDetail(m);
      });
    }
  });

  markersLayer.addLayer(m);
  saveMarkers();
  return m;
}

/* ---------- STORAGE ---------- */
function serializeMarkers(){
  const list=[];
  markersLayer.eachLayer(m=>{
    const {lat,lng} = m.getLatLng();
    list.push({
      id: m.options.id,
      name: m.options.name,
      type: m.options.type || 'marker',
      lat, lng,
      notes: m.options.notes || '',
      photo: m.options.photo || ''
    });
  });
  return list;
}

function deserializeMarkers(list){
  markersLayer.clearLayers();
  (list||[]).forEach(m =>
    addMarker([m.lat,m.lng], m.type, m.name, m.id, m.notes, m.photo)
  );
}

function saveMarkers(){
  localStorage.setItem(STORAGE_MARK, JSON.stringify(serializeMarkers()));
}

;(function restoreMarkers(){
  try{
    const raw = localStorage.getItem(STORAGE_MARK);
    if(raw) deserializeMarkers(JSON.parse(raw));
  }catch(e){}
})();

/* ---------- MAP CLICK TO DROP MARKER ---------- */
map.on('click', e=>{
  if(!activeType) return;
  addMarker(e.latlng, activeType);
  setActiveType(null);
  refreshWaypointsUI();
});
// [BHH: WAYPOINTS – DATA END]


/*******************
 * WAYPOINTS manager UI hooks (fly/edit/guide/delete) + details sheet
 *******************/
// [BHH: WAYPOINTS – UI HOOKS START]
const wpList        = document.getElementById('wpList');
const wpSearch      = document.getElementById('wpSearch');
const wpType        = document.getElementById('wpType');
const wpName        = document.getElementById('wpName');
const wpTypePreview = document.getElementById('wpTypePreview');

const wpAddCenterBtn = document.getElementById('wpAddCenter');
const wpAddGPSBtn    = document.getElementById('wpAddGPS');

// populate wpType from markerTypes so values always match keys
if (wpType){
  wpType.innerHTML = Object.entries(markerTypes).map(([key, cfg]) =>
    `<option value="${key}">${cfg.label}</option>`
  ).join('');
}

function updateWpTypePreview(){
  if (!wpTypePreview || !wpType) return;
  const t = wpType.value || 'stand';
  wpTypePreview.innerHTML = markerIconHTML(t);
}

if (wpType){
  wpType.addEventListener('change', updateWpTypePreview);
  updateWpTypePreview();
}

if (wpAddCenterBtn){
  wpAddCenterBtn.onclick = () => {
    const t = wpType.value;
    const n = wpName.value || undefined;
    addMarker(map.getCenter(), t, n);
    refreshWaypointsUI();
    wpName.value = '';
  };
}

if (wpAddGPSBtn){
  wpAddGPSBtn.onclick = () => {
    if (!navigator.geolocation){
      alert('Geolocation not supported');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const t = wpType.value;
        const n = wpName.value || undefined;
        addMarker(
          [pos.coords.latitude, pos.coords.longitude],
          t, n
        );
        refreshWaypointsUI();
        wpName.value = '';
      },
      err => alert('Location error: ' + err.message),
      {enableHighAccuracy:true, timeout:8000}
    );
  };
}

/* ---------- DATA FOR LIST (markers + shapes) ---------- */
function gatherShapes(){
  const arr = [];
  drawnItems.eachLayer(l => {
    const type   = featureTypeFromLayer(l);
    const center =
      l.getBounds
        ? l.getBounds().getCenter()
        : (l.getLatLng ? l.getLatLng() : map.getCenter());

    // Ensure metrics are up to date for area-type shapes
    if (l instanceof L.Polygon || l instanceof L.Rectangle || l instanceof L.Circle){
      updateShapeMetrics(l);
    }

    arr.push({
      kind:'shape',
      type,
      name: l._bhhName || defaultShapeName(type),
      layer:l,
      center,
      metrics: l._bhhMetrics || null
    });
  });
  return arr;
}

function getWaypoints(){
  const pts = [];
  markersLayer.eachLayer(m => {
    const {lat, lng} = m.getLatLng();
    pts.push({
      kind:'wp',
      id:m.options.id,
      name:m.options.name,
      type:m.options.type,
      lat,
      lng,
      layer:m
    });
  });
  return pts;
}

function allItems(){
  return [...getWaypoints(), ...gatherShapes()];
}

/* ---------- LIST RENDER ---------- */
function refreshWaypointsUI(){
  if (!wpList) return;

  const q = (wpSearch && wpSearch.value || '').toLowerCase();
  const items = allItems().filter(w =>
    !q ||
    (w.name && w.name.toLowerCase().includes(q)) ||
    (markerTypes[w.type]?.label || '').toLowerCase().includes(q)
  );

  if (!items.length){
    wpList.innerHTML = '<p class="tag" style="margin-top:8px">No items yet.</p>';
    rebuildCompassTargets();
    return;
  }

  wpList.innerHTML = items.map((w,i) => {
    let iconHtml = '';
    let metaHtml = '';

    if (w.kind === 'wp'){
      iconHtml = `<div class="wp-item-icon">${markerIconHTML(w.type)}</div>`;
    } else {
      const glyph =
        w.type === 'polyline'  ? '≡' :
        w.type === 'circle'    ? '◯' :
        w.type === 'rectangle' ? '▭' : '⬠';

      iconHtml = `<div class="wp-item-icon shape-icon">${glyph}</div>`;

      if (w.metrics){
        if (w.type === 'circle'){
          metaHtml = `<div class="meta">${w.metrics.radiusText} • ${w.metrics.areaText}</div>`;
        } else {
          metaHtml = `<div class="meta">${w.metrics.perimeterText} • ${w.metrics.areaText}</div>`;
        }
      }
    }

    const safeName = (w.name || '')
      .replace(/&/g,'&amp;')
      .replace(/"/g,'&quot;');

    return `
      <div class="item" data-kind="${w.kind}" data-idx="${i}">
        ${iconHtml}
        <div class="wp-item-main">
          <input class="wp-item-name" type="text" value="${safeName}" />
          ${metaHtml}
        </div>
        <div class="wp-item-actions">
          <button class="btn btn-fly">Fly</button>
          ${
            w.kind === 'wp'
              ? '<button class="btn btn-guide">Guide</button><button class="btn btn-edit">Edit</button>'
              : ''
          }
          <button class="btn danger btn-del">Delete</button>
        </div>
      </div>`;
  }).join('');

  rebuildCompassTargets();
}

if (wpSearch){
  wpSearch.addEventListener('input', refreshWaypointsUI);
}

if (wpList){
  wpList.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;

    const idx   = parseInt(item.dataset.idx, 10);
    const items = allItems();
    const obj   = items[idx];
    if (!obj) return;

    if (e.target.classList.contains('btn-fly')){
      if (obj.kind === 'wp'){
        map.setView([obj.lat, obj.lng], Math.max(map.getZoom(), 16));
        obj.layer.openPopup();
      } else {
        if (obj.layer.getBounds){
          map.fitBounds(obj.layer.getBounds(), { maxZoom:18 });
        } else if (obj.center){
          map.setView(obj.center, 17);
        }
      }
    }

    if (e.target.classList.contains('btn-del')){
      if (obj.kind === 'wp'){
        markersLayer.removeLayer(obj.layer);
        saveMarkers();
      } else {
        drawnItems.removeLayer(obj.layer);
        removeSegLabels(obj.layer);
        removeTotalLabel(obj.layer);
        removeShapeLabel(obj.layer);
        saveDraw();
      }
      refreshWaypointsUI();
    }

    if (e.target.classList.contains('btn-edit') && obj.kind === 'wp'){
      openWaypointDetail(obj.layer);
    }

    if (e.target.classList.contains('btn-guide') && obj.kind === 'wp'){
      setGuideTarget(obj.layer.options.id);
      openSheet('compass');
    }
  });

  wpList.addEventListener('input', (e) => {
    if (!e.target.classList.contains('wp-item-name')) return;

    const item = e.target.closest('.item');
    if (!item) return;

    const idx   = parseInt(item.dataset.idx, 10);
    const items = allItems();
    const obj   = items[idx];
    if (!obj) return;

    const val = e.target.value;
    if (obj.kind === 'wp'){
      obj.layer.options.name = val;
      obj.layer.bindPopup(markerPopupHTML(obj.layer));
      saveMarkers();
    } else {
      obj.layer._bhhName = val;
      saveDraw();
    }
  });
}

/* ---------- Waypoint details (notes + photo) ---------- */
let editingWP = null;
const wpDetSheet     = document.getElementById('wpDetailSheet');
const wpDetName      = document.getElementById('wpDetName');
const wpDetType      = document.getElementById('wpDetType');
const wpDetNotes     = document.getElementById('wpDetNotes');
const wpPhotoInput   = document.getElementById('wpPhotoInput');
const wpPhotoInfo    = document.getElementById('wpPhotoInfo');
const wpPhotoPreview = document.getElementById('wpPhotoPreview');
const wpPickPhotoBtn = document.getElementById('wpPickPhoto');
const wpDetSaveBtn   = document.getElementById('wpDetSave');

if (wpDetType){
  wpDetType.innerHTML = Object.entries(markerTypes).map(([key, cfg]) =>
    `<option value="${key}">${cfg.label}</option>`
  ).join('');
}

if (wpPickPhotoBtn){
  wpPickPhotoBtn.onclick = () => wpPhotoInput.click();
}

function openWaypointDetail(marker){
  editingWP = marker;
  wpDetName.value  = marker.options.name || '';
  wpDetType.value  = marker.options.type || 'stand';
  wpDetNotes.value = marker.options.notes || '';

  if (marker.options.photo){
    wpPhotoInfo.textContent =
      `${Math.round(marker.options.photo.length / 1024)} KB`;
    wpPhotoPreview.innerHTML =
      `<img src="${marker.options.photo}" alt="photo" style="max-width:100%;border-radius:10px;border:1px solid #203325"/>`;
  } else {
    wpPhotoInfo.textContent   = 'No photo';
    wpPhotoPreview.innerHTML  = '';
  }

  openSheet('wpDetail');
}

function readAndCompressImage(file, maxDim = 1280, quality = 0.82){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let {width:w, height:h} = img;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      const cw = Math.round(w * scale);
      const ch = Math.round(h * scale);

      const c   = document.createElement('canvas');
      c.width   = cw;
      c.height  = ch;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);

      const url = c.toDataURL('image/jpeg', quality);
      if (url.length / 1024 > 1500){
        return reject('Image too large after compression; try a smaller image.');
      }
      resolve(url);
    };
    img.onerror = reject;

    const fr = new FileReader();
    fr.onload  = () => { img.src = fr.result; };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

if (wpPhotoInput){
  wpPhotoInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !editingWP) return;

    try {
      const dataUrl = await readAndCompressImage(file, 1280, 0.82);
      editingWP.options.photo = dataUrl;
      wpPhotoInfo.textContent =
        `${Math.round(dataUrl.length / 1024)} KB`;
      wpPhotoPreview.innerHTML =
        `<img src="${dataUrl}" alt="photo" style="max-width:100%;border-radius:10px;border:1px solid #203325"/>`;
      saveMarkers();
      editingWP.bindPopup(markerPopupHTML(editingWP));
    } catch(err){
      alert('Photo failed: ' + err);
    }

    e.target.value = '';
  });
}

if (wpDetSaveBtn){
  wpDetSaveBtn.onclick = () => {
    if (!editingWP) return;

    editingWP.options.name  = wpDetName.value || editingWP.options.name;
    editingWP.options.type  = wpDetType.value;
    editingWP.options.notes = wpDetNotes.value || '';

    const cfg =
      markerTypes[editingWP.options.type] ||
      { icon: makePinIcon('default') };

    editingWP.setIcon(cfg.icon);
    editingWP.bindPopup(markerPopupHTML(editingWP));
    saveMarkers();
    refreshWaypointsUI();
    closeSheets();
  };
}
// [BHH: WAYPOINTS – UI HOOKS END]


/*******************
 * TRACK RECORDER
 *******************/
// [BHH: TRACK START]
const trackLayer = L.polyline([], {
  color:'#22d3ee',
  weight:4,
  opacity:0.9
}).addTo(map);

const STORAGE_TRK = 'bhh_track_v1';
let trackPoints = []; // {lat,lng,t}
let watchId = null;
let startTime = null;
let lastPoint = null;

// Track UI elements
const trkPtsEl    = document.getElementById('trkPts');
const trkDistEl   = document.getElementById('trkDist');
const trkDurEl    = document.getElementById('trkDur');
const pTrkDistEl  = document.getElementById('pTrkDist');
const pTrkDurEl   = document.getElementById('pTrkDur');
const trkStatusEl = document.getElementById('trkStatus');
const trkStartBtn = document.getElementById('trkStartStop');
const trkClearBtn = document.getElementById('trkClear');
const trkFollowEl = document.getElementById('trkFollow');
const trkExportBtn = document.getElementById('trkExport');

function loadTrack(){
  try {
    const raw = localStorage.getItem(STORAGE_TRK);
    if (raw){
      trackPoints = JSON.parse(raw) || [];
      trackLayer.setLatLngs(trackPoints.map(p => [p.lat, p.lng]));
    }
  } catch(e){}
  updateTrackStats();
}

function saveTrack(){
  localStorage.setItem(STORAGE_TRK, JSON.stringify(trackPoints));
  updateTrackStats();
}

function appendPoint(lat, lng, t){
  const pt = {lat, lng, t: t || Date.now()};
  if (lastPoint){
    const d = map.distance(
      [lastPoint.lat, lastPoint.lng],
      [lat,          lng]
    );
    if (d < 3) return;
  }
  trackPoints.push(pt);
  lastPoint = pt;
  trackLayer.addLatLng([lat, lng]);
  saveTrack();
}

function trackDistance(){
  let d = 0;
  for (let i = 1; i < trackPoints.length; i++){
    d += map.distance(
      [trackPoints[i-1].lat, trackPoints[i-1].lng],
      [trackPoints[i].lat,   trackPoints[i].lng]
    );
  }
  return d;
}

function updateTrackStats(){
  if (!trkPtsEl || !trkDistEl || !trkDurEl || !pTrkDistEl || !pTrkDurEl) return;

  const pts  = trackPoints.length;
  const dist = trackDistance();

  trkPtsEl.textContent = pts;

  const distText = dist > 1609.344
    ? (dist / 1609.344).toFixed(2) + ' mi'
    : Math.round(dist * 3.28084) + ' ft';

  trkDistEl.textContent  = distText;
  pTrkDistEl.textContent = distText;

  const durMs = startTime
    ? (Date.now() - startTime)
    : (trackPoints.length
        ? (trackPoints[trackPoints.length-1].t - trackPoints[0].t)
        : 0);

  const mm = Math.floor(durMs / 60000);
  const ss = (Math.floor(durMs / 1000) % 60).toString().padStart(2,'0');

  const durText = `${mm}:${ss}`;
  trkDurEl.textContent  = durText;
  pTrkDurEl.textContent = durText;
}

function startTrack(){
  if (!navigator.geolocation){
    alert('Geolocation not supported');
    return;
  }
  if (watchId) return;

  startTime = Date.now();
  if (trkStatusEl) trkStatusEl.textContent = 'Recording';
  if (trkStartBtn) trkStartBtn.textContent = 'Stop';

  watchId = navigator.geolocation.watchPosition(
    pos => {
      const {latitude, longitude} = pos.coords;
      appendPoint(latitude, longitude, Date.now());
      if (trkFollowEl && trkFollowEl.checked){
        map.setView([latitude, longitude], Math.max(map.getZoom(), 16));
      }
    },
    err => {
      console.warn('track error', err);
    },
    { enableHighAccuracy:true, maximumAge:5000 }
  );
}

function stopTrack(){
  if (!watchId) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (trkStatusEl) trkStatusEl.textContent = 'Stopped';
  if (trkStartBtn) trkStartBtn.textContent = 'Start';
  updateTrackStats();
}

function clearTrack(){
  stopTrack();
  trackPoints = [];
  lastPoint   = null;
  trackLayer.setLatLngs([]);
  saveTrack();
}

function exportGPX(){
  if (!trackPoints.length){
    alert('No track to export');
    return;
  }

  const name =
    'BHH Track ' +
    new Date(trackPoints[0].t).toISOString().slice(0,10);

  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="BuckeyeHunterHub" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${name}</name><trkseg>`;

  const seg = trackPoints.map(p =>
    `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time></trkpt>`
  ).join('');

  const tail = `</trkseg></trk></gpx>`;

  const blob = new Blob([head + seg + tail], {
    type:'application/gpx+xml'
  });

  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = name.replace(/\s+/g,'_') + '.gpx';
  a.click();
  URL.revokeObjectURL(url);
}

// Hook buttons
if (trkStartBtn){
  trkStartBtn.addEventListener('click', () => {
    if (watchId){
      stopTrack();
    } else {
      startTrack();
    }
  });
}
if (trkClearBtn){
  trkClearBtn.addEventListener('click', clearTrack);
}
if (trkExportBtn){
  trkExportBtn.addEventListener('click', exportGPX);
}

loadTrack();
// [BHH: TRACK END]



/*******************
 * WIND (live) + SCENT CONE
 *******************/
// [BHH: WIND & SCENT START]
const btnWind = document.getElementById('menuWind');
const windText = document.getElementById('windText');

let currentWind = { fromDeg: null, speed: 0 };
let lastGPS = null;

function degToCardinal(d) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(d / 45) % 8];
}

function updateWindUI(fromDeg, speed) {
  const toDeg = (fromDeg + 180) % 360;

  const from = degToCardinal(fromDeg);
  const to = degToCardinal(toDeg);

  windText.textContent =
    `Wind: ${from} → ${to}  ${Math.round(speed)} mph`;
}

async function fetchWindAt(lat, lng) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('wind fetch failed');
  const j = await r.json();
  const cur = j.current || j.current_weather || {};

  const speed = cur.wind_speed_10m ?? cur.windspeed ?? 0;
  const dir = cur.wind_direction_10m ?? cur.winddirection ?? 0;

  currentWind = { fromDeg: dir, speed };
  updateWindUI(dir, speed);
  updateScentCone();
}

async function refreshWind() {
  try {
    const pos = await new Promise((res, rej) => {
      if (!navigator.geolocation) return rej('no geo');
      navigator.geolocation.getCurrentPosition(
        p => res(p),
        e => rej(e),
        { enableHighAccuracy: true, timeout: 6000 }
      );
    });
    lastGPS = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude
    };
    await fetchWindAt(lastGPS.lat, lastGPS.lng);
  } catch (_) {
    const c = map.getCenter();
    await fetchWindAt(c.lat, c.lng).catch(() => {
      windText.textContent = 'Wind: --';
    });
  }
}

const windRefreshBtn = document.getElementById('windRefresh');
const coneToggle = document.getElementById('coneToggle');
const coneWidth = document.getElementById('coneWidth');
const coneScale = document.getElementById('coneScale');
const coneAnchorRadios = Array.from(
  document.querySelectorAll('input[name="coneAnchor"]')
);

(function restoreConeSettings() {
  if (!coneToggle) return; // defensive if sheet not present

  coneToggle.checked = localStorage.getItem('cone_vis') === '1';
  coneWidth.value = localStorage.getItem('cone_w') || '60';
  coneScale.value = localStorage.getItem('cone_s') || '1';

  const anch = localStorage.getItem('cone_a') || 'gps';
  const r = coneAnchorRadios.find(x => x.value === anch);
  if (r) r.checked = true;
})();

let scentConeLayer = L.polygon([], {
  color: '#f59e0b',
  weight: 2,
  fillColor: '#f59e0b',
  fillOpacity: 0.2
});

function toRad(x) { return x * Math.PI / 180; }
function toDeg(x) { return x * 180 / Math.PI; }

function destPoint(lat, lng, bearingDeg, distM) {
  const R = 6378137;
  const br = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lon1 = toRad(lng);
  const dr = distM / R;

  const lat2 =
    Math.asin(
      Math.sin(lat1) * Math.cos(dr) +
      Math.cos(lat1) * Math.sin(dr) * Math.cos(br)
    );

  const lon2 =
    lon1 + Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );

  return L.latLng(toDeg(lat2), toDeg(lon2));
}

function updateScentCone() {
  if (!coneToggle || !coneToggle.checked) {
    if (map.hasLayer(scentConeLayer)) map.removeLayer(scentConeLayer);
    return;
  }

  const wind = currentWind;
  if (wind.fromDeg == null) return;

  const toDegWind = (wind.fromDeg + 180) % 360;
  const width = parseFloat(coneWidth.value);
  const half = width / 2;
  const scale = parseFloat(coneScale.value);
  const speed = Math.max(1, wind.speed || 1);

  const baseLen = 150 + speed * 90;
  const length = baseLen * scale;

  const anchorMode =
    (coneAnchorRadios.find(r => r.checked)?.value) || 'gps';

  const origin =
    (anchorMode === 'gps' && lastGPS)
      ? lastGPS
      : map.getCenter();

  const pts = [L.latLng(origin.lat, origin.lng)];
  for (let a = -half; a <= half; a += Math.max(5, width / 8)) {
    pts.push(
      destPoint(origin.lat, origin.lng, toDegWind + a, length)
    );
  }
  pts.push(L.latLng(origin.lat, origin.lng));

  scentConeLayer.setLatLngs([pts]);
  if (!map.hasLayer(scentConeLayer)) scentConeLayer.addTo(map);
}

function persistCone() {
  if (!coneToggle) return;
  localStorage.setItem('cone_vis', coneToggle.checked ? '1' : '0');
  localStorage.setItem('cone_w', coneWidth.value);
  localStorage.setItem('cone_s', coneScale.value);

  const anch =
    (coneAnchorRadios.find(r => r.checked) || {}).value || 'gps';
  localStorage.setItem('cone_a', anch);
}

if (coneToggle) {
  coneToggle.onchange =
    () => { persistCone(); updateScentCone(); };
  coneWidth.oninput =
    () => { persistCone(); updateScentCone(); };
  coneScale.oninput =
    () => { persistCone(); updateScentCone(); };
  coneAnchorRadios.forEach(r =>
    r.addEventListener('change', () => {
      persistCone();
      updateScentCone();
    })
  );
}

if (btnWind) {
  btnWind.onclick = () => {
    openSheet('wind');
    refreshWind();
  };
}
if (windRefreshBtn) {
  windRefreshBtn.onclick = () => refreshWind();
}

map.on('moveend', () => {
  const anch = localStorage.getItem('cone_a') || 'gps';
  if (anch === 'center') updateScentCone();
});

refreshWind();
setInterval(refreshWind, 15 * 60 * 1000);
// [BHH: WIND & SCENT END]


/*******************
 * LIVE GPS DOT + Locate button
 *******************/
// [BHH: GPS START]
let gpsMarker = null;
let gpsCircle = null;
let gpsWatchId = null;

const gpsIcon = L.divIcon({
  className: '',
  html: '<div class="pulse-dot"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

function updateGPSDot(lat, lng, accuracy) {
  const latlng = [lat, lng];

  if (!gpsMarker) {
    gpsMarker = L.marker(latlng, {
      icon: gpsIcon,
      interactive: false,
      zIndexOffset: 1000
    }).addTo(map);
  } else {
    gpsMarker.setLatLng(latlng);
  }

  const radius = Math.min(accuracy || 50, 200);
  if (!gpsCircle) {
    gpsCircle = L.circle(latlng, {
      radius,
      color: '#2563eb',
      weight: 2,
      fillColor: '#60a5fa',
      fillOpacity: 0.15
    }).addTo(map);
  } else {
    gpsCircle.setLatLng(latlng);
    gpsCircle.setRadius(radius);
  }
}

function ensureGPSWatch(interactive = false) {
  if (gpsWatchId || !navigator.geolocation) {
    if (!navigator.geolocation && interactive) {
      alert('Geolocation not supported');
    }
    return !!gpsWatchId;
  }

  try {
    gpsWatchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude, accuracy } = pos.coords;
        lastGPS = { lat: latitude, lng: longitude };
        updateGPSDot(latitude, longitude, accuracy);
      },
      err => {
        if (interactive) alert('Location error: ' + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  } catch (e) {
    if (interactive) alert('Location error');
  }

  return !!gpsWatchId;
}

setTimeout(() => ensureGPSWatch(false), 800);

const menuLocateBtn = document.getElementById('menuLocate');
if (menuLocateBtn) {
  menuLocateBtn.onclick = () => {
    const ok = ensureGPSWatch(true);
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const { latitude, longitude, accuracy } = pos.coords;
          lastGPS = { lat: latitude, lng: longitude };
          updateGPSDot(latitude, longitude, accuracy);
          map.setView(
            [latitude, longitude],
            Math.max(map.getZoom(), 15)
          );
        },
        err => alert('Location error: ' + err.message),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    }
  };
}
// [BHH: GPS END]


/*******************
 * COMPASS + BEARING
 *******************/
// [BHH: COMPASS START]
const compHeadingText = document.getElementById('compHeadingText');
const compTargetSel = document.getElementById('compTarget');
const compAnchorRadios = Array.from(document.querySelectorAll('input[name="compAnchor"]'));
const compDist = document.getElementById('compDist');
const compBear = document.getElementById('compBear');
const compEnableBtn = document.getElementById('compEnable'); // backup button in the sheet

let deviceHeading = null;
let guideTargetId = localStorage.getItem('guide_target') || '';
const guideLine = L.polyline([], { color: '#fdae6b', weight: 3, dashArray: '6,6' }).addTo(map);
let compassStarted = false;

function toRad2(x) { return x * Math.PI / 180; }
function toDeg2(x) { return x * 180 / Math.PI; }

function bearingDeg(a, b) {
  const y =
    Math.sin(toRad2(b.lng - a.lng)) *
    Math.cos(toRad2(b.lat));

  const x =
    Math.cos(toRad2(a.lat)) * Math.sin(toRad2(b.lat)) -
    Math.sin(toRad2(a.lat)) * Math.cos(toRad2(b.lat)) *
    Math.cos(toRad2(b.lng - a.lng));

  return (toDeg2(Math.atan2(y, x)) + 360) % 360;
}

// --- Waypoint targets for "Guide" line ---
function rebuildCompassTargets() {
  const wps = [];
  markersLayer.eachLayer(m => {
    const { lat, lng } = m.getLatLng();
    wps.push({
      id: m.options.id,
      name: m.options.name || 'Unnamed',
      type: m.options.type || 'marker',
      lat,
      lng,
      layer: m
    });
  });

  const opts = ['<option value="">(none)</option>']
    .concat(
      wps.map(w =>
        `<option value="${w.id}">${w.name} — ${w.type}</option>`
      )
    );

  if (compTargetSel) {
    compTargetSel.innerHTML = opts.join('');
    if (guideTargetId) compTargetSel.value = guideTargetId;
  }
}

function setGuideTarget(id) {
  guideTargetId = id || '';
  localStorage.setItem('guide_target', guideTargetId);
  rebuildCompassTargets();
  updateGuideLine();
}

if (compTargetSel) {
  compTargetSel.addEventListener('change', () => {
    setGuideTarget(compTargetSel.value);
  });
}

// --- Guide line origin and drawing ---
function compOrigin() {
  const mode = (compAnchorRadios.find(r => r.checked) || {}).value || 'gps';
  if (mode === 'gps' && lastGPS) {
    return L.latLng(lastGPS.lat, lastGPS.lng);
  }
  return map.getCenter();
}

function updateGuideLine() {
  const origin = compOrigin();

  if (!guideTargetId) {
    guideLine.setLatLngs([]);
    compDist.textContent = '--';
    compBear.textContent = '--';
    return;
  }

  let targetMarker = null;
  markersLayer.eachLayer(m => {
    if (m.options.id === guideTargetId) targetMarker = m;
  });

  if (!targetMarker) {
    guideLine.setLatLngs([]);
    compDist.textContent = '--';
    compBear.textContent = '--';
    return;
  }

  const target = targetMarker.getLatLng();
  guideLine.setLatLngs([origin, target]);

  const d = map.distance(origin, target);
  compDist.textContent =
    d >= 1609.344
      ? (d / 1609.344).toFixed(2) + ' mi'
      : Math.round(d * 3.28084) + ' ft';

  const brg = bearingDeg(origin, target);
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const card = dirs[Math.round(brg / 45) % 8];
  compBear.textContent = Math.round(brg) + '° ' + card;
}

// --- Dial / readout ---
function updateCompassDial() {
  const needle = document.getElementById('compassNeedle');
  if (!needle) return;

  const h = deviceHeading;
  const rotation = (h == null ? 0 : h);  // 0° = tip straight up (N)

  needle.style.transform =
    'translate(-50%, -100%) rotate(' + rotation + 'deg)';
}

function updateCompassReadout() {
  const h = deviceHeading;

  if (compHeadingText) {
    if (h == null) {
      compHeadingText.textContent = 'Heading: --';
    } else {
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      const card = dirs[Math.round(h / 45) % 8];
      compHeadingText.textContent =
        'Heading: ' + Math.round(h) + '° ' + card;
    }
  }

  updateGuideLine();
  updateCompassDial();
}

// --- Device orientation handler ---
function onDeviceOrientation(e) {
  let hdg = null;

  if (typeof e.webkitCompassHeading === 'number') {
    hdg = e.webkitCompassHeading;
  } else if (typeof e.alpha === 'number') {
    hdg = (360 - e.alpha) % 360;
  }

  if (hdg == null || isNaN(hdg)) return;

  deviceHeading = hdg;
  updateCompassReadout();
}

// --- Start compass (auto on mobile, hidden on desktop by CSS) ---
async function startCompass() {
  if (compassStarted) return;
  compassStarted = true;

  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') {
        if (compHeadingText) {
          compHeadingText.textContent = 'Heading: permission denied';
        }
        return;
      }
    }
  } catch (_) {}

  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
  } else if ('ondeviceorientation' in window) {
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  } else {
    if (compHeadingText) {
      compHeadingText.textContent = 'Heading: not supported';
    }
    return;
  }

  if (navigator.geolocation && !gpsWatchId) {
    ensureGPSWatch(false);
  }
}

// Auto-start on touch / coarse-pointer devices
if (window.matchMedia('(pointer: coarse)').matches) {
  startCompass();
}

// Backup: "Enable Compass" button in the sheet
if (compEnableBtn) {
  compEnableBtn.addEventListener('click', startCompass);
}

// Keep guide line in sync when anchor changes or map moves
compAnchorRadios.forEach(r =>
  r.addEventListener('change', updateGuideLine)
);

map.on('moveend', () => {
  const mode =
    (compAnchorRadios.find(r => r.checked) || {}).value || 'gps';
  if (mode === 'center') updateGuideLine();
});

// Build initial target list once on load
rebuildCompassTargets();
// [BHH: COMPASS END]


/*******************
 * STATE LOGIC (OH / IN)
 *******************/
// [BHH: STATE – LOGIC START]
const STORAGE_STATE = 'bhh_state_code';

const stateBadgeText  = document.getElementById('stateBadgeText');
const stateSelect     = document.getElementById('stateSelect');
const stateApplyBtn   = document.getElementById('stateApply');
const menuStateBtn    = document.getElementById('menuState');
const stateSheetRadios = Array.from(
  document.querySelectorAll('input[name="bhhState"]')
);

const STATE_CFG = {
  OH: {
    name: 'Ohio',
    center: [40.4173, -82.9071],
    zoom: 7,
    hasPublic: true,
    hasCounties: true,
    hasWaterfowl: true
  },
  IN: {
    name: 'Indiana',
    center: [39.905, -86.2816],
    zoom: 7,
    hasPublic: true,
    hasCounties: true,
    hasWaterfowl: true
  },
  MI: {
    name: 'Michigan',
    center: [44.1822, -84.5068], // approx center-of-state
    zoom: 7,
    hasPublic: true,
    hasCounties: true,
    hasWaterfowl: true
  },
  KY: {
    name: 'Kentucky',
    center: [37.8393, -84.2700],
    zoom: 7,
    hasPublic: true,
    hasCounties: true,
    hasWaterfowl: true
  },
  WV: {
    name: 'West Virginia',
    center: [38.5976, -80.4549],
    zoom: 7,
    hasPublic: true,
    hasCounties: true,
    hasWaterfowl: true
  },
  PA: {
    name: 'Pennsylvania',
    center: [40.9690, -77.7279],
    zoom: 7,
    hasPublic: true,
    hasCounties: true,
    hasWaterfowl: true
  },
  IL: {
  name: 'Illinois',
  center: [40.0000, -89.0000],
  zoom: 7,
  hasPublic: true,
  hasCounties: true,
  hasWaterfowl: false
},
WI: {
  name: 'Wisconsin',
  center: [44.5000, -89.5000],
  zoom: 7,
  hasPublic: true,
  hasCounties: true,
  hasWaterfowl: false
}
};

let currentState =
  (localStorage.getItem(STORAGE_STATE) || 'OH').toUpperCase();

function syncStateUI() {
  if (stateBadgeText) stateBadgeText.textContent = currentState;
  if (stateSelect)    stateSelect.value          = currentState;
  stateSheetRadios.forEach(r => {
    r.checked = (r.value.toUpperCase() === currentState);
  });
}

function onStateChanged() {
  const wantedPublic   = ovlOhio     && ovlOhio.checked;
  const wantedCounties = ovlCounties && ovlCounties.checked;

  const cfg = STATE_CFG[currentState] || STATE_CFG.OH;
  if (cfg) map.setView(cfg.center, cfg.zoom);

  const lblPublic    = document.getElementById('lblPublic');
  const lblCounties  = document.getElementById('lblCounties');
  const lblWaterfowl = document.getElementById('lblWaterfowl');

  const supportsPublic    = !!cfg.hasPublic;
  const supportsCounties  = !!cfg.hasCounties;
  const supportsWaterfowl = !!cfg.hasWaterfowl;

  // Update labels to show state name or “coming soon”
  if (lblCounties) {
    lblCounties.textContent = supportsCounties
      ? `${cfg.name} Counties`
      : 'State Counties (coming soon)';
  }

  if (lblPublic) {
    lblPublic.textContent = supportsPublic
      ? `${cfg.name} Public Hunting`
      : 'Public Hunting (coming soon)';
  }

  if (lblWaterfowl) {
    lblWaterfowl.textContent = supportsWaterfowl
      ? `${cfg.name} Waterfowl Zones`
      : 'Waterfowl Zones (coming soon)';
  }

  // Enable/disable overlay toggles based on support flags
  if (ovlOhio)      ovlOhio.disabled      = !supportsPublic;
  if (ovlCounties)  ovlCounties.disabled  = !supportsCounties;
  if (ovlWaterfowl) ovlWaterfowl.disabled = !supportsWaterfowl;

  // Remove all state-specific overlays first

  // Public hunting: remove all registered layers
  Object.values(PUBLIC_BY_STATE).forEach(layer => {
    if (layer && map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  });

  // Counties for all supported states
  Object.keys(COUNTY_REG).forEach(code => {
    const entry = COUNTY_REG[code];
    if (!entry) return;
    if (map.hasLayer(entry.counties)) map.removeLayer(entry.counties);
    if (map.hasLayer(entry.labels))   map.removeLayer(entry.labels);
  });

  // Re-add for the new state based on current checkboxes

  // Public hunting
  if (wantedPublic && ovlOhio && !ovlOhio.disabled) {
    const pubLayer = PUBLIC_BY_STATE[currentState];
    if (pubLayer) pubLayer.addTo(map);
  }


  // Counties
  if (wantedCounties && ovlCounties && !ovlCounties.disabled) {
    const entry = COUNTY_REG[currentState];
    if (entry) {
      entry.counties.addTo(map);
      entry.labels.addTo(map);
      refreshAllCountyLabels();
    }
  }

  // Waterfowl zones: ensure only the active state's layer is visible
  updateWaterfowlVisibility();

  // Make sure our overlay checkboxes match what's actually on the map
  syncOverlayChecks();
}

function setState(code, save = true) {
  const c = (code || 'OH').toUpperCase();
  currentState = c;
  if (save) localStorage.setItem(STORAGE_STATE, c);
  syncStateUI();
  onStateChanged();
}

syncStateUI();
onStateChanged();

if (menuStateBtn) {
  menuStateBtn.onclick = () => openSheet('state');
}

const stateBadge = document.getElementById('stateBadge');
if (stateBadge) {
  stateBadge.addEventListener('click', () => openSheet('state'));
}

stateSheetRadios.forEach(r => {
  r.addEventListener('change', () => setState(r.value));
});

if (stateApplyBtn) {
  stateApplyBtn.onclick = () => {
    setState(stateSelect.value);
    closeSheets();
  };
}
// [BHH: STATE – LOGIC END]





/*******************
 * SHEETS: open/close + menu wiring
 *******************/
// [BHH: SHEET LOGIC START]
const sheetBg = document.getElementById('sheetBackdrop');
const sheetMap = {
  basemap: document.getElementById('basemapSheet'),
  tools: document.getElementById('toolsSheet'),
  waypoints: document.getElementById('waypointsSheet'),
  track: document.getElementById('trackSheet'),
  wind: document.getElementById('windSheet'),
  almanac: document.getElementById('almanacSheet'),
  moon: document.getElementById('moonSheet'),
  score: document.getElementById('scoreSheet'),
  compass: document.getElementById('compassSheet'),
  wpDetail: document.getElementById('wpDetailSheet'),
  state: document.getElementById('stateSheet')
};

function openSheet(which) {
  Object.values(sheetMap).forEach(s => s && s.classList.remove('show'));
  if (!sheetBg || !sheetMap[which]) return;

  sheetBg.classList.add('show');
  sheetMap[which].classList.add('show');

  if (which === 'waypoints') refreshWaypointsUI();

  if (which === 'basemap') {
    syncOverlayChecks();
    syncBaseRadio();
    if (stateSelect) stateSelect.value = currentState;
  }

  if (which === 'moon') {
    renderMoon();
  }

  if (which === 'score') {
    computeHuntScore();
  }

  if (which === 'compass') {
    rebuildCompassTargets();
    updateCompassReadout();
    startCompass();
  }

  if (which === 'almanac') {
    const cb = document.getElementById('almanacFieldInfo');
    if (cb) cb.checked = (localStorage.getItem('ui_info_visible') === '1');
  }
}

function closeSheets() {
  if (!sheetBg) return;
  sheetBg.classList.remove('show');
  Object.values(sheetMap).forEach(s => s && s.classList.remove('show'));
}

if (sheetBg) {
  sheetBg.onclick = closeSheets;
}

// Wire the floating “BHH Map Layers” button
(function () {
  const layersBtnHandle = document.getElementById('bhhLayersBtnHandle');
  if (layersBtnHandle) {
    layersBtnHandle.onclick = () => openSheet('basemap');
  }
})();

// Inject a top-right × close button into every sheet and wire Esc-to-close
(function installSheetCloseButtons() {
  Object.values(sheetMap).forEach(s => {
    if (!s) return;
    if (!s.querySelector('.close-x')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'close-x';
      btn.setAttribute('aria-label', 'Close');
      btn.innerHTML = '&times;';
      btn.addEventListener('click', closeSheets);
      s.appendChild(btn);
    }
  });
})();

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSheets();
  }
});

// Almanac button + controls
const btnAlmanac = document.getElementById('menuAlmanac');
const almOpenScore = document.getElementById('almOpenScore');
const almOpenMoon = document.getElementById('almOpenMoon');
const almFieldInfo = document.getElementById('almanacFieldInfo');
const almClose = document.getElementById('almanacClose');

// Shop Gear button (bottom menu)
const btnShop = document.getElementById('menuShop');
if (btnShop) {
  btnShop.addEventListener('click', () => {
    window.open('https://www.buckeyehunterhub.com/shop', '_blank');
  });
}

if (btnAlmanac) {
  btnAlmanac.onclick = () => {
    if (almFieldInfo) {
      almFieldInfo.checked =
        (localStorage.getItem('ui_info_visible') === '1');
    }
    openSheet('almanac');
  };
}

if (almOpenScore) almOpenScore.onclick = () => openSheet('score');
if (almOpenMoon) almOpenMoon.onclick = () => openSheet('moon');
if (almClose) almClose.onclick = () => closeSheets();

if (almFieldInfo) {
  almFieldInfo.onchange =
    () => setInfoVisible(almFieldInfo.checked);
}

// Open Tools sheet and sync Delete toggle with current state
const menuToolsBtn = document.getElementById('menuTools');
if (menuToolsBtn) {
  menuToolsBtn.onclick = () => {
    const delToggle = document.getElementById('toolDeleteToggle');
    if (delToggle) delToggle.checked = !!deleteMode;
    openSheet('tools');
  };
}

const toolWaypointsBtn = document.getElementById('toolWaypoints');
if (toolWaypointsBtn) {
  toolWaypointsBtn.addEventListener('click', () => openSheet('waypoints'));
}

const toolTrackBtn = document.getElementById('toolTrack');
if (toolTrackBtn) {
  toolTrackBtn.addEventListener('click', () => openSheet('track'));
}

const toolCompassBtn = document.getElementById('toolCompass');
if (toolCompassBtn) {
  toolCompassBtn.addEventListener('click', () => openSheet('compass'));
}

const toolDeleteToggle = document.getElementById('toolDeleteToggle');
if (toolDeleteToggle) {
  toolDeleteToggle.onchange = () => {
    deleteMode = toolDeleteToggle.checked;
    const btnDelete = document.getElementById('btnDeleteMode');
    if (btnDelete) {
      btnDelete.textContent =
        `Delete: ${deleteMode ? 'On' : 'Off'}`;
    }
  };
}
// [BHH: SHEET LOGIC END]

// Wire overlay toggles that depend on layers defined previously
ovlMarks.onchange =
  () => ovlMarks.checked
    ? markersLayer.addTo(map)
    : map.removeLayer(markersLayer);

ovlTrack.onchange =
  () => ovlTrack.checked
    ? trackLayer.addTo(map)
    : map.removeLayer(trackLayer);


/*******************
 * STUBS for score/moon/info (safe no-op implementations)
 *******************/
function setInfoVisible(visible) {
  localStorage.setItem('ui_info_visible', visible ? '1' : '0');
}

function renderMoon() {
  // hook moon sheet in sun-moon.js if you want
}

function computeHuntScore() {
  // hook hunt score in hunt-score.js if you want
}
