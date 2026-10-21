/* global maplibregl, Papa */
import { CONFIG } from './config.js';

const CARTO_SQL = 'https://phl.carto.com/api/v2/sql';
const PHILLY_CENTER = [-75.1652, 39.9526];
const PHILLY_VIEWBOX = '-75.2803,40.1379,-74.9558,39.8670'; // left, top, right, bottom
const FEET_PER_METER = 3.28084;
const RADIUS_M = CONFIG.matchRadiusFeet / FEET_PER_METER;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const REPORT_FIELDS = [
  'service_request_id', 'service_name', 'status', 'status_notes', 'agency_responsible',
  'requested_datetime', 'updated_datetime', 'closed_datetime', 'address',
];

const state = {
  poles: [],          // { id, lat, lng }
  reports: [],        // 311 report properties + lat/lng + district
  districts: [],      // { key, name, feature, total, open }
  districtField: null,
  searchPoint: null,
  searchMarker: null,
  nearest: [],        // { idx, dist } nearest poles, meters
  selected: null,     // { kind: 'pole' | 'report', idx }
  selectedDistrict: null,
  requestToken: 0,
};

const els = {
  form: document.querySelector('#search-form'),
  input: document.querySelector('#address-input'),
  status: document.querySelector('#status'),
  nearestSection: document.querySelector('#nearest'),
  nearestList: document.querySelector('#nearest-list'),
  detail: document.querySelector('#detail'),
  districtSection: document.querySelector('#districts'),
  districtList: document.querySelector('#district-list'),
  districtNote: document.querySelector('#district-note'),
  showClosed: document.querySelector('#show-closed'),
};

//  map setup

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: PHILLY_CENTER,
  zoom: 11,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

map.on('load', async () => {
  for (const id of ['districts', 'poles', 'reports', 'selected']) {
    map.addSource(id, { type: 'geojson', data: EMPTY_FC });
  }

  map.addLayer({
    id: 'districts-fill',
    type: 'fill',
    source: 'districts',
    paint: {
      'fill-color': [
        'interpolate', ['linear'], ['get', 'share'],
        0, '#1f2236', 0.5, '#70412d', 1, '#a87f80',
      ],
      'fill-opacity': 0.45,
    },
  });
  map.addLayer({
    id: 'districts-line',
    type: 'line',
    source: 'districts',
    paint: {
      'line-color': ['case', ['boolean', ['get', 'selected'], false], '#6e8f3e', '#6e8f3e'],
      'line-width': ['case', ['boolean', ['get', 'selected'], false], 4, 1],
    },
  });
  map.addLayer({
    id: 'poles-layer',
    type: 'circle',
    source: 'poles',
    paint: {
      'circle-color': '#e3ad55',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2, 17, 5],
      'circle-opacity': 0.75,
    },
  });
  map.addLayer({
    id: 'reports-layer',
    type: 'circle',
    source: 'reports',
    paint: {
      'circle-color': ['case', ['==', ['get', 'status'], 'Open'], '#d18786', '#6499af'],
      'circle-stroke-color': ['case', ['==', ['get', 'status'], 'Open'], '#c35962', '#18668e'],
      'circle-stroke-width': 1.5,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5, 17, 10],
    },
  });
  map.addLayer({
    id: 'selected-layer',
    type: 'circle',
    source: 'selected',
    paint: {
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
      'circle-radius': 13,
    },
  });

  applyClosedFilter();
  bindEvents();

  setStatus('Loading 311 reports, streetlights, and council districts…');
  const [reports, poles, districts] = await Promise.allSettled([
    loadReports(), loadPoles(), loadDistricts(),
  ]);

  const problems = [];
  if (reports.status === 'rejected') problems.push(`Couldn't load 311 reports (${reports.reason.message}).`);
  if (poles.status === 'rejected') problems.push(poles.reason.message);
  if (districts.status === 'rejected') problems.push(districts.reason.message);

  if (reports.status === 'fulfilled' && districts.status === 'fulfilled') {
    countByDistrict();
    renderDistricts();
  }

  const open = state.reports.filter((r) => r.status === 'Open').length;
  const summary =
    `${state.reports.length.toLocaleString()} light outage reports in the past ${CONFIG.reportsSinceDays} days ` +
    `(${open.toLocaleString()} still open)` +
    (state.poles.length ? `, ${state.poles.length.toLocaleString()} city-owned streetlights.` : '.');
  setStatus(problems.length ? problems.join(' ') : `${summary} Search an address or click a point.`, problems.length > 0);
});

