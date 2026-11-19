(function () {
'use strict';
const SC = window.SCENARIO;
const SEG = { walk: '도보', wait: '대기', ride: '버스·택시·타슈', dock: '타슈 대여·반납', sub: '지하철' };
const REFRESH_MS = 30000;
const DRIVE_STALE_MS = 15 * 60000; // 이보다 오래된 택시 결과는 '확인됨'으로 보지 않음
const TASHU_STALE_MS = 3 * 60000;
const ROUTE_STALE_MS = 15 * 60000; // 화면에 표시 중인 카카오 대중교통·도보·자전거 결과가 이보다 오래되면 '확인됨'으로 보지 않음
const LEG_RETRY_MS = 5 * 60000;    // 실패한 도보·자전거 구간은 30초 갱신 때 바로 다시 부르지 않음 (새로고침·위치 변경 때는 다시 조회)

const st = {
  origin: { ...SC.origin }, originKey: SC.origin.key || null, dest: { ...SC.dest }, pick: 'origin', tab: 'compare',
  plan: null, planAt: 0, planWhy: null, extraStops: [], legs: {}, tashuNear: {}, subwayKey: null, presetPos: {},
  seq: {}, tripVer: 0,                    // 요청 순번·위치 버전: 늦게 도착한 옛 응답을 버리는 데 사용
  stops: [], stopsErr: null, arr: {}, drive: {}, cfg: { mock: true, drive: false }, loading: false, updated: null,
  map: null, overlays: {}, stopOverlays: [], open: new Set(),
  gen: 0, arrBusy: 0, driveVer: 0, tashuAt: 0,
};
const $ = (s) => document.querySelector(s);
const c4 = (v) => Number(v).toFixed(4); // 서버로 보내는 좌표는 소수 4자리(약 11m)까지만
const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
async function api(path, params) {
  const r = await fetch(path + (params ? '?' + new URLSearchParams(params) : ''));
  let body = {};
  try { body = await r.json(); } catch { /* 빈 응답 */ }
  if (!r.ok) { const e = new Error(body.error || `요청 실패 (${r.status})`); e.status = r.status; throw e; }
  return body;
}
function dist(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const walkMin = (m) => Math.max(1, Math.ceil((m * SC.walk.detour) / SC.walk.mPerMin));
// 지금 남은 도착 시간(초): 받아온 시점 이후 흐른 시간만큼 빼기
const catchOk = (remMin, walk) => remMin >= walk + (SC.bufferMin || 0);
const remainSec = (a, at) => Math.max(0, a.arrSec - (Date.now() - at) / 1000);
const TR = SC.transit || {};
const R = SC.supportRadiusM || 1000;
// 이름 비교용: 괄호 속 부가 명칭·공백·점 제거 (카카오 ↔ TAGO 정류장 이름 대조)
const norm = (t) => String(t || '').replace(/\(.*?\)/g, '').replace(/[\s.·ㆍ-]/g, '');
const stNorm = (t) => norm(t).replace(/역$/, '');
function stationNum(name) {
  const n = stNorm(name);
  for (const [k, v] of Object.entries(SC.subway.stations || {})) if (stNorm(k) === n) return v;
  return null;
}
const stationName = (name) => stNorm(name) + '역';
// 출발지 기준점(좌표가 있는 것만): scenario.js 좌표 또는 이번 세션에서 장소 검색으로 찾은 좌표
const presetPos = (p) => (p.lat != null && p.lng != null ? p : st.presetPos[p.key] || null);
function supported() {
  if (dist(st.dest, SC.dest) > R) return false;
  return SC.origins.some((p) => { const q = presetPos(p); return q && dist(st.origin, q) <= R; });
}
// 기존 고정 경로(108번·월평역)를 쓸 수 있는 출발지: 공대 3호관을 골랐거나, 직접 찍은 위치가 그 1km 안
const legacyOrigin = () => st.originKey === SC.origins[0].key || (!st.originKey && dist(st.origin, SC.origins[0]) <= R);
// 지금 경로의 환승역: 카카오 대중교통 경로의 지하철 승차역, 없으면 기본 환승역(가정)
function hubInfo() {
  const p = st.plan;
  if (p && p.hub) return { ...p.hub, alight: p.alight, dir: p.dir, fromPlan: true };
  return { name: SC.hub.name, lat: SC.hub.lat, lng: SC.hub.lng, stNum: SC.subway.stNum, dir: SC.subway.dir,
    alight: { name: SC.dest.name, stNum: SC.subway.destStNum }, fromPlan: false };
}
// 지금 위치(출발·목적지)와 위치 버전. 응답을 적용하기 전에 요청할 때의 값과 같은지 확인
const tripKey = () => [c4(st.origin.lat), c4(st.origin.lng), c4(st.dest.lat), c4(st.dest.lng), st.tripVer].join(',');
const hubKey = () => { const hb = hubInfo(); return hb.stNum + '-' + hb.alight.stNum; };
// 요청 티켓: 같은 종류의 더 새 요청이 있거나 위치(·환승역)가 바뀌었으면 false → 그 응답은 버림
function ticket(name, keyFn) {
  const n = (st.seq[name] = (st.seq[name] || 0) + 1), k = tripKey() + '|' + (keyFn ? keyFn() : '');
  return () => st.seq[name] === n && tripKey() + '|' + (keyFn ? keyFn() : '') === k;
}
const sameHub = (h) => stNorm(h.name) === stNorm(SC.hub.name);
const estMin = (a, b, kmh) => Math.max(1, (dist(a, b) * SC.walk.detour) / (kmh * 1000 / 60));

/* ---------------- 지도 (카카오 JavaScript 키가 있으면 카카오맵, 없으면 OpenStreetMap) ---------------- */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('스크립트를 불러오지 못했습니다')); document.head.append(s); });
}
function mapEmpty(title, text) {
  $('#map').replaceChildren(h('div', { class: 'map-empty' }, h('div', null, h('b', null, title), text)));
}
const kakaoAdapter = {
  async load(key) {
    await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`);
    await new Promise((res) => window.kakao.maps.load(res));
  },
  init(el, c, onClick) {
    const k = window.kakao.maps;
    this.map = new k.Map(el, { center: new k.LatLng(c.lat, c.lng), level: 6 });
    k.event.addListener(this.map, 'click', (e) => onClick(e.latLng.getLat(), e.latLng.getLng()));
  },
  label(pos, cls, text) {
    const k = window.kakao.maps;
    const o = new k.CustomOverlay({ position: new k.LatLng(pos.lat, pos.lng), content: `<div class="mk ${cls}">${text}</div>`, yAnchor: 1, zIndex: cls === 's' || cls === 't' ? 1 : 3 });
    o.setMap(this.map); return { remove: () => o.setMap(null) };
  },
  fit(pts) { const k = window.kakao.maps, b = new k.LatLngBounds(); pts.forEach((p) => b.extend(new k.LatLng(p.lat, p.lng))); this.map.setBounds(b, 40, 40, 40, 40); },
};
const leafletAdapter = {
  async load() {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.append(css);
    await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
  },
  init(el, c, onClick) {
    el.replaceChildren();
    this.map = window.L.map(el, { zoomControl: false }).setView([c.lat, c.lng], 14);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(this.map);
    this.map.on('click', (e) => onClick(e.latlng.lat, e.latlng.lng));
  },
  label(pos, cls, text) {
    const icon = window.L.divIcon({ className: 'mk-wrap', html: `<div class="mk ${cls}">${text}</div>`, iconSize: null, iconAnchor: [0, 0] });
    const m = window.L.marker([pos.lat, pos.lng], { icon, zIndexOffset: cls === 's' || cls === 't' ? 0 : 1000 }).addTo(this.map);
    return { remove: () => m.remove() };
  },
  fit(pts) { this.map.fitBounds(pts.map((p) => [p.lat, p.lng]), { padding: [40, 40] }); },
};
let MAP = null;
async function initMap() {
  const onClick = (lat, lng) => setPoint(st.pick, { name: '지도에서 선택한 위치', lat, lng }, true);
  const tries = st.cfg.kakaoJsKey ? [[kakaoAdapter, st.cfg.kakaoJsKey], [leafletAdapter]] : [[leafletAdapter]];
  for (const [ad, key] of tries) {
    try { await ad.load(key); ad.init($('#map'), st.origin, onClick); MAP = ad; drawPoints(true); return; } catch { /* 다음 지도로 */ }
  }
  mapEmpty('지도를 불러오지 못했어요', '인터넷 연결을 확인하세요. 지도 없이도 아래 비교는 동작합니다.');
}
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function drawPoints(fit) {
  if (!MAP) return;
  Object.values(st.overlays).forEach((o) => o.remove());
  st.overlays = { o: MAP.label(st.origin, 'o', '출발'), d: MAP.label(st.dest, 'd', '도착') };
  if (fit) MAP.fit([st.origin, st.dest]);
}
function drawStops() {
  if (!MAP) return;
  st.stopOverlays.forEach((o) => o.remove());
  st.stopOverlays = [
    ...st.stops.map((s) => MAP.label(s, 's', escapeHtml(s.name.replace(/^\(예시\)\s*/, '')))),
    ...(st.tashu ? st.tashu.stations.slice(0, 4).map((t) => MAP.label(t, 't', `타슈 ${t.bikes}`)) : []),
  ];
}

/* ---------------- 위치 지정 ---------------- */
// 출발지·목적지가 바뀌면 이전 위치로 계산한 결과는 모두 버림 (늦게 도착한 옛 응답도 tripKey가 달라 적용되지 않음)
function invalidate(which) {
  st.plan = null; st.planAt = 0; st.planWhy = null; st.extraStops = []; st.legs = {}; st.tashuNear = {}; st.drive = {};
  if (which === 'origin') { st.stops = []; st.arr = {}; st.tashu = null; st.tashuAt = 0; }
}
function setPoint(which, p, keepView) {
  st[which] = p;
  st.tripVer++;
  if (which === 'origin') { st.originKey = p.key || null; st.seq.select = (st.seq.select || 0) + 1; }  // 진행 중인 출발지 검색 응답은 버림
  invalidate(which);
  $('#oName').textContent = st.origin.name; $('#dName').textContent = st.dest.name;
  drawPoints(!keepView);
  renderPresets();
  if (which === 'origin') loadStops();
  else loadDest().then(render);
}
function setPick(which) {
  st.pick = which;
  $('#pickOrigin').classList.toggle('on', which === 'origin'); $('#pickOrigin').setAttribute('aria-pressed', which === 'origin');
  $('#pickDest').classList.toggle('on', which === 'dest'); $('#pickDest').setAttribute('aria-pressed', which === 'dest');
}
// 출발지 선택 (update10): 좌표가 없는 출발지는 카카오 장소 검색 1순위로 좌표를 찾고 '좌표 미확인'으로 표시
//   검색 응답이 늦게 와도, 그 사이 다른 출발지를 고르거나 지도에서 위치를 바꿨으면 버림
async function selectOrigin(key) {
  const p = SC.origins.find((x) => x.key === key);
  if (!p) return;
  const my = (st.seq.select = (st.seq.select || 0) + 1);
  let pos = p.lat != null && p.lng != null ? p : null, from = null;   // 좌표 없는 출발지는 고를 때마다 검색(재사용 없음)
  if (!pos) {
    if (!st.cfg.search) { showBanner(`'${p.name}' 좌표가 아직 없어요. scenario.js에 좌표를 넣거나 카카오 REST 키가 있어야 장소 검색으로 찾을 수 있어요.`); return; }
    try {
      const places = (await api('/api/search', { q: p.query })).places;   // 카카오 로컬 검색: 재사용 없음(update11), 고를 때마다 조회
      if (st.seq.select !== my) return;
      const top = (places || []).find((x) => validPt(x));
      if (!top) throw new Error('검색 결과 없음');
      pos = { lat: top.lat, lng: top.lng }; from = `${top.name} · ${top.address}`;
      st.presetPos[p.key] = { ...pos, from };
    } catch (e) { if (st.seq.select === my) showBanner(`'${p.name}' 좌표를 찾지 못했어요: ${e.message}`); return; }
  }
  if (st.seq.select !== my) return;
  setPoint('origin', { key: p.key, name: p.name, lat: pos.lat, lng: pos.lng, verified: !!p.verified, from: from || pos.from || null });
}
function showBanner(t) { const b = $('#banner'); b.hidden = false; b.textContent = t; }
function renderPresets() {
  const box = $('#presets');
  if (!box) return;
  box.replaceChildren(...SC.origins.map((p) => h('button', { type: 'button', class: 'pm' + (st.originKey === p.key ? ' on' : ''), 'aria-pressed': String(st.originKey === p.key), onclick: () => selectOrigin(p.key) },
    p.name.replace(/^충남대 /, ''), p.verified ? null : h('small', null, ' 좌표 미확인'))));
}

/* ---------------- 응답 검사: null·빈값·음수·비정상 좌표는 정상 응답으로 쓰지 않음 ---------------- */
const fnum = (v) => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : NaN);
const nonNeg = (v) => fnum(v) >= 0;
const validPt = (p) => !!p && fnum(p.lat) >= 33 && fnum(p.lat) <= 39 && fnum(p.lng) >= 124 && fnum(p.lng) <= 132;
const validLeg = (v) => !!v && nonNeg(v.sec) && nonNeg(v.m);
function validRoutes(routes) {
  return (Array.isArray(routes) ? routes : []).filter((r) => r && Array.isArray(r.steps) && r.steps.length
    && r.steps.every((s) => s && ['WALKING', 'BUS', 'SUBWAY'].includes(s.type) && nonNeg(s.sec) && Array.isArray(s.stops) && Array.isArray(s.vehicles))
    && r.steps.every((s) => s.type === 'WALKING' || s.stops.length >= 2));
}
const validDrive = (v) => !!v && fnum(v.durationSec) > 0 && nonNeg(v.distanceM);
// 시각표 정리: 구조가 틀리면 버리고, 시각 목록 안의 비정상 값(null·음수)만 걸러 냄 (실제 응답에 섞여 온 적 있음 → 표 전체를 버리지 않음)
function cleanTimetable(r) {
  if (!r || r.mock || !r.days || typeof r.days !== 'object') return null;
  const days = {};
  for (const [d, v] of Object.entries(r.days)) {
    days[d] = {};
    for (const [dir, x] of Object.entries(v || {})) {
      if (!x || !Array.isArray(x.from)) return null;
      days[d][dir] = { from: x.from.filter((t) => nonNeg(t)).map(Number).sort((a, b) => a - b), ride: fnum(x.ride) > 0 ? Number(x.ride) : null };
    }
  }
  return { ...r, days };
}

/* ---------------- 데이터 ---------------- */
async function loadStops(refresh) {
  const gen = ++st.gen;
  st.stopsErr = null; st.stopsNote = null; st.loading = true; render();
  try {
    try {
      const r = await api('/api/stops', { lat: c4(st.origin.lat), lng: c4(st.origin.lng) });
      if (gen !== st.gen) return;                       // 그 사이 출발지가 또 바뀌었으면 이 결과는 버림
      st.stops = (r.stops || []).filter((s) => s && s.id && validPt(s)).map((s) => ({ ...s, d: dist(st.origin, s) })).filter((s) => s.d <= 600).sort((a, b) => a.d - b.d).slice(0, 8);
    } catch (e) {
      if (gen !== st.gen) return;
      // 근처 정류장 API가 안 될 때(미승인 등): scenario.js에 적어 둔 정류장 번호로 대전시 도착정보 사용 (공대 3호관 기준 정류장)
      const fixed = legacyOrigin() ? (SC.bus.arsStops || []).filter((x) => x.arsId) : [];
      if (!fixed.length) { st.stops = []; st.stopsErr = e.message; }
      else {
        st.stops = fixed.map((x) => ({ id: 'ars' + x.arsId, arsId: String(x.arsId), no: String(x.arsId), name: x.name || `정류장 ${x.arsId}`, lat: x.lat, lng: x.lng, fixed: true }))
          .map((x) => ({ ...x, d: x.lat && x.lng ? dist(st.origin, x) : 300 }));
        st.stopsNote = `근처 정류장 찾기 API를 쓸 수 없어 scenario.js에 지정한 정류장 ${fixed.length}곳의 도착정보를 보여 줘요. (${e.message})`;
      }
    }
    drawStops();
    await loadTransit();                                // 경로 구성(카카오 대중교통) → 탈 정류장·환승역 결정 (매번 새로 조회)
    if (gen !== st.gen) return;
    await Promise.all([loadArrivals(true, refresh), loadDrives(refresh), loadSubway(refresh)]);
  } finally { if (gen === st.gen) { st.loading = false; render(); } }
}
// 목적지만 바뀌었을 때: 경로 구성·택시·도보/자전거 구간·시각표를 새 목적지로 다시
async function loadDest() {
  await loadTransit();
  await Promise.all([loadArrivals(true), loadDrives(), loadSubway()]);
}
// 30초마다 부르는 갱신: 버스 도착정보와 타슈만. 카카오 길찾기(택시·대중교통·도보·자전거)는 화면의 결과를 그대로 쓰고 다시 부르지 않음
//   refresh: 사용자가 새로고침(↻)을 눌렀을 때 — 도보·자전거·타슈·시각표까지 다시 조회
async function loadArrivals(force, refresh) {
  if (st.arrBusy && !force) return;                   // 이전 갱신이 안 끝났으면 겹쳐 부르지 않음
  const gen = st.gen, k0 = tripKey(), res = {};
  const watch = [...st.stops, ...st.extraStops.filter((x) => !st.stops.some((s) => s.id === x.id))];
  st.arrBusy++;
  try {
    await Promise.all(watch.map(async (s) => {
      try {
        let r = await (s.arsId ? api('/api/arrivals-dj', { arsId: s.arsId }) : api('/api/arrivals', { nodeId: s.id }).catch((e) => { if (!s.no) throw e; return { list: [] }; }));
        if (!s.arsId && !(r.list || []).length && s.no && !r.mock) r = await api('/api/arrivals-dj', { arsId: s.no }); // TAGO가 비면 대전시 API로 보조 조회
        const at = fnum(r.at) > 0 ? Number(r.at) : Date.now();
        res[s.id] = { ...r, at, list: (r.list || []).filter((b) => b && b.routeNo != null && nonNeg(b.arrSec)), err: null };
      }
      catch (e) { res[s.id] = { list: [], at: Date.now(), err: e.message }; }
    }));
    if (gen !== st.gen) return;
    if (tripKey() === k0) { st.arr = res; st.updated = Date.now(); }
    else Object.assign(st.arr, res);                  // 목적지만 바뀐 경우: 정류장 도착정보는 그대로 유효
    await loadTashu();
    await loadLegs(!!refresh);
    drawStops();
    render();
  } finally { st.arrBusy--; }
}
// 열차시각표: 환승역(승차역)→하차역 쌍이 바뀔 때·새로고침 때 조회. 응답이 늦게 와 환승역이 바뀌었으면 버림
async function loadSubway(force) {
  const hb = hubInfo(), key = hubKey();
  if (!force && st.subwayKey === key && st.subway) return;
  const ok = ticket('subway', hubKey);
  try {
    const r = await api('/api/subway', { from: hb.stNum, to: hb.alight.stNum });
    if (!ok()) return;
    const c = cleanTimetable(r);
    if (c) { st.subway = c; st.subwayKey = key; } else { st.subway = null; st.subwayKey = null; }
  } catch (e) { if (ok()) { st.subway = null; st.subwayKey = null; console.warn('열차시각표:', e.message); } }
}
async function loadTashu() {
  if (!st.cfg.tashu && !st.cfg.mock) { st.tashu = null; return; }
  const gen = st.gen, k0 = tripKey();
  try {
    const r = await api('/api/tashu', { lat: c4(st.origin.lat), lng: c4(st.origin.lng) });
    if (gen !== st.gen || tripKey() !== k0) return;
    st.tashu = { ...r, stations: (r.stations || []).filter((t) => t && validPt(t) && nonNeg(t.bikes) && nonNeg(t.d)) };
    st.tashuAt = Date.now(); st.tashuErr = null;
  }
  catch (e) { if (gen === st.gen && tripKey() === k0) { st.tashu = null; st.tashuErr = e.message; } }
}
// 택시 시간·요금(카카오모빌리티 길찾기): 출발지·목적지·환승역이 바뀌었을 때와 새로고침을 눌렀을 때만 조회
//   카카오 결과는 재사용하지 않음(update11 팀 결정): 조회할 때마다 카카오 호출. 화면에 표시 중인 결과만 30초 갱신 동안 유지
async function loadDrives(force) {
  if (!st.cfg.drive) return;
  const ok = ticket('drive', hubKey);
  if (!supported()) { st.drive = {}; return; }        // 비교 구간 밖이면 조회하지 않음
  const pairs = { dest: [st.origin, st.dest], hub: [st.origin, hubInfo()] }, out = {};
  await Promise.all(Object.entries(pairs).map(async ([k, [o, d]]) => {
    try {
      const v = await api('/api/drive', { olat: c4(o.lat), olng: c4(o.lng), dlat: c4(d.lat), dlng: c4(d.lng) });
      if (!validDrive(v)) throw new Error('택시 길찾기 응답이 올바르지 않아요');
      out[k] = { ...v, taxiFare: nonNeg(v.taxiFare) && fnum(v.taxiFare) > 0 ? Number(v.taxiFare) : null, t: Date.now() };
    } catch { out[k] = null; }
  }));
  if (!ok()) return;                                  // 조회하는 동안 위치·환승역이 바뀌었으면 옛 결과로 덮지 않음
  st.drive = out;
}

/* ---------------- 카카오 대중교통·도보·자전거 길찾기 (update10) ---------------- */
// 카카오 공식 답변(devtalk 151980): 대중교통 경로 결과는 임시 캐싱도 허용하지 않음 → 재사용 캐시 없음.
//   도보·자전거(같은 카카오맵 경로 조회)도 같은 기준 적용. 새 조회는 항상 카카오를 호출하고,
//   화면에 표시 중인 결과(st.plan·st.legs)만 30초 자동 갱신 동안 그대로 둡니다. 새로고침·위치 변경 때 다시 조회.
const legQuery = (a, b) => ({ olat: c4(a.lat), olng: c4(a.lng), dlat: c4(b.lat), dlng: c4(b.lng) });
const CITY_TYPES = () => SC.fare.cityBusTypes || [];
// 카카오 대중교통 경로 중 기준 경로(A) 고르기:
//   카카오가 준 순서대로 보며, 지하철 구간이 1호선 역(역번호 표)으로 확인되는 경로 중 버스를 포함한 첫 경로 → 없으면 지하철 포함 첫 경로 → 없으면 첫 경로
// 카카오 요금: value가 있으면 그 값. value 없이 min·max만 오면(요금이 다른 버스가 섞인 경로) 공식 환승 규정으로 계산 (update11)
//   대전 환승 규정(대전광역시버스운송사업조합 sub0302, 2026-11-19 확인): 교통카드 · 최대 3회 환승 · 요금이 다르면 높은 요금과의 차액만 추가
//   · 같은 노선끼리는 환승 안 됨 → 합계 = 탄 수단 중 가장 높은 요금 (예: 시내버스 1,500 + 도시철도 → 1,550 / 시내버스 → 시내버스 1,500)
//   · 일반·마을버스만 대상(좌석 등은 요금 미확인). 지하철 포함이면 2구간 여부를 모르므로 카카오 min이 공식 합계(1,550/1,650)와 같을 때만 인정
//   · 환승 가능 시간(다음 노선 배차 15분 이하 30분, 16분 이상 60분)은 지킨다고 가정
function routeFare(r) {
  if (fnum(r.fare) > 0) return { fare: Number(r.fare), cityOnly: false };
  const buses = r.steps.filter((s) => s.type === 'BUS'), subs = r.steps.filter((s) => s.type === 'SUBWAY'), F = SC.fare, m = fnum(r.fareMin);
  const rides = r.steps.filter((s) => s.type !== 'WALKING');
  if (!buses.length || subs.length > 1 || rides.length - 1 > F.maxTransfers) return { fare: null, cityOnly: false };
  // 버스마다 탈 수 있는 일반·마을버스 노선의 요금 (노선마다 요금이 다르면 확정 불가)
  const busFares = buses.map((b) => [...new Set(b.vehicles.filter((v) => CITY_TYPES().includes(v.type)).map((v) => F.busByType[v.type]).filter((x) => x > 0))]);
  if (busFares.some((x) => x.length !== 1)) return { fare: null, cityOnly: false };
  // 같은 노선끼리 연달아 타는 경로는 환승 할인 없음 → 미확인
  const only = (b) => { const n = b.vehicles.filter((v) => CITY_TYPES().includes(v.type)).map((v) => v.name); return n.length === 1 ? n[0] : null; };
  for (let i = 1; i < rides.length; i++) if (rides[i].type === 'BUS' && rides[i - 1].type === 'BUS' && only(rides[i]) && only(rides[i]) === only(rides[i - 1])) return { fare: null, cityOnly: false };
  const busMax = Math.max(...busFares.map((x) => x[0]));
  if (!subs.length) return { fare: busMax, cityOnly: true, src: '공식 환승 규정' };
  if (m > 0 && (m === Math.max(busMax, F.busSubway.zone1) || m === Math.max(busMax, F.busSubway.zone2))) return { fare: m, cityOnly: true };
  return { fare: null, cityOnly: false };
}
function makePlan(routes) {
  const info = routes.map((r) => {
    const subs = r.steps.filter((s) => s.type === 'SUBWAY');
    if (subs.length !== 1 || !subs[0].stops.length) return { r, ok: false };
    const sb = subs[0], from = stationNum(sb.stops[0]), to = stationNum(sb.stops[sb.stops.length - 1]);
    return { r, sb, from, to, ok: !!(from && to && from !== to) };
  });
  // 카카오가 주는 순서는 소요시간 순이 아님(실제 응답 확인) → 후보 중 카카오 전체 소요(대기 포함 추정)가 가장 짧은 경로.
  //   카카오 전체 소요는 '경로 고르기'에만 쓰고, 화면의 시간 계산(구간 시간 + 실시간 대기)에는 쓰지 않음
  const quickest = (xs) => xs.slice().sort((a, b) => (fnum(a.r.totalSec) >= 0 ? a.r.totalSec : Infinity) - (fnum(b.r.totalSec) >= 0 ? b.r.totalSec : Infinity))[0];
  const withBus = info.filter((x) => x.ok && x.r.steps.some((s) => s.type === 'BUS')), withSub = info.filter((x) => x.ok);
  const pick = (withBus.length ? quickest(withBus) : withSub.length ? quickest(withSub) : null) || info[0];
  if (!pick) return null;
  const plan = { route: pick.r, hub: null, alight: null, dir: null, board: null, stop: null, stopWhy: null, subStep: null, fare: routeFare(pick.r), walk0Pt: null, walk0: null };
  if (pick.ok) {
    const at = validPt(pick.sb.start) ? pick.sb.start : null;
    plan.hub = { name: stationName(pick.sb.stops[0]), stNum: pick.from, lat: at ? at.lat : NaN, lng: at ? at.lng : NaN, posOk: !!at };
    plan.alight = { name: stationName(pick.sb.stops[pick.sb.stops.length - 1]), stNum: pick.to };
    plan.dir = Number(pick.to) < Number(pick.from) ? '0' : '1';      // 0=판암 방면(역번호 감소) · 1=반석 방면
    plan.subStep = pick.sb;
    if (!at) plan.hub = null;                                          // 환승역 좌표가 비정상이면 환승역으로 쓰지 않음
  }
  // 실시간 버스 대기는 '처음 타는 교통수단이 버스'일 때만 계산 (지하철 뒤 버스는 도착 시각이 미래라 실시간 목록과 맞지 않음)
  const first = pick.r.steps.find((s) => s.type !== 'WALKING');
  // 요금이 '일반·마을버스 기준'(min)으로 정해졌으면 그 버스들만 탈 노선으로 봄 (좌석버스 등은 요금이 달라 제외)
  const boardable = (s) => s.vehicles.filter((v) => !plan.fare.cityOnly || CITY_TYPES().includes(v.type)).map((v) => v.name).filter(Boolean);
  if (first && first.type === 'BUS') plan.board = { name: first.stops[0], pt: validPt(first.start) ? first.start : null, head: validPt(first.head) ? first.head : null, routeNos: boardable(first) };
  // 카카오 경로는 출발지 → 첫 정류장(역) 도보 구간을 주지 않을 때가 있음(실제 응답: 첫 단계가 바로 BUS) → 따로 도보 길찾기
  if (pick.r.steps[0].type !== 'WALKING' && validPt(pick.r.steps[0].start)) plan.walk0Pt = pick.r.steps[0].start;
  return plan;
}
// 진행 방향(a → head) 기준으로 p가 도로 오른쪽인지 왼쪽인지 (우측통행: 맞는 방향 정류장은 오른쪽). 2m 미만이면 판단하지 않음
function sideOf(a, head, p) {
  const kx = Math.cos(a.lat * Math.PI / 180) * 111320, ky = 110540;
  const hx = (head.lng - a.lng) * kx, hy = (head.lat - a.lat) * ky, vx = (p.lng - a.lng) * kx, vy = (p.lat - a.lat) * ky;
  const hl = Math.hypot(hx, hy);
  if (hl < 5) return null;
  const lateral = (hx * vy - hy * vx) / hl;          // + 왼쪽 · − 오른쪽 (m)
  return Math.abs(lateral) < 2 ? null : lateral < 0 ? 'right' : 'left';
}
// 방향 확인은 '노선 번호 + 정류장 ID' 조합으로만 판정 (다른 노선의 확인으로 승격하지 않음)
const verifiedFor = (routeNo, stopId) => ((SC.bus.verifiedStops || {})[norm(routeNo)] || []).includes(stopId);
// 실제로 탈 버스(노선)의 방향 상태: 'verified' 팀 확인 / 'geometry' 경로 진행 방향 오른쪽(추정) / 'unknown'
const dirOf = (stop, routeNo) => (!stop || !routeNo ? 'unknown' : verifiedFor(routeNo, stop.id) ? 'verified' : stop.side === 'right' ? 'geometry' : 'unknown');
// 카카오 탑승 정류장 → TAGO 정류장: 이름이 같고 경로 좌표에서 stopMatchM 안인 정류장만 후보
//   방향: scenario.js verifiedStops(팀 확인)에 있으면 'verified' / 경로 진행 방향 오른쪽이면 'geometry'(추정) / 그 외 'unknown'
function resolveStop(board, cands) {
  if (!board.pt) return null;
  const same = cands.filter((c) => c && c.id && !c.fixed && validPt(c) && norm(c.name) === norm(board.name))
    .map((c) => ({ ...c, m: dist(board.pt, c) })).filter((c) => c.m <= (TR.stopMatchM || 80)).sort((a, b) => a.m - b.m);
  if (!same.length) return null;
  // 정류장 고르기: 탈 수 있는 노선 중 하나라도 방향이 확인된 정류장 → 경로 진행 방향 오른쪽 → 가장 가까운 곳.
  //   '방향 확인됨' 여부는 여기서 정하지 않고, 실제로 탈 버스가 정해진 뒤 그 노선으로 판정 (dirOf)
  const withSide = same.map((c) => ({ ...c, side: board.head ? sideOf(board.pt, board.head, c) : null }));
  const v = withSide.find((c) => board.routeNos.some((n) => verifiedFor(n, c.id)));
  if (v) return { ...v, dir: 'verified', cands: same.length };   // dir = 정류장을 고른 근거(표시용). 신뢰도 판정은 dirOf(정류장, 실제 노선)
  const right = withSide.filter((c) => c.side === 'right');
  return right.length ? { ...right[0], dir: 'geometry', cands: same.length } : { ...withSide[0], dir: 'unknown', cands: same.length };
}
async function loadTransit() {
  const ok = ticket('transit');
  if (!st.cfg.route || !supported()) { st.plan = null; st.planAt = 0; st.extraStops = []; st.planWhy = !st.cfg.route ? '카카오 대중교통 길찾기를 쓸 수 없음(키 없음·예시 데이터)' : null; return; }
  let plan = null, why = null;
  try {
    const v = await api('/api/transit', legQuery(st.origin, st.dest));
    const routes = validRoutes(v.routes);
    if (!routes.length) throw new Error('길찾기 결과가 비어 있거나 올바르지 않아요');
    plan = makePlan(routes);
    if (!plan) why = '대중교통 경로 없음';
  } catch (e) { why = `대중교통 길찾기 실패 (${e.message})`; }
  if (!ok()) return;
  if (plan && plan.board) {
    let m = resolveStop(plan.board, st.stops);
    if (!m && plan.board.pt) {
      try {   // 출발지 600m 밖 정류장이면 탑승 정류장 좌표 근처를 한 번 더 조회 (TAGO 정류소 · 서버 1일 캐시)
        const r = await api('/api/stops', { lat: c4(plan.board.pt.lat), lng: c4(plan.board.pt.lng) });
        m = resolveStop(plan.board, r.stops || []);
      } catch { /* 아래에서 연결 실패로 처리 */ }
      if (!ok()) return;
    }
    if (m) plan.stop = { ...m, d: dist(st.origin, m) };
    else plan.stopWhy = plan.board.pt ? `탑승 정류장 '${plan.board.name}'을 TAGO 정류장과 연결하지 못함` : '탑승 정류장 좌표가 올바르지 않음';
  }
  if (plan && plan.walk0Pt) {
    try { const v = await api('/api/walk', legQuery(st.origin, plan.walk0Pt)); if (validLeg(v)) plan.walk0 = { sec: Number(v.sec), m: Number(v.m) }; } catch { /* 직선거리 도보로 대체 */ }
    if (!ok()) return;
  }
  st.plan = plan; st.planAt = plan ? Date.now() : 0; st.planWhy = why;
  st.extraStops = plan && plan.stop && !st.stops.some((s) => s.id === plan.stop.id) ? [plan.stop] : [];
}
// 타슈 대여소(공공 데이터): 환승역·목적지 근처 반납 대여소. 위치가 바뀌면 비우고, 새로고침 때 다시 조회
async function tashuNear(p, force) {
  const key = c4(p.lat) + ',' + c4(p.lng);
  if (!force && key in st.tashuNear) return st.tashuNear[key];
  const r = await api('/api/tashu', { lat: c4(p.lat), lng: c4(p.lng) });
  const s = (r.stations || []).find((t) => t && validPt(t) && nonNeg(t.d));
  return (st.tashuNear[key] = s || null);
}
const curTStart = () => (st.tashu && !st.tashu.mock ? st.tashu.stations.find((x) => x.bikes > 0) || null : null);
const tId = (t) => (t ? String(t.id || t.name) : null);
async function loadLegs(force) {
  if (!st.cfg.route || !supported()) { st.legs = {}; return; }
  const ok = ticket('legs', hubKey);
  const hb = hubInfo(), tStart = curTStart();
  let endHub = null, endDest = null;
  if (validPt(hb)) endHub = await tashuNear(hb, force).catch(() => null);
  endDest = await tashuNear(st.dest, force).catch(() => null);
  if (!ok()) return;
  const want = {};
  if (tStart) want.walkStart = ['walk', st.origin, tStart];
  if (endHub) { want.walkHub = ['walk', endHub, hb]; if (tStart) want.bikeHub = ['bike', tStart, endHub]; }
  if (endDest && tStart) want.bikeDest = ['bike', tStart, endDest];
  const prev = st.legs || {}, next = { endHub, endDest, tStartId: tId(tStart) };
  await Promise.all(Object.entries(want).map(async ([name, [kind, a, b]]) => {
    const q = legQuery(a, b), key = kind + ':' + Object.values(q).join(','), old = prev[name];
    // 30초 갱신: 화면에 표시 중인 같은 구간 결과는 그대로(재호출 없음). 실패한 구간은 5분 뒤에만 다시 시도
    if (!force && old && old.key === key && (old.v || Date.now() - old.t < LEG_RETRY_MS)) { next[name] = old; return; }
    try {
      const v = await api('/api/' + kind, q);
      if (!validLeg(v)) throw new Error('길찾기 응답이 올바르지 않아요');
      next[name] = { key, v: { sec: Number(v.sec), m: Number(v.m) }, t: Date.now() };
    } catch (e) { next[name] = { key, err: e.message, t: Date.now() }; }
  }));
  if (!ok()) return;
  st.legs = next;
}

/* ---------------- 경로 계산 ---------------- */
// 승강장 도착 시각(ms) → 탈 열차의 대기. 시각표는 '지금 환승역 쌍'의 것일 때만 사용 (다른 역 시각표 적용 방지)
function timetable() { const c = st.subway && st.subwayKey === hubKey() ? cleanTimetable(st.subway) : null; return c ? c.days : null; }
function dayOf(platformMs, t) { const wd = new Date(platformMs - (t >= 1440 ? 86400000 : 0)).getDay(); return wd === 0 || wd === 6 ? SC.subway.dayHoliday : SC.subway.dayWeekday; }
function subwayNext(platformMs, dir = SC.subway.dir) {
  const d = new Date(platformMs);
  let t = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  if (t < 240) t += 1440;                      // 자정 이후는 전날 시각표의 24시대
  const tb = t + (SC.bufferMin || 0);          // 승강장 도착 후 최소 여유 이후 열차만 탑승
  const tt = timetable();
  if (tt) {
    const day = dayOf(platformMs, t), set = tt[day] && tt[day][dir];
    if (set && set.from.length) {
      const dep = set.from.find((x) => x >= tb - 1e-9);
      if (dep == null) return { wait: 0, dep: null, table: true, ended: true, day };   // 막차 이후: 탈 열차 없음
      return { wait: dep - t, dep, table: true, day, holiday: day === SC.subway.dayHoliday };
    }
  }
  const [ah, am] = SC.subway.anchor.split(':').map(Number);
  const a = ah * 60 + am, hw = SC.subway.headwayMin;
  const next = a + Math.ceil((tb - a) / hw - 1e-9) * hw;
  return { wait: next - t, dep: next, table: false, day: dayOf(platformMs, t) };
}
// 지하철 승차시간: A·D·E가 같은 역 구간이면 같은 값. 우선순위: 시각표 역간 소요 → 확인된 구간 값(scenario.js rideConfirmed)
//   → 카카오 지하철 구간 시간(미확인) → 역 수 × 역당 분(추정·미확인). 월평→대전역 19분을 다른 구간에 쓰지 않음
function subwayRide(hb, day) {
  const tt = timetable(), set = tt && tt[day] && tt[day][hb.dir];
  if (set && fnum(set.ride) > 0) return { min: Number(set.ride), ok: true, note: '시각표 기준' };
  const pair = `${hb.stNum}-${hb.alight.stNum}`, conf = (SC.subway.rideConfirmed || {})[pair];
  if (fnum(conf) > 0) return { min: Number(conf), ok: true, note: '확인된 소요시간' };
  const p = st.plan;
  if (p && p.subStep && hb.fromPlan && fnum(p.subStep.sec) > 0) return { min: p.subStep.sec / 60, ok: false, note: '카카오 구간 시간', why: '열차 소요시간 시각표 없음 · 카카오 구간 시간' };
  const n = Math.abs(Number(hb.stNum) - Number(hb.alight.stNum));
  return { min: n * (SC.subway.minPerStation || 2), ok: false, note: `${n}개 역 × ${SC.subway.minPerStation || 2}분 추정`, why: '열차 소요시간 추정' };
}
// 버스 대기 (기존 원리 유지: 정류장까지 걸어가 최소 여유 1분 뒤에 오는 차만 탑승 가능)
//   · 탈 수 있는 실제 도착정보(뒤에 오는 차 포함)를 먼저 사용
//   · 목록의 차를 모두 놓치면 '목록의 마지막 차 + 배차 가정 간격 × k'에서 정류장 도착(+여유) 이후 첫 차를 가정
//     → 대기는 항상 여유(1분) 이상이고, 탑승 시각이 정류장 도착보다 앞서지 않음 (0으로 자르지 않음)
//   allow: 이 노선을 타도 되는 정류장인지 (명시적 정류장 제한 · fixed 정류장도 예외 없음)
function findBus({ routeNos, allow, walkOf }) {
  const nos = routeNos.map(norm), buf = SC.bufferMin || 0, hw = SC.bus.headwayMin;
  let live = null, assumed = null;
  for (const s of [...st.stops, ...st.extraStops]) {
    if (!allow(s)) continue;
    const a = st.arr[s.id]; if (!a || !a.list) continue;
    const walk = walkOf(s), need = walk + buf;
    const buses = a.list.filter((x) => nos.includes(norm(x.routeNo))).map((b) => ({ b, rem: remainSec(b, a.at) / 60 })).sort((x, y) => x.rem - y.rem);
    if (!buses.length) continue;
    const c = buses.find((x) => x.rem >= need);
    if (c) {
      const r = { stop: s, walk, wait: c.rem - walk, catchable: true, source: 'live', total: c.rem, prevCnt: c.b.prevCnt, routeNo: c.b.routeNo, later: c !== buses[0] };
      if (!live || r.total < live.total) live = r;
    } else {
      const last = buses[buses.length - 1].rem, k = Math.max(1, Math.ceil((need - last) / hw - 1e-9));
      const dep = last + k * hw;
      const r = { stop: s, walk, wait: dep - walk, catchable: false, source: 'assumed', total: dep, prevCnt: null, routeNo: buses[0].b.routeNo };
      if (!assumed || r.total < assumed.total) assumed = r;
    }
  }
  return live || assumed;
}
function build(key, name, sub, segs, fare, opts = {}) {
  let t = Date.now();
  const steps = segs.map((s) => { const start = t; t += s.min * 60000; return { ...s, start, end: t }; });
  return { key, name, sub, steps, fare, arrive: t, total: (t - Date.now()) / 60000, ...opts };
}
const secMin = (s) => Number(s) / 60;
const walkSeg = (s, label) => ({ type: 'walk', min: secMin(s.sec), label, note: `카카오 길찾기 · ${s.m}m` });
const busLabel = (s) => `${s.vehicles.map((v) => v.name).filter(Boolean).join('·') || '버스'}번 버스`;
const rideSeg = (s, names) => ({ type: 'ride', min: secMin(s.sec), label: names ? `${names.join('·') || '버스'}번 버스` : busLabel(s), note: `${s.stops[0] || ''} → ${s.stops[s.stops.length - 1] || ''}${s.stops.length > 1 ? ` · ${s.stops.length - 1}정거장` : ''} · 카카오 길찾기` });
// 처음 탄 교통수단 뒤에 오는 구간(지하철 하차 후 도보·버스 등): 도보는 카카오 구간 시간, 버스는 환승 대기 가정 + 승차, 그 밖은 지원하지 않음(미확인)
function laterSegs(steps, unk) {
  const out = [];
  steps.forEach((s, i) => {
    if (s.type === 'WALKING') out.push(walkSeg(s, i === steps.length - 1 ? `${st.dest.name}까지 도보` : '도보'));
    else if (s.type === 'BUS') {
      out.push({ type: 'wait', min: TR.transferWaitMin || 5, label: `${busLabel(s)} 환승 대기`, note: '실시간 미연결 · 가정값' }, rideSeg(s));
      unk.push('환승 버스 대기는 가정값');
    } else {
      out.push({ type: s.type === 'SUBWAY' ? 'sub' : 'ride', min: secMin(s.sec), label: s.guidance || s.type, note: '대기 미반영 · 카카오 구간 시간' });
      unk.push('지원하지 않는 복합 구간 포함');
    }
  });
  return out;
}
// 지하철 하차 후 최종 목적지까지 (A·D·E 공통): 카카오 경로의 지하철 다음 구간, 없으면 하차역(대전역 기준점) → 목적지 직선거리 추정
// 카카오 경로의 마지막 지점 → 실제 목적지 (경로가 도보로 끝나지 않을 때). 기존 도보 규칙(직선거리 × 1.25 ÷ 70m)
function finalWalk() {
  const p = st.plan, last = p && p.route.steps[p.route.steps.length - 1];
  if (!last || last.type === 'WALKING' || !validPt(last.end)) return [];
  const m = dist(last.end, st.dest);
  return m <= 30 ? [] : [{ type: 'walk', min: walkMin(m), label: `${st.dest.name}까지 도보`, note: `약 ${Math.round(m)}m (직선거리 × 1.25)` }];
}
function afterSubway(unk) {
  const p = st.plan;
  if (p && p.hub && p.subStep) {
    const steps = p.route.steps, i = steps.indexOf(p.subStep);
    return [...laterSegs(steps.slice(i + 1), unk), ...finalWalk()];
  }
  const m = dist(SC.dest, st.dest);
  if (m < 30) return [];
  unk.push('하차 후 목적지까지 직선거리 추정');
  return [{ type: 'walk', min: walkMin(m), label: `${st.dest.name}까지 도보`, note: `${hubInfo().alight.name}에서 약 ${Math.round(m)}m · 직선거리 추정` }];
}

/* ---------------- 요금 (공식 요금표 · scenario.js fare) ---------------- */
// 지하철 구간: 대전교통공사 이동구간제(여행개시역에서 10㎞ 이내 1구간·초과 2구간). 역간 거리는 공식 원본 미확보 →
//   ① scenario.js zoneConfirmed(팀 확인값) ② 카카오 경로 요금 대조(일반·마을버스 + 지하철 1회 경로의 요금이 공식 환승 합계와 일치) 로 확인될 때만 사용
function subwayZone(hb) {
  const pair = `${hb.stNum}-${hb.alight.stNum}`, conf = (SC.subway.zoneConfirmed || {})[pair];
  if (conf === 1 || conf === 2) return { zone: conf, src: '확인값' };
  const p = st.plan, F = SC.fare;
  if (p && p.hub && hb.fromPlan && p.fare && p.fare.fare > 0) {
    const steps = p.route.steps, buses = steps.filter((s) => s.type === 'BUS'), subs = steps.filter((s) => s.type === 'SUBWAY');
    const fare = p.fare.fare;
    if (subs.length === 1 && buses.length === 0) { if (fare === F.subway.zone1) return { zone: 1, src: '카카오 요금 대조' }; if (fare === F.subway.zone2) return { zone: 2, src: '카카오 요금 대조' }; }
    if (subs.length === 1 && buses.length >= 1 && buses.every((b) => b.vehicles.length) && (p.fare.cityOnly || buses.every((b) => b.vehicles.every((v) => CITY_TYPES().includes(v.type))))) {
      if (fare === F.busSubway.zone1) return { zone: 1, src: '카카오 요금 대조' };
      if (fare === F.busSubway.zone2) return { zone: 2, src: '카카오 요금 대조' };
    }
  }
  return null;
}
// 타슈: 1회 대여 1시간 무료, 초과 30분당 500원, 1일 1회 최대 5,000원 (타슈 이용약관 2024-12-20).
//   30분 미만 초과분의 계산 방식(올림 여부)은 공식 문구로 확인 못 함 → 초과 시 올림으로 계산하고 '요금 미확인'
function tashuFee(rentMin) {
  const f = SC.tashu.fee, over = rentMin - f.freeMin;
  if (over <= 1e-9) return { fare: 0, ok: true };
  const units = Math.ceil(over / f.unitMin - 1e-9);
  return { fare: Math.min(f.maxFare, units * f.unitFare), ok: false, why: `타슈 ${Math.round(rentMin)}분 이용 · 추가요금 계산 방식 미확인(30분 단위 올림 가정)` };
}

// 경로마다 '지금 이용할 수 있는지'를 함께 계산합니다.
//   avail 'ok'      = 운행·대여 가능 여부를 실시간 정보나 시각표로 확인함 → 추천 대상
//   avail 'unknown' = 조회 실패·가정값·추정값·미확인 정보(좌표·정류장 방향·요금 등)가 섞임 → 참고용으로만 표시, 추천하지 않음
//   avail 'no'      = 막차 종료·자전거 없음 → 이용 불가, 추천하지 않음
function computeRoutes() {
  const now = Date.now(), list = [];
  const mock = !!st.cfg.mock;
  const hb = hubInfo(), legacy = legacyOrigin(), legacyHub = !hb.fromPlan || sameHub(hb);   // 고정값(공대 3호관→월평역)을 쓸 수 있는 경우
  const common = [];
  if (st.origin.verified === false) common.push('출발지 좌표 미확인');
  if (st.plan && now - st.planAt > ROUTE_STALE_MS) common.push('경로 정보가 오래됨 · 새로고침 필요');
  const status = (no, unk) => { unk = [...unk, ...common]; if (mock) unk = [...unk, '예시 데이터']; return { avail: no.length ? 'no' : unk.length ? 'unknown' : 'ok', why: [...new Set(no.length ? no : unk)] }; };
  const hubUnk = !hb.fromPlan && !legacy ? ['환승역 미확인(기본 환승역 가정)'] : [];
  // 지하철 대기·승차 (A·D·E 공통 계산)
  const subwaySegs = (startMs, before, unk, no) => {
    const used = before.reduce((a, s) => a + s.min, 0);
    const n = subwayNext(startMs + used * 60000, hb.dir);
    if (n.ended) { no.push('지하철 운행 종료'); return [{ type: 'wait', min: 0, label: '지하철 운행 종료', note: '시각표상 오늘 탈 수 있는 열차가 없어요' }]; }
    if (!n.table) unk.push('열차 시각표 없음 · 간격 가정');
    const ride = subwayRide(hb, n.day);
    if (!ride.ok) unk.push(ride.why);
    const depClock = clock(startMs + (used + n.wait) * 60000);
    return [{ type: 'wait', min: n.wait, label: '열차 대기', note: n.table ? `${hb.name} ${depClock} 출발 · ${n.holiday ? '휴일' : '평일'} 시각표` : `${hb.name} 출발 ${depClock} 열차 (간격 ${SC.subway.headwayMin}분 가정)` },
      { type: 'sub', min: ride.min, label: '지하철 1호선', note: `${hb.name} → ${hb.alight.name} · ${ride.note}` }];
  };
  const zone = subwayZone(hb), F = SC.fare;
  const subFare = zone ? F.subway['zone' + zone.zone] : null;
  const fareUnk = (ok) => (ok ? [] : [`요금 미확인 (지하철 ${hb.name}→${hb.alight.name} 요금 구간 확인 필요)`]);

  // ---- A 버스 + 지하철 ----
  let bus = null;
  if (st.plan) {
    // A-1. 카카오 대중교통 길찾기 경로. 경로 구성·구간 시간은 카카오, 대기는 버스 실시간·열차 시각표 (카카오 전체 소요시간 미사용)
    const p = st.plan, steps = p.route.steps, segs = [], unk = [], no = [];
    let firstSeen = false;
    if (p.walk0Pt) {
      const m0 = dist(st.origin, p.walk0Pt), s0 = steps[0], to = s0.type === 'SUBWAY' ? stationName(s0.stops[0]) : s0.stops[0];
      segs.push(p.walk0 ? { type: 'walk', min: secMin(p.walk0.sec), label: `${to}까지 도보`, note: `카카오 도보 길찾기 · ${p.walk0.m}m` }
        : { type: 'walk', min: walkMin(m0), label: `${to}까지 도보`, note: `약 ${Math.round(m0)}m (직선거리 × 1.25)` });
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i], next = steps[i + 1];
      if (s.type === 'WALKING') segs.push(walkSeg(s, !next ? `${st.dest.name}까지 도보` : next.stops.length ? `${next.type === 'SUBWAY' ? stationName(next.stops[0]) : next.stops[0]}까지 도보` : '도보'));
      else if (s.type === 'BUS' && !firstSeen) {
        const walkBefore = segs.reduce((a, x) => a + x.min, 0);          // 출발지 → 정류장 도보 (지금까지 구간은 모두 도보)
        bus = p.stop ? findBus({ routeNos: p.board ? p.board.routeNos : [], allow: (x) => x.id === p.stop.id, walkOf: () => walkBefore }) : null;
        if (bus) segs.push({ type: 'wait', min: bus.wait, label: `${bus.routeNo}번 버스 대기`, live: bus.catchable,
          note: bus.catchable ? `실시간 · ${p.stop.name}${bus.later ? ' · 뒤차' : ''} · ${bus.prevCnt}정거장 전` : `목록의 차는 모두 놓침 → 그 뒤 차(${SC.bus.headwayMin}분 간격) 가정` });
        else segs.push({ type: 'wait', min: SC.bus.fallbackWaitMin, label: `${(p.board ? p.board.routeNos : []).join('·') || '버스'}번 버스 대기`, note: (p.stop ? '실시간 도착정보 없음' : '정류장 연결 안 됨') + ' · 가정값' });
        if (!p.stop) unk.push(p.stopWhy || '탑승 정류장 연결 실패');
        else {
          const d = dirOf(p.stop, bus && bus.routeNo);
          if (!bus) unk.push('버스 도착정보 없음(노선 미확인)');
          else if (d === 'geometry') unk.push(`${bus.routeNo}번 운행 방향 추정(경로 좌표) · 확인 필요`);
          else if (d !== 'verified') unk.push(`${bus.routeNo}번 운행 방향 미확인`);
          else if (!bus.catchable) unk.push('다음 버스 시각은 가정값');
        }
        segs.push(rideSeg(s, p.board ? p.board.routeNos : null));   // 승차 안내도 요금 기준과 같은 노선만 (좌석버스 등 제외)
      } else if (s.type === 'SUBWAY' && s === p.subStep && p.hub) {
        segs.push({ type: 'walk', min: TR.inStationMin || 0, label: '역내 이동·승강장까지', note: '가정값 (API 미제공)' });
        segs.push(...subwaySegs(now, segs, unk, no));
        segs.push(...laterSegs(steps.slice(i + 1), unk), ...finalWalk());   // 지하철 하차 후 구간: 앞선 이동·대기가 모두 반영된 시각부터 이어서 계산
        break;
      } else segs.push(...laterSegs([s], unk));            // 처음 탄 교통수단 뒤의 버스 등: 환승 대기 가정(미확인)
      if (s.type !== 'WALKING') firstSeen = true;
    }
    const names = (p.board ? p.board.routeNos : (steps.find((x) => x.type === 'BUS') || { vehicles: [] }).vehicles.map((v) => v.name)).join('·');
    const sub = [names && `${names}번`, p.hub && p.hub.name, p.hub && '지하철'].filter(Boolean).join(' → ') || '대중교통';
    if (!(p.hub && p.subStep)) segs.push(...finalWalk());
    const kf = p.fare.fare;     // 실제 경로 요금 = 카카오 안내 요금 (일반·마을버스 기준 최저 요금 포함)
    if (kf == null) unk.push('요금 미확인 (카카오 요금 없음)');
    list.push(build('A', '버스 + 지하철', sub, segs, kf, { base: true, live: !!(bus && bus.catchable), fareNote: kf != null ? (p.fare.src ? `${p.fare.src} · 일반·마을버스 기준` : p.fare.cityOnly ? '카카오 요금 · 일반·마을버스 기준' : '카카오 안내 요금') : null, ...status(no, unk) }));
  } else if (legacy) {
    // A-2. 대중교통 길찾기를 못 쓸 때: 공대 3호관의 기존 고정 경로(108번 → 월평역)
    const ids = SC.bus.stopIds || [], ars = (SC.bus.arsStops || []).map((x) => String(x.arsId));
    bus = findBus({ routeNos: [SC.bus.routeNo], allow: (s) => (s.fixed ? ars.includes(String(s.arsId)) : !ids.length || ids.includes(s.id)), walkOf: (s) => walkMin(s.d) });
    const unk = [], no = [];
    const aHead = bus ? [
      { type: 'walk', min: bus.walk, label: `${bus.stop.name}까지 도보`, note: `약 ${Math.round(bus.stop.d)}m` },
      { type: 'wait', min: bus.wait, label: `${SC.bus.routeNo}번 버스 대기`, live: bus.catchable, note: bus.catchable ? `실시간 · ${bus.later ? '뒤차 · ' : ''}${bus.prevCnt}정거장 전` : `목록의 차는 모두 놓침 → 그 뒤 차(${SC.bus.headwayMin}분 간격) 가정` },
    ] : [
      { type: 'walk', min: 4, label: '정류장까지 도보', note: '근처 정류장 정보 없음 · 가정값' },
      { type: 'wait', min: SC.bus.fallbackWaitMin, label: `${SC.bus.routeNo}번 버스 대기`, note: '실시간 도착정보 없음 · 가정값' },
    ];
    if (!bus) unk.push('버스 도착정보 없음'); else if (!bus.catchable) unk.push('다음 버스 시각은 가정값');
    aHead.push({ type: 'ride', min: SC.bus.rideMin, label: `${SC.bus.routeNo}번 버스`, note: `${SC.hub.name} 인근 하차` },
      { type: 'walk', min: SC.bus.walkToPlatformMin, label: '승강장까지 도보·역내 이동' });
    const segs = [...aHead];
    segs.push(...subwaySegs(now, segs, unk, no), ...afterSubway(unk));
    const fare = zone ? F.busSubway['zone' + zone.zone] : null;              // 시내버스 1회 + 도시철도 환승 (공식 환승운임표)
    unk.push(...fareUnk(!!zone));
    list.push(build('A', '버스 + 지하철', `${SC.bus.routeNo}번 → ${SC.hub.name} → 지하철`, segs, fare,
      { base: true, live: !!(bus && bus.catchable), fareNote: zone ? `시내버스+지하철 ${zone.zone}구간 환승 (${zone.src})` : null, ...status(no, unk) }));
  } else {
    // A-3. 다른 출발지에서 대중교통 길찾기를 못 쓸 때: 직선거리 추정 (노선 미확인)
    const Fb = TR.fallback || { walkMin: 5, busKmh: 15 }, unk = [st.planWhy || '대중교통 경로 미확인', '직선거리 추정'], no = [];
    const segs = [
      { type: 'walk', min: Fb.walkMin, label: '정류장까지 도보', note: '가정값' },
      { type: 'wait', min: SC.bus.fallbackWaitMin, label: '버스 대기', note: '가정값' },
      { type: 'ride', min: estMin(st.origin, hb, Fb.busKmh), label: '버스', note: `${hb.name}까지 직선거리 추정 · 노선 미확인` },
      { type: 'walk', min: TR.inStationMin || 3, label: '역내 이동·승강장까지', note: '가정값' },
    ];
    segs.push(...subwaySegs(now, segs, unk, no), ...afterSubway(unk));
    list.push(build('A', '버스 + 지하철', `→ ${hb.name} → 지하철 (추정)`, segs, null, { base: true, live: false, ...status(no, [...unk, ...hubUnk, '요금 미확인']) }));
  }

  // 택시(카카오모빌리티 길찾기) 결과 상태
  const driveUnk = (d) => (!d ? ['택시 시간·요금 조회 실패 · 고정값'] : now - d.t > DRIVE_STALE_MS ? ['택시 정보가 오래됨 · 새로고침 필요'] : d.taxiFare == null ? ['택시 요금 미확인'] : []);
  const driveNote = (d, extra) => (d ? `카카오 길찾기 · ${clock(d.t)} 조회${extra || ''}` : null);
  const taxiFare = (d, fixed) => (d ? d.taxiFare : fixed);

  // ---- B 택시 ----
  const dDest = st.drive.dest;
  list.push(build('B', '전 구간 택시', `${st.origin.name} → ${st.dest.name}`, [
    { type: 'wait', min: SC.taxi.waitMin, label: '택시 호출·대기', note: '가정값' },
    { type: 'ride', min: dDest ? dDest.durationSec / 60 : SC.taxi.toDestMin, label: '택시 주행', live: !!dDest, note: driveNote(dDest, dDest ? ` · ${(dDest.distanceM / 1000).toFixed(1)}km` : '') || '고정값' },
  ], taxiFare(dDest, SC.taxi.toDestFare), { live: !!dDest, ...status([], driveUnk(dDest)) }));

  // 타슈 상태: 'ok' 자전거 있는 대여소 확인 / 'none' 근처 대여소에 0대 / 'unknown' 조회 실패·키 없음·오래됨
  const T = SC.tashu;
  const tLive = st.tashu && !st.tashu.mock && now - st.tashuAt <= TASHU_STALE_MS;
  const tStart = tLive ? st.tashu.stations.find((x) => x.bikes > 0) : null;
  const tState = !tLive ? 'unknown' : tStart ? 'ok' : 'none';
  const tNo = tState === 'none' ? ['근처 대여소에 자전거 없음'] : [];
  const tUnk = tState === 'unknown' ? ['타슈 대여 가능 여부 미확인'] : [];
  // 도보·자전거 길찾기 결과: 지금 출발 대여소 기준이고 정상 응답일 때만 사용
  const LG = st.legs || {}, sameT = tStart && LG.tStartId === tId(tStart);
  const leg = (name) => { const x = LG[name]; return x && x.v && (name === 'walkHub' || sameT) ? x : null; };
  const legStale = (...xs) => (xs.some((x) => x && now - x.t > ROUTE_STALE_MS) ? ['길찾기 정보가 오래됨 · 새로고침 필요'] : []);
  const kk = ' · 카카오 길찾기';
  const wS = leg('walkStart'), bH = leg('bikeHub'), wH = leg('walkHub'), bD = leg('bikeDest');
  const tWalk = tStart
    ? { type: 'walk', min: wS ? secMin(wS.v.sec) : walkMin(tStart.d), label: `${tStart.name}까지 도보`, live: true, note: `자전거 ${tStart.bikes}대 · 실시간 · ${wS ? wS.v.m + 'm' + kk : tStart.d + 'm'}` }
    : { type: 'walk', min: T.walkMin, label: '타슈 대여소까지 도보', note: tState === 'none' ? '근처 대여소에 자전거 없음' : '대여소 정보 없음 · 가정값' };
  const bikeFrom = tStart || st.origin;

  // ---- D 타슈 + 지하철 ----
  const dUnk = [...tUnk, ...hubUnk, ...legStale(wS, bH, wH)], dNo = [...tNo];
  const toHub = bH ? { min: secMin(bH.v.sec), note: `${LG.endHub.name}까지 · ${bH.v.m}m${kk}` }
    : legacy && legacyHub ? { min: T.toHubMin, note: `${hb.name} 인근 대여소까지 · 고정값` }
    : (dUnk.push('타슈 주행 직선거리 추정'), { min: estMin(bikeFrom, LG.endHub || hb, T.estKmh || 13), note: `${hb.name} 인근까지 직선거리 추정` });
  const hubWalk = wH ? { min: secMin(wH.v.sec) + (TR.inStationMin || 0), note: `반납 후 ${hb.name}까지 ${wH.v.m}m${kk} + 역내 ${TR.inStationMin || 0}분(가정)` }
    : legacy && legacyHub ? { min: T.hubWalkMin, note: '고정값' }
    : { min: (LG.endHub ? walkMin(dist(LG.endHub, hb)) : T.hubWalkMin) + (TR.inStationMin || 0), note: '가정값' };
  const dHead = [
    tWalk, { type: 'dock', min: T.dockMin, label: '타슈 대여' },
    { type: 'ride', min: toHub.min, label: '타슈 주행', note: toHub.note }, { type: 'dock', min: T.dockMin, label: '타슈 반납' },
    { type: 'walk', min: hubWalk.min, label: '승강장까지 도보·역내 이동', note: hubWalk.note },
  ];
  const dSegs = [...dHead];
  dSegs.push(...subwaySegs(now, dSegs, dUnk, dNo), ...afterSubway(dUnk));
  const dFee = tashuFee(T.dockMin * 2 + toHub.min);
  if (!dFee.ok) dUnk.push(dFee.why);
  dUnk.push(...fareUnk(!!zone));
  list.push(build('D', '타슈 + 지하철', `타슈 → ${hb.name} → 지하철`, dSegs, subFare != null ? subFare + dFee.fare : null,
    { live: !!tStart, fareNote: zone ? `지하철 ${zone.zone}구간${dFee.fare ? ` + 타슈 추가 ${won(dFee.fare)}` : ''}` : null, ...status(dNo, dUnk) }));

  // ---- E 택시 + 지하철 ----
  const dHub = st.drive.hub, eUnk = [...driveUnk(dHub), ...hubUnk], eNo = [];
  let eRide;
  if (dHub) eRide = { min: dHub.durationSec / 60, note: driveNote(dHub) };
  else if (legacy && legacyHub) eRide = { min: SC.taxi.toHubMin, note: `${hb.name}까지 고정값` };
  else { eUnk.push('택시 직선거리 추정'); eRide = { min: estMin(st.origin, hb, SC.taxi.estKmh || 25), note: `${hb.name}까지 직선거리 추정` }; }
  const eSegs = [
    { type: 'wait', min: SC.taxi.waitMin, label: '택시 호출·대기', note: '가정값' },
    { type: 'ride', min: eRide.min, label: '택시 주행', live: !!dHub, note: eRide.note },
    { type: 'walk', min: SC.taxi.hubWalkMin, label: '승강장까지 도보·역내 이동' },
  ];
  eSegs.push(...subwaySegs(now, eSegs, eUnk, eNo), ...afterSubway(eUnk));
  const eTaxi = taxiFare(dHub, legacy && legacyHub ? SC.taxi.toHubFare : null);
  if (eTaxi == null && !dHub) eUnk.push('택시 요금 미확인');
  eUnk.push(...fareUnk(!!zone));
  list.push(build('E', '택시 + 지하철', `택시 → ${hb.name} → 지하철`, eSegs, eTaxi != null && subFare != null ? eTaxi + subFare : null,
    { live: !!dHub, ...status(eNo, eUnk) }));

  // ---- C 전 구간 타슈 ----
  const cUnk = [...tUnk, ...legStale(wS, bD)];
  const toDest = bD ? { min: secMin(bD.v.sec), note: `${LG.endDest.name}까지 · ${bD.v.m}m${kk}` }
    : legacy ? { min: T.toDestMin, note: `${st.dest.name} 인근 대여소까지 · 고정값` }
    : (cUnk.push('타슈 주행 직선거리 추정'), { min: estMin(bikeFrom, st.dest, T.estKmh || 13), note: `${st.dest.name} 인근까지 직선거리 추정` });
  const cFee = tashuFee(T.dockMin * 2 + toDest.min);
  if (!cFee.ok) cUnk.push(cFee.why);
  list.push(build('C', '전 구간 타슈', '1시간 내 반납 시 무료 · 초과 30분당 500원', [
    tWalk, { type: 'dock', min: T.dockMin, label: '타슈 대여' },
    { type: 'ride', min: toDest.min, label: '타슈 주행', note: toDest.note }, { type: 'dock', min: T.dockMin, label: '타슈 반납', note: '반납 후 도보는 미포함' },
  ], cFee.fare, { plus: true, ...status(tNo, cUnk) }));

  return { list, bus, hub: hb, zone, busDir: st.plan && st.plan.stop ? dirOf(st.plan.stop, bus && bus.routeNo) : null };
}
// 추천 (update10 정책): 기준 = 지금 A 경로(버스+지하철)의 실제 요금. 고정 예산(1,550원)은 쓰지 않음
//   · A 요금이 확인되지 않으면 추천 보류
//   · 이용 가능이 확인된 경로(avail 'ok')이고 요금이 확인됐으며, A 요금 이하(추가 비용 없음)이고 A보다 먼저 도착(시간 절감)하는 경로 중 가장 빠른 것
//   · 그런 경로가 없고 A 자체가 이용 가능으로 확인되면 A (기준 경로가 가장 빠름) · 전 구간 타슈(도착 '이상')는 제외
//   · 시간 비교는 화면 표시와 같은 분 단위(반올림)로 함
const minsVsA = (r, base) => Math.round((r.arrive - base.arrive) / 60000);
function pickBest(list) {
  const base = list.find((r) => r.base);
  if (!base || base.fare == null) return null;
  const ok = (r) => r.avail === 'ok' && r.fare != null && r.fare <= base.fare && !r.plus;
  const faster = list.filter((r) => !r.base && ok(r) && minsVsA(r, base) < 0).sort((a, b) => a.arrive - b.arrive)[0];
  return faster || (ok(base) ? base : null);
}

/* ---------------- 화면 ---------------- */
function segBar(r, maxMin) {
  const segs = h('div', { class: 'segs' });
  r.steps.forEach((s) => segs.append(h('i', { class: s.live ? 'live' : null, style: `flex:${Math.max(s.min, 0.2)} 1 0;background:var(--${s.type})`, title: `${SEG[s.type]} ${Math.round(s.min)}분` })));
  return h('div', { class: 'track', style: `width:${Math.min(100, (r.total / maxMin) * 100)}%` }, segs);
}
function routeCard(r, base, bestKey, maxMin) {
  const off = r.avail === 'no', unk = r.avail === 'unknown';
  const dmin = minsVsA(r, base), extra = r.fare != null && base.fare != null ? r.fare - base.fare : null;
  const fareTxt = (f) => (f == null ? '요금 미확인' : won(f));
  const pills = [];
  (r.why || []).forEach((w) => pills.push(h('span', { class: 'pill ' + (off ? 'bad' : 'warn') }, w)));
  if (!r.base && !off) {
    if (base.avail !== 'no') pills.push(h('span', { class: 'pill ' + (dmin < 0 ? 'good' : dmin > 0 ? 'bad' : '') }, dmin === 0 ? '버스+지하철과 같은 시각' : `버스+지하철보다 ${Math.abs(dmin)}분 ${dmin < 0 ? '일찍' : '늦게'}${r.plus && dmin > 0 ? ' 이상' : ''}`));
    if (extra != null) pills.push(h('span', { class: 'pill ' + (extra > 0 ? 'bad' : extra < 0 ? 'good' : '') }, extra === 0 ? '버스+지하철과 같은 요금' : `버스+지하철보다 ${extra > 0 ? '+' : ''}${won(extra)}`));
  }
  if (!off) {
    const waitSum = r.steps.filter((s) => s.type === 'wait').reduce((a, s) => a + s.min, 0);
    pills.push(h('span', { class: 'pill' }, `기다림 ${Math.round(waitSum)}분`));
  }

  const tl = h('ol', { class: 'tl' });
  r.steps.forEach((s) => tl.append(h('li', null, h('time', null, clock(s.start)),
    h('div', { class: 'rail' }, h('b', { style: `background:var(--${s.type})` }), h('s', { style: `background:var(--${s.type})` })),
    h('div', { class: 'w' }, h('b', null, s.label, s.live ? h('span', { class: 'live-mark' }, ' · 실시간') : null),
      h('span', null, `${Math.round(s.min)}분${s.note ? ' · ' + s.note : ''}`)))));
  tl.append(h('li', null, h('time', null, off ? '—' : clock(r.arrive)), h('div', { class: 'rail' }, h('b', { style: 'background:var(--ink)' })),
    h('div', { class: 'w' }, off ? h('b', null, '지금은 이용할 수 없어요') : h('b', null, `${st.dest.name} 도착`), h('span', null, off ? r.why.join(' · ') : `총 ${Math.round(r.total)}분 · ${fareTxt(r.fare)}${r.fareNote ? ' (' + r.fareNote + ')' : ''}`))));

  return h('article', { class: 'route' + (r.base ? ' base' : '') + (r.key === bestKey ? ' best' : '') + (off ? ' off' : '') },
    h('div', { class: 'rh' }, h('span', { class: 'letter' }, r.key), h('div', { class: 'rn' }, r.name, h('small', null, r.sub)),
      r.live && r.avail === 'ok' ? h('span', { class: 'tag live' }, '실시간') : null,
      off ? h('span', { class: 'tag off' }, '이용 불가') : null,
      unk ? h('span', { class: 'tag assume' }, '가정값 포함') : null,
      r.base ? h('span', { class: 'tag base' }, '기준') : null,
      r.key === bestKey ? h('span', { class: 'tag best' }, '추천') : null),
    h('div', { class: 'nums' }, h('span', { class: 'arr' }, off ? '—' : clock(r.arrive) + (r.plus ? '+' : ''), h('small', null, off ? '이용 불가' : unk ? '도착(참고)' : '도착')),
      h('span', { class: 'mins' }, off ? '' : `${Math.round(r.total)}분${r.plus ? '+' : ''}`), h('span', { class: 'fare' }, fareTxt(r.fare))),
    off ? null : segBar(r, maxMin),
    h('div', { class: 'pills' }, pills),
    h('details', { open: st.open.has(r.key), ontoggle: (e) => { if (e.target.open) st.open.add(r.key); else st.open.delete(r.key); } }, h('summary', null, '단계별 시각 보기'), tl));
}
function renderCompare(c) {
  if (!supported()) {
    const names = SC.origins.map((p) => p.name).join(' · ');
    c.append(h('div', { class: 'empty' }, h('b', null, `지금은 지원 출발지(${names}) ${R / 1000}km 안 → ${SC.dest.name} 구간만 비교할 수 있어요.`),
      h('p', { style: 'margin:6px 0 10px' }, '위의 출발지 버튼을 누르거나, 다른 위치는 "주변 정류장 실시간" 탭에서 버스 도착정보를 볼 수 있습니다. 대전 전역 경로 비교는 다음 단계에서 추가됩니다.'),
      h('button', { class: 'pm on', onclick: () => { st.dest = { ...SC.dest }; setPoint('origin', { ...SC.origin }); } }, '기본 구간으로 돌아가기')));
    return;
  }
  const { list, bus, hub, busDir } = computeRoutes();
  const p = st.plan;
  const DIR = { verified: '운행 방향 확인됨(scenario.js verifiedStops)', geometry: '운행 방향은 경로 좌표로 추정(도로 오른쪽) · 확인 필요', unknown: '운행 방향 미확인' };
  const busWho = bus ? `${bus.routeNo}번 ` : '';
  const busNote = p
    ? (p.board ? (p.stop ? `버스: 카카오 대중교통 길찾기의 탑승 정류장 '${p.board.name}'을 TAGO 정류장 ${p.stop.id}${p.stop.no ? '(번호 ' + p.stop.no + ')' : ''}와 이름·위치(${Math.round(p.stop.m)}m)로 연결했어요 · ${busWho}${DIR[busDir || 'unknown']}${p.stop.cands > 1 ? ` (같은 이름 정류장 ${p.stop.cands}곳)` : ''}.${bus ? '' : ' 지금은 해당 노선 도착정보가 없어 대기는 가정값입니다.'}`
      : `버스: ${p.stopWhy} → 버스 대기는 가정값입니다.`) : '처음 타는 교통수단이 버스가 아니라 실시간 버스 대기는 쓰지 않아요.')
    : bus ? `${SC.bus.routeNo}번 실시간 정보: ${bus.stop.name} (${bus.stop.fixed ? '번호 ' + bus.stop.arsId : bus.stop.id})${SC.bus.stopIds.length || bus.stop.fixed ? '' : ' · 방향 미지정 — scenario.js의 stopIds에 월평역 방면 정류장 ID를 넣으세요'}`
    : legacyOrigin() ? `근처 정류장에서 ${SC.bus.routeNo}번 도착정보를 찾지 못해 버스 대기는 가정값입니다.` : '버스 노선을 확인하지 못해 A는 추정값입니다.';
  const routeNote = p ? `경로 구성(노선·정류장·환승역 ${hub.name})과 구간 소요시간은 카카오 대중교통 길찾기, 대기는 버스 실시간·열차 시각표로 따로 계산해요(카카오 전체 소요시간은 쓰지 않음).${p.route.fare ? ` A 요금은 카카오 안내 요금 ${won(p.route.fare)}.` : ''}`
    : st.planWhy ? `${st.planWhy} → ${legacyOrigin() ? `기존 고정 경로(${SC.bus.routeNo}번 → ${SC.hub.name})` : `기본 환승역(${hub.name}) 기준 추정`}으로 계산했어요.` : '';
  const originNote = st.origin.verified === false ? `출발지 '${st.origin.name}' 좌표는 아직 확인 전이에요${st.origin.from ? ` (카카오 장소 검색 1순위: ${st.origin.from})` : ''}.` : '';
  const base = list.find((r) => r.base);
  const best = pickBest(list);
  const maxMin = Math.max(60, ...list.filter((r) => r.avail !== 'no').map((r) => r.total));
  const others = list.filter((r) => !r.base).sort((a, b) => (a.avail === 'no') - (b.avail === 'no') || a.arrive - b.arrive); // 이용 불가는 맨 아래
  const noBest = best ? null
    : base.fare == null ? '버스+지하철(A) 경로의 요금이 확인되지 않아 추천을 보류해요. 아래 경로는 비교용으로 볼 수 있어요.'
    : list.every((r) => r.avail === 'no') ? '지금은 이용할 수 있는 경로가 없어요. (지하철 운행 종료·타슈 자전거 없음)'
    : list.some((r) => r.avail === 'ok') ? `버스+지하철(A) 요금 ${won(base.fare)} 안에서 더 빨리 도착한다고 확인된 경로가 없어 추천을 표시하지 않아요. 아래에서 비교할 수 있어요.`
    : '실시간 정보로 이용 가능 여부를 확인하지 못해 추천을 표시하지 않아요. 아래 시각은 가정값이 섞인 참고용이에요.';
  c.append(
    h('p', { class: 'hint' }, `지금(${clock(Date.now())}) 출발 기준 · 추천은 지금 이용할 수 있다고 확인된 경로 중, 버스+지하철(A) 요금${base.fare != null ? ' ' + won(base.fare) : ''} 이하로 A보다 빨리 도착하는 경로 (없으면 A)`),
    noBest ? h('p', { class: 'banner' }, noBest) : null,
    h('div', { class: 'legend' }, ...['walk', 'wait', 'ride', 'dock', 'sub'].map((k) => h('span', null, h('i', { style: `background:var(--${k})` }), SEG[k]))),
    routeCard(base, base, best && best.key, maxMin),
    ...others.map((r) => routeCard(r, base, best && best.key, maxMin)),
    originNote ? h('p', { class: 'note' }, originNote) : null,
    routeNote ? h('p', { class: 'note' }, routeNote) : null,
    h('p', { class: 'note' }, busNote),
    h('p', { class: 'note' }, `${st.subway && st.subway.days ? '지하철은 대전교통공사 열차시각표(평일·휴일) 기준입니다. 공휴일은 평일 시각표로 계산돼요.' : `지하철 시각표를 불러오지 못해 ${SC.subway.anchor} 기준 ${SC.subway.headwayMin}분 간격으로 가정했습니다.`} ${Object.keys(st.legs || {}).some((k) => /^(walk|bike)/.test(k) && st.legs[k] && st.legs[k].v) ? '타슈 구간 도보·주행은 카카오 도보·자전거 길찾기(조회된 구간만), 역내 이동은 가정값입니다.' : '도보·타슈 주행·역내 이동은 실측 전 고정값입니다.'}${st.cfg.drive && st.drive.dest && st.drive.hub ? ' 택시 시간·요금은 출발지·목적지를 바꾸거나 새로고침(↻)을 누를 때 다시 조회해요.' : ' 택시는 고정값입니다.'}`));
}
function renderStops(c) {
  if (st.tashu && st.tashu.stations.length) {
    c.append(h('article', { class: 'stop' }, h('div', { class: 'sh' }, h('b', null, '근처 타슈 대여소'), h('span', null, st.tashu.mock ? '예시' : '실시간')),
      h('ul', { class: 'arrs' }, st.tashu.stations.slice(0, 4).map((t) => h('li', null,
        h('span', { class: 'rno' + (t.bikes > 0 ? ' hl' : '') }, `${t.bikes}대`),
        h('span', { class: 'when' }, h('b', null, t.name), h('small', null, `${t.d}m · 도보 ${walkMin(t.d)}분`)),
        h('span', { class: 'catch ' + (t.bikes > 0 ? 'ok' : 'no') }, t.bikes > 0 ? '대여 가능' : '자전거 없음'))))));
  } else if (st.tashuErr) c.append(h('p', { class: 'err' }, '타슈: ' + st.tashuErr));
  if (st.stopsErr) { c.append(h('div', { class: 'empty' }, h('b', null, '정류장 정보를 불러오지 못했어요'), h('p', { class: 'err' }, st.stopsErr))); return; }
  if (!st.stops.length) { c.append(h('div', { class: 'empty' }, st.loading ? '정류장을 찾는 중…' : '출발 위치 600m 안에 정류장이 없어요. 지도에서 출발 위치를 다시 찍어 보세요.')); return; }
  if (st.stopsNote) c.append(h('p', { class: 'banner' }, st.stopsNote));
  c.append(h('p', { class: 'hint' }, '출발 위치에서 걸어가는 시간과 버스 도착 시간을 비교해, 지금 출발하면 탈 수 있는지 보여 줍니다.'));
  const hlRoutes = (st.plan && st.plan.board ? st.plan.board.routeNos : st.plan ? [] : [SC.bus.routeNo]).map(norm);   // 경로 비교 A에서 타는 노선 강조
  for (const s of [...st.stops, ...st.extraStops]) {
    const a = st.arr[s.id], walk = walkMin(s.d);
    const rows = !a ? [h('li', null, h('span', { class: 'when' }, '불러오는 중…'))]
      : a.err ? [h('li', null, h('span', { class: 'err' }, a.err))]
      : !a.list.length ? [h('li', null, h('span', { class: 'when' }, '도착 예정 버스 없음'))]
      : a.list.slice(0, 6).map((b) => {
        const rem = remainSec(b, a.at), m = Math.floor(rem / 60), ok = catchOk(rem / 60, walk);
        return h('li', null, h('span', { class: 'rno' + (hlRoutes.includes(norm(b.routeNo)) ? ' hl' : '') }, b.routeNo),
          h('span', { class: 'when' }, h('b', null, rem < 60 ? '곧 도착' : `${m}분 후`), Number.isFinite(b.prevCnt) ? h('small', null, `${b.prevCnt}정거장 전`) : null),
          h('span', { class: 'catch ' + (ok ? 'ok' : 'no') }, ok ? '지금 가면 탑승' : '놓침'));
      });
    c.append(h('article', { class: 'stop' },
      h('div', { class: 'sh' }, h('b', null, s.name), h('span', null, `${Math.round(s.d)}m · 도보 ${walk}분`)),
      h('ul', { class: 'arrs' }, rows),
      h('p', { class: 'note' }, s.fixed ? `정류장 번호 ${s.arsId} · 대전시 도착정보` : `정류장 ID ${s.id}${s.no ? ' · 번호 ' + s.no : ''}`)));
  }
}
function render() {
  const c = $('#content'); c.replaceChildren();
  $('#tabCompare').classList.toggle('on', st.tab === 'compare'); $('#tabCompare').setAttribute('aria-selected', st.tab === 'compare');
  $('#tabStops').classList.toggle('on', st.tab === 'stops'); $('#tabStops').setAttribute('aria-selected', st.tab === 'stops');
  if (st.tab === 'compare') renderCompare(c); else renderStops(c);
  $('#updated').textContent = st.updated ? `버스 도착정보 ${clock(st.updated)} 기준 · 30초마다 자동 갱신` : '';
}

/* ---------------- 검색 (카카오 로컬 · 서버에서 REST 키 사용) ---------------- */
async function search(q) {
  const box = $('#results'); box.hidden = false;
  if (!st.cfg.search) { box.replaceChildren(h('li', { class: 'hint', style: 'padding:8px 10px' }, '장소 검색은 .env에 KAKAO_REST_KEY를 넣으면 사용할 수 있어요. 지금은 지도를 눌러 위치를 지정하세요.')); return; }
  box.replaceChildren(h('li', { class: 'hint', style: 'padding:8px 10px' }, '검색 중…'));
  let places;
  try {
    places = (await api('/api/search', { q })).places;               // 재사용 없음(update11): 검색할 때마다 조회
  }
  catch (e) { box.replaceChildren(h('li', { class: 'err', style: 'padding:8px 10px' }, e.message)); return; }
  if (!places.length) { box.replaceChildren(h('li', { class: 'hint', style: 'padding:8px 10px' }, '검색 결과가 없어요.')); return; }
  box.replaceChildren(...places.slice(0, 8).map((p) => {
    const done = (w) => { box.hidden = true; $('#q').value = ''; setPoint(w, { name: p.name, lat: p.lat, lng: p.lng }); };
    return h('li', null, h('button', { type: 'button', onclick: () => done(st.pick) }, p.name, h('small', null, p.address)),
      h('div', { class: 'acts' }, h('button', { type: 'button', onclick: () => done('origin') }, '출발로'), h('button', { type: 'button', onclick: () => done('dest') }, '도착으로')));
  }));
}

/* ---------------- 시작 ---------------- */
async function start() {
  $('#oName').textContent = st.origin.name; $('#dName').textContent = st.dest.name;
  renderPresets();
  $('#pickOrigin').onclick = () => setPick('origin');
  $('#pickDest').onclick = () => setPick('dest');
  $('#tabCompare').onclick = () => { st.tab = 'compare'; render(); };
  $('#tabStops').onclick = () => { st.tab = 'stops'; render(); };
  $('#refresh').onclick = () => loadStops(true);   // 새로고침: 택시 정보도 다시 조회
  $('#swap').onclick = () => { const o = st.origin; st.origin = st.dest; st.dest = o; setPoint('origin', st.origin); };
  $('#searchForm').onsubmit = (e) => { e.preventDefault(); const q = $('#q').value.trim(); if (q) search(q); };
  $('#myLoc').onclick = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => setPoint('origin', { name: '내 위치', lat: p.coords.latitude, lng: p.coords.longitude }),
      () => { const b = $('#banner'); b.hidden = false; b.textContent = '위치 권한이 없어 현재 위치를 가져오지 못했어요.'; }, { enableHighAccuracy: true, timeout: 8000 });
  };

  if (['localhost', '127.0.0.1'].includes(location.hostname)) $('#healthLink').hidden = false; // 점검 링크는 내 PC에서만
  try { st.cfg = await api('/api/config'); } catch { /* 기본값 유지 */ }
  if (st.cfg.mock) { const b = $('#banner'); b.hidden = false; b.textContent = '예시 데이터로 실행 중이에요. .env에 공공데이터 키(DATA_GO_KR_KEY)를 넣으면 실제 버스 도착정보가 나옵니다.'; }

  initMap();
  loadSubway().then(render);
  await loadStops();
  setInterval(() => { if (document.visibilityState === 'visible') loadArrivals(); }, REFRESH_MS);
  setInterval(() => { if (document.visibilityState === 'visible') render(); }, 10000);
}
start();
})();