function bindEvents() {
  els.form.addEventListener('submit', handleSearch);
  els.showClosed.addEventListener('change', applyClosedFilter);

  map.on('click', (e) => {
    const pad = 4;
    const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    const [report] = map.queryRenderedFeatures(box, { layers: ['reports-layer'] });
    if (report) {
      selectReport(report.properties.idx);
      return;
    }
    const [pole] = map.queryRenderedFeatures(box, { layers: ['poles-layer'] });
    if (pole) selectPole(pole.properties.idx, { fly: map.getZoom() < 15 });
  });

  for (const layer of ['reports-layer', 'poles-layer']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
}

function applyClosedFilter() {
  const filter = els.showClosed.checked ? null : ['==', ['get', 'status'], 'Open'];
  map.setFilter('reports-layer', filter);
}

// data loading

async function loadReports() {
  const sql = `
    SELECT the_geom, ${REPORT_FIELDS.join(', ')}
    FROM public_cases_fc
    WHERE service_name ILIKE '%light outage%'
      AND requested_datetime >= NOW() - INTERVAL '${Number(CONFIG.reportsSinceDays)} days'
      AND the_geom IS NOT NULL
    ORDER BY requested_datetime DESC`;
  const geojson = await cartoQuery(sql, 'GeoJSON');

  state.reports = geojson.features.map((f, idx) => ({
    ...f.properties,
    idx,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    district: null,
  }));

  map.getSource('reports').setData({
    type: 'FeatureCollection',
    features: state.reports.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { idx: r.idx, status: r.status },
    })),
  });
}

async function loadPoles() {
  const cfg = CONFIG.poles;
  if (!cfg.csvPath) return;

  const res = await fetch(cfg.csvPath);
  if (!res.ok) throw new Error(`Couldn't load ${cfg.csvPath} (HTTP ${res.status}).`);
  const { data, meta } = Papa.parse(await res.text(), { header: true, skipEmptyLines: true });

  const missing = [cfg.lat, cfg.lng].filter((col) => !meta.fields.includes(col));
  if (missing.length) {
    throw new Error(
      `Column ${missing.join(' and ')} not found in ${cfg.csvPath}. ` +
      `Columns it has: ${meta.fields.join(', ')}. Update config.js.`
    );
  }

  state.poles = [];
  data.forEach((row, i) => {
    const lat = parseFloat(row[cfg.lat]);
    const lng = parseFloat(row[cfg.lng]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    state.poles.push({ id: String(row[cfg.id] || `row ${i + 1}`).trim(), lat, lng });
  });

  map.getSource('poles').setData({
    type: 'FeatureCollection',
    features: state.poles.map((p, idx) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { idx },
    })),
  });
}

async function loadDistricts() {
  const res = await fetch(CONFIG.districtsPath);
  if (!res.ok) throw new Error(`Couldn't load ${CONFIG.districtsPath} (HTTP ${res.status}).`);
  const geojson = await res.json();

  const sample = geojson.features[0]?.properties ?? {};
  state.districtField = CONFIG.districtField ||
    Object.keys(sample).find((k) => /^district$/i.test(k)) ||
    Object.keys(sample).find((k) => /dist/i.test(k));
  if (!state.districtField) {
    throw new Error(`No district number property found in ${CONFIG.districtsPath}. Set districtField in config.js.`);
  }

  state.districts = geojson.features.map((feature) => {
    const key = String(feature.properties[state.districtField]).trim();
    return { key, name: `District ${key}`, feature, bbox: bboxOf(feature.geometry), total: 0, open: 0 };
  });
  state.districts.sort((a, b) => Number(a.key) - Number(b.key));
}

// Fetched on demand is every light outage report near one pole, all years, newest first
async function fetchPoleHistory(pole) {
  const pt = `ST_SetSRID(ST_MakePoint(${pole.lng}, ${pole.lat}), 4326)`;
  // needed to ask claude for help here: the_geom_webmercator is indexed. Mercator distances are stretched by 1/cos(latitude),
  // so the buffer is padded to match and the true distance filters the result.
  const mercatorRadius = RADIUS_M / Math.cos((pole.lat * Math.PI) / 180);
  const sql = `
    SELECT ${REPORT_FIELDS.join(', ')},
           ST_Distance(the_geom::geography, ${pt}::geography) AS dist_m
    FROM public_cases_fc
    WHERE service_name ILIKE '%light outage%'
      AND ST_DWithin(the_geom_webmercator, ST_Transform(${pt}, 3857), ${mercatorRadius.toFixed(1)})
    ORDER BY requested_datetime DESC`;
  const { rows } = await cartoQuery(sql);
  return rows.filter((r) => r.dist_m <= RADIUS_M);
}

async function cartoQuery(sql, format = 'json') {
  const url = `${CARTO_SQL}?format=${format}&q=${encodeURIComponent(sql)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function geocode(query) {
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '1', countrycodes: 'us', viewbox: PHILLY_VIEWBOX, bounded: '1',
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const [hit] = await res.json();
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name } : null;
}

//  council districts

function countByDistrict() {
  for (const d of state.districts) { d.total = 0; d.open = 0; }
  for (const r of state.reports) {
    const d = districtAt(r.lng, r.lat);
    if (!d) continue;
    r.district = d.key;
    d.total += 1;
    if (r.status === 'Open') d.open += 1;
  }
  updateDistrictSource();
}

function districtAt(lng, lat) {
  return state.districts.find((d) => (
    lng >= d.bbox[0] && lng <= d.bbox[2] && lat >= d.bbox[1] && lat <= d.bbox[3] &&
    pointInGeometry(lng, lat, d.feature.geometry)
  )) || null;
}

function updateDistrictSource() {
  const max = Math.max(1, ...state.districts.map((d) => d.total));
  map.getSource('districts').setData({
    type: 'FeatureCollection',
    features: state.districts.map((d) => ({
      type: 'Feature',
      geometry: d.feature.geometry,
      properties: { key: d.key, share: d.total / max, selected: d.key === state.selectedDistrict },
    })),
  });
}

function renderDistricts() {
  const ranked = [...state.districts].sort((a, b) => b.total - a.total);
  const max = Math.max(1, ranked[0]?.total ?? 1);
  const unmatched = state.reports.length - ranked.reduce((sum, d) => sum + d.total, 0);

  els.districtSection.hidden = false;
  els.districtList.innerHTML = ranked.map((d) => `
    <li>
      <button type="button" data-key="${esc(d.key)}" class="${d.key === state.selectedDistrict ? 'active' : ''}"
        ${d.key === state.selectedDistrict ? 'aria-current="true"' : ''}>
        <span class="district-name">${esc(d.name)}</span>
        <span class="bar" aria-hidden="true"><span style="width:${((d.total / max) * 100).toFixed(1)}%"></span></span>
        <span class="district-count">${d.total.toLocaleString()} <span class="muted">· ${d.open.toLocaleString()} open</span></span>
      </button>
    </li>`).join('');

  els.districtNote.textContent =
    `Light outage reports in the past ${CONFIG.reportsSinceDays} days. Shading on the map follows the same counts.` +
    (unmatched > 0 ? ` ${unmatched.toLocaleString()} reports fell outside the district boundaries.` : '');

  els.districtList.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => selectDistrict(btn.dataset.key));
  });
}

function selectDistrict(key) {
  state.selectedDistrict = state.selectedDistrict === key ? null : key;
  updateDistrictSource();
  renderDistricts();
  const d = state.districts.find((x) => x.key === state.selectedDistrict);
  if (d) map.fitBounds([[d.bbox[0], d.bbox[1]], [d.bbox[2], d.bbox[3]]], { padding: 40 });
}

//  search

async function handleSearch(e) {
  e.preventDefault();
  const query = els.input.value.trim();
  if (!query) return;

  setStatus('Looking up that address…');
  let place;
  try {
    place = await geocode(query);
  } catch {
    setStatus('The address lookup failed. Try again in a moment.', true);
    return;
  }
  if (!place) {
    setStatus(`Couldn't find "${query}" in Philadelphia. Try a format like "3401 Walnut St".`, true);
    return;
  }

  state.searchPoint = place;
  placeSearchMarker(place);
  const d = districtAt(place.lng, place.lat);
  setStatus(`${shortLabel(place.label)}${d ? ` · Council ${d.name}` : ''}`);

  if (state.poles.length) {
    state.nearest = nearestOf(state.poles, place.lat, place.lng, CONFIG.nearestCount);
    renderNearest();
    const bounds = new maplibregl.LngLatBounds([place.lng, place.lat], [place.lng, place.lat]);
    for (const n of state.nearest) bounds.extend([state.poles[n.idx].lng, state.poles[n.idx].lat]);
    map.fitBounds(bounds, { padding: 80, maxZoom: 18 });
    if (state.nearest.length) selectPole(state.nearest[0].idx, { fly: false });
  } else {
    // No pole CSV: fall back to the closest 311 report
    map.easeTo({ center: [place.lng, place.lat], zoom: 17 });
    const [closest] = nearestOf(state.reports, place.lat, place.lng, 1);
    if (closest) selectReport(closest.idx, { fly: false });
  }
}

function placeSearchMarker(place) {
  if (!state.searchMarker) {
    const el = document.createElement('div');
    el.className = 'search-marker';
    state.searchMarker = new maplibregl.Marker({ element: el });
  }
  state.searchMarker.setLngLat([place.lng, place.lat]).addTo(map);
}

function nearestOf(points, lat, lng, n) {
  const best = [];
  points.forEach((p, idx) => {
    const dist = distanceMeters(lat, lng, p.lat, p.lng);
    if (best.length < n || dist < best[best.length - 1].dist) {
      best.push({ idx, dist });
      best.sort((a, b) => a.dist - b.dist);
      if (best.length > n) best.pop();
    }
  });
  return best;
}

function reportsNear(lat, lng) {
  return state.reports.filter((r) => distanceMeters(lat, lng, r.lat, r.lng) <= RADIUS_M);
}

function renderNearest() {
  els.nearestSection.hidden = state.nearest.length === 0;
  els.nearestList.innerHTML = state.nearest.map(({ idx, dist }) => {
    const p = state.poles[idx];
    const isOut = reportsNear(p.lat, p.lng).some((r) => r.status === 'Open');
    return `
      <li>
        <button type="button" data-idx="${idx}">
          <span class="nearest-name">Pole ${esc(p.id)}</span>
          <span class="nearest-meta">${fmtFeet(dist * FEET_PER_METER)} away
            ${isOut ? '<span class="tag tag-out">Reported out</span>' : ''}</span>
        </button>
      </li>`;
  }).join('');

  els.nearestList.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => selectPole(Number(btn.dataset.idx)));
  });
  highlightNearest();
}

function highlightNearest() {
  els.nearestList.querySelectorAll('button').forEach((btn) => {
    const active = state.selected?.kind === 'pole' && Number(btn.dataset.idx) === state.selected.idx;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  });
}

//  selection

function markSelected(lng, lat, fly) {
  map.getSource('selected').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
  });
  if (fly) map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 17) });
}

function selectReport(idx, { fly = false } = {}) {
  const r = state.reports[idx];
  state.selected = { kind: 'report', idx };
  state.requestToken += 1; // cancels any pole history still loading
  markSelected(r.lng, r.lat, fly);
  highlightNearest();
  renderReportDetail(r);
}

async function selectPole(idx, { fly = true } = {}) {
  const pole = state.poles[idx];
  state.selected = { kind: 'pole', idx };
  markSelected(pole.lng, pole.lat, fly);
  highlightNearest();
  renderPoleDetail(pole, null);

  const token = ++state.requestToken;
  try {
    const history = await fetchPoleHistory(pole);
    if (token === state.requestToken) renderPoleDetail(pole, history);
  } catch (err) {
    if (token === state.requestToken) renderPoleDetail(pole, null, err);
  }
}

// detail panel

function renderReportDetail(r) {
  const d = r.district ? `Council District ${r.district}` : '—';
  const facts = [
    ['Address', r.address || 'No address given'],
    ['Reported', fmtDate(r.requested_datetime)],
    ['Last updated', fmtDate(r.updated_datetime)],
    ['Closed', r.closed_datetime ? fmtDate(r.closed_datetime) : 'Not yet'],
    ['Council district', d],
    ['311 request #', r.service_request_id],
  ];
  if (state.poles.length) {
    const [pole] = nearestOf(state.poles, r.lat, r.lng, 1);
    if (pole) facts.push(['Nearest city pole', `${state.poles[pole.idx].id} (${fmtFeet(pole.dist * FEET_PER_METER)})`]);
  }
 
  showDetail(`
    <p class="eyebrow">311 report</p>
    <h2>${esc(r.service_name || 'Light outage')}</h2>
    ${reportBadge(r)}
    ${notesBlock(r.status_notes)}
    ${factsList(facts)}
    ${contactBlock(r.agency_responsible, r.service_name)}`);
}

function renderPoleDetail(pole, history, error) {
  const d = districtAt(pole.lng, pole.lat);
  const facts = [['Council district', d ? d.name : '—']];
  if (state.searchPoint) {
    const dist = distanceMeters(state.searchPoint.lat, state.searchPoint.lng, pole.lat, pole.lng);
    facts.push(['From your address', fmtFeet(dist * FEET_PER_METER)]);
  }

  let body;
  if (error) {
    body = `${badgeHtml('unknown', "Couldn't reach Philly311 data")}<p class="muted">${esc(error.message)}</p>${factsList(facts)}${contactBlock(null)}`;
  } else if (!history) {
    body = `${badgeHtml('loading', 'Checking 311 reports…')}${factsList(facts)}`;
  } else {
    const latest = history[0];
    const open = history.filter((r) => r.status === 'Open');
    const current = open.length ? open[open.length - 1] : latest; // oldest open report, else the newest one
    body = `
      ${current ? reportBadge(current) : badgeHtml('ok', 'No outage reports on record')}
      ${current ? notesBlock(current.status_notes) : ''}
      ${factsList(facts)}
      ${contactBlock(current?.agency_responsible, current?.service_name)}
      ${historyBlock(history)}`;
  }

  showDetail(`
    <p class="eyebrow">City-owned streetlight</p>
    <h2>Pole ${esc(pole.id)}</h2>
    ${body}`);
}

function showDetail(html) {
  els.detail.hidden = false;
  els.detail.innerHTML = `${html}
    <p class="muted small"> No open report doesn't always mean a light works. It may have gone unreported. </p>`;
}

function reportBadge(r) {
  if (r.status === 'Open') {
    const days = businessDaysBetween(new Date(r.requested_datetime), new Date());
    const late = days > CONFIG.repairTargetBusinessDays ? ` · past the ${CONFIG.repairTargetBusinessDays}-day repair goal` : '';
    return badgeHtml('out', `Open · ${days} business day${days === 1 ? '' : 's'}${late}`);
  }
  if (r.closed_datetime) {
    const days = businessDaysBetween(new Date(r.requested_datetime), new Date(r.closed_datetime));
    return badgeHtml('ok', `${r.status || 'Closed'} · closed in ${days} business day${days === 1 ? '' : 's'}`);
  }
  return badgeHtml('unknown', r.status || 'Status unknown');
}

function notesBlock(notes) {
  return `
    <div class="notes">
      <p class="label">Status notes from the department</p>
      <p>${notes ? esc(notes) : '<span class="muted">No notes posted.</span>'}</p>
    </div>`;
}

function factsList(facts) {
  return `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

function contactBlock(agency, serviceName) {
  const c = contactFor(agency, serviceName);
  const lines = [
    c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '',
    c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.urlLabel || c.url)}</a>` : '',
    c.phone ? `Phone: ${esc(c.phone)}` : '',
  ].filter(Boolean);
  return `
    <div class="contact">
      <p class="label">Responsible agency</p>
      <p class="agency">${esc(agency || 'Not listed in 311')}</p>
      <p class="label">To report or follow up</p>
      ${c.note ? `<p>${esc(c.note)}</p>` : ''}
      <p>${esc(c.name)}<br>${lines.join('<br>')}</p>
    </div>`;
}

function contactFor(agency, serviceName) {
  if (/alley/i.test(serviceName || '')) {
    return {
      ...CONFIG.defaultContact,
      url: '',
      note: 'Alley light outages are reported by calling 311, not through the online form.',
    };
  }
  const a = String(agency || '').toLowerCase();
  const match = a && CONFIG.contacts.find((c) => a.includes(c.match.toLowerCase()));
  if (!match) return CONFIG.defaultContact;
  return { ...match, phone: match.phone || CONFIG.defaultContact.phone };
}

function historyBlock(reports) {
  if (!reports.length) {
    return `<h3>Outage history</h3><p class="muted">No street or alley light outages reported within ${CONFIG.matchRadiusFeet} ft.</p>`;
  }

  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const lastYear = reports.filter((r) => new Date(r.requested_datetime) >= yearAgo).length;
  const closeTimes = reports
    .filter((r) => r.closed_datetime)
    .map((r) => businessDaysBetween(new Date(r.requested_datetime), new Date(r.closed_datetime)));
  const onTime = closeTimes.filter((d) => d <= CONFIG.repairTargetBusinessDays).length;

  const stats = [
    [reports.length, 'reports, all years'],
    [lastYear, 'in the past year'],
    [closeTimes.length ? median(closeTimes) : '—', 'median business days to close'],
    [closeTimes.length ? `${Math.round((onTime / closeTimes.length) * 100)}%` : '—', `closed within ${CONFIG.repairTargetBusinessDays} days`],
  ];

  const shown = reports.slice(0, 10);
  const items = shown.map((r) => `
    <li class="${r.status === 'Open' ? 'is-open' : ''}">
      <span class="report-date">${fmtDate(r.requested_datetime)}</span>
      <span class="report-body">
        <strong>${esc(r.status || '—')}</strong> · ${esc((r.service_name || '').replace(/\s*outage\s*/i, ''))}
        ${r.status_notes ? `<br>${esc(r.status_notes)}` : ''}
        <br><span class="muted">${esc(r.address || 'No address')} · ${fmtFeet(r.dist_m * FEET_PER_METER)} from pole</span>
      </span>
    </li>`).join('');
  const more = reports.length > shown.length ? `<p class="muted small">and ${reports.length - shown.length} older reports</p>` : '';

  return `
    <h3>Outage history <span class="muted">within ${CONFIG.matchRadiusFeet} ft</span></h3>
    <div class="stats">${stats.map(([v, l]) => `<div><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`).join('')}</div>
    <ol class="reports">${items}</ol>
    ${more}
    <p class="muted small">Neighbors often report the same outage more than once. An outage can appear as several reports.</p>`;
}

//  helpers: asked Claude for help in understanding

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

function badgeHtml(kind, text) {
  return `<p class="badge badge-${kind}">${esc(text)}</p>`;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bboxOf(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    for (const [x, y] of poly[0]) {
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
  }
  return box;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  return !rings.slice(1).some((hole) => pointInRing(x, y, hole));
}

function pointInGeometry(x, y, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygon(x, y, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((p) => pointInPolygon(x, y, p));
  return false;
}

function businessDaysBetween(start, end) {
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  const stop = new Date(end);
  stop.setHours(0, 0, 0, 0);
  let count = 0;
  while (d < stop) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) count += 1;
  }
  return count;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function fmtFeet(feet) {
  return feet < 1000 ? `${Math.round(feet)} ft` : `${(feet / 5280).toFixed(1)} mi`;
}

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortLabel(label) {
  return label.split(',').slice(0, 3).join(',');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}