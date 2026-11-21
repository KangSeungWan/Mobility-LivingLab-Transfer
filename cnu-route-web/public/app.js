(function () {
'use strict';
const SC = window.SCENARIO;
const SEG = { walk: '도보', wait: '대기', ride: '버스·택시·타슈', dock: '타슈 대여·반납', sub: '지하철' };
const REFRESH_MS = 30000;
const DRIVE_STALE_MS = 15 * 60000; // 이보다 오래된 택시 결과는 '확인됨'으로 보지 않음
const TASHU_STALE_MS = 3 * 60000;
const ROUTE_STALE_MS = 15 * 60000; // 화면에 표시 중인 카카오 대중교통·도보·자전거 결과가 이보다 오래되면 '확인됨'으로 보지 않음
const LEG_RETRY_MS = 5 * 60000;    // 실패한 도보·자전거 구간은 30초 갱신 때 바로 다시 부르지 않음 (새로고침·위치 변경 때는 다시 조회)
const RS = SC.search || {};        // 경로 탐색 범위·상한 (scenario.js search · update12)
const DEST_ST = SC.subway.destStNum;   // 목적지 지하철역 (대전역 104) — 복합경로는 여기까지 지하철

// update12: A~E 고정 유형 없음. 화면 경로 = 일반 대중교통(카카오 후보를 실시간으로 다시 계산, 최대 5) + 전 구간 택시 + 전 구간 타슈
//   + 복합경로(환승역 후보마다 타슈·택시 연계를 계산해 유형별 대표 1개). 비교 기준 = 실시간·요금이 확인된 가장 빠른 일반 대중교통 경로
const st = {
  origin: { ...SC.origin }, originKey: SC.origin.key || null, dest: { ...SC.dest }, pick: 'origin', tab: 'compare',
  plans: [], plansAt: 0, planWhy: null, routeCount: 0,   // 카카오 대중교통 후보(실시간 평가 대상) · 받은 경로 수
  hubSearch: [], hubsWhy: null,                          // 근처 지하철역 검색 결과(환승역 후보)
  extraStops: [], legs: {}, tashuNear: {}, tt: {}, ttSeq: {}, ttWhy: {}, dist: {}, distSeq: {}, presetPos: {},   // dist: 역 구간별 대전교통공사 공식 역간 거리(공공 데이터, 이 세션 동안 사용)   // ttWhy: 구간별 시각표 조회 실패('fail')·응답 불완전('bad')   // tt: 역 구간(승차-하차)별 열차시각표 · ttSeq: 구간별 최신 요청 번호
  seq: {}, tripVer: 0, allow: (SC.allowances || [0])[0],             // 요청 순번·위치 버전(늦은 응답 폐기) · 추가 비용 허용 범위
  allowCustom: false, allowInput: '', allowErr: null,                  // 추가 비용 직접 입력 (update12)
  routeInfo: {},                                                       // 버스 노선·경유 정류장(TAGO, 공공 데이터) — 노선 번호별, 이 세션 동안 사용
  stops: [], stopsErr: null, arr: {}, drive: {}, cfg: { mock: true, drive: false }, loading: false, updated: null,
  map: null, overlays: {}, stopOverlays: [], open: new Set(),
  mapSel: null, routeOverlays: [], mapSig: null, mapFitKey: null,   // 지도 경로 표시 (update14): 사용자가 고른 경로 id · 그려진 선 · 같은 모양이면 다시 안 그림 · 같은 경로면 다시 맞추지 않음
  gen: 0, arrBusy: 0, tashuAt: 0,
};
const $ = (s) => document.querySelector(s);
const c4 = (v) => Number(v).toFixed(4); // 서버로 보내는 좌표는 소수 4자리(약 11m)까지만
const won = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Math.round(Number(n)).toLocaleString('ko-KR') + '원' : '요금 미확인');   // null·NaN을 그대로 보이지 않게
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '--:--'; };
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
// 버스 정거장 수(prevCnt): 0 이상 정수일 때만 표시 (null·누락·NaN이면 생략 — 'null정거장 전' 방지 · update12 감사)
const prevOk = (n) => n !== null && n !== undefined && n !== '' && Number.isInteger(Number(n)) && Number(n) >= 0;
const prevTxt = (n) => (prevOk(n) ? ` · ${Number(n)}정거장 전` : '');
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
const stName = (no) => { const e = Object.entries(SC.subway.stations || {}).find(([, v]) => v === no); return e ? stationName(e[0]) : `${no}번 역`; };
// 카카오 '지하철역' 장소 이름 → 1호선 역: '…역'으로 끝나는 낱말이 역 이름표와 정확히 같을 때만 (예: '월평역 대전1호선' → 114)
//   '대전'처럼 역 이름이 아닌 지역명은 대전역으로 잘못 보지 않음
function stationFromPlace(name) {
  for (const raw of String(name || '').split(/\s+/)) {
    const t = raw.replace(/\(.*?\)/g, '');
    if (!/역$/.test(t)) continue;
    const k = Object.keys(SC.subway.stations || {}).find((x) => x === t || stNorm(x) + '역' === t);
    if (k) return { name: stationName(k), stNum: SC.subway.stations[k] };
  }
  return null;
}
const pairOf = (from, to) => `${from}-${to}`;
const subDir = (from, to) => (Number(to) < Number(from) ? '0' : '1');   // 0=판암 방면(역번호 감소) · 1=반석 방면
// 출발지 기준점(좌표가 있는 것만): scenario.js 좌표 또는 이번 세션에서 장소 검색으로 찾은 좌표
const presetPos = (p) => (p.lat != null && p.lng != null ? p : st.presetPos[p.key] || null);
function supported() {
  if (dist(st.dest, SC.dest) > R) return false;
  return SC.origins.some((p) => { const q = presetPos(p); return q && dist(st.origin, q) <= R; });
}
// 기존 고정 경로(108번·월평역)를 쓸 수 있는 출발지: 공대 3호관을 골랐거나, 직접 찍은 위치가 그 1km 안
const legacyOrigin = () => st.originKey === SC.origins[0].key || (!st.originKey && dist(st.origin, SC.origins[0]) <= R);
// 지금 위치(출발·목적지)와 위치 버전. 응답을 적용하기 전에 요청할 때의 값과 같은지 확인
const tripKey = () => [c4(st.origin.lat), c4(st.origin.lng), c4(st.dest.lat), c4(st.dest.lng), st.tripVer].join(',');
// 요청 티켓: 같은 종류의 더 새 요청이 있거나 위치가 바뀌었으면 false → 그 응답은 버림
function ticket(name, keyFn) {
  const n = (st.seq[name] = (st.seq[name] || 0) + 1), k = tripKey() + '|' + (keyFn ? keyFn() : '');
  return () => st.seq[name] === n && tripKey() + '|' + (keyFn ? keyFn() : '') === k;
}
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
  // 경로 선 (update14): 카카오맵 Polyline
  polyline(pts, o) {
    const k = window.kakao.maps;
    const l = new k.Polyline({ path: pts.map((p) => new k.LatLng(p.lat, p.lng)), strokeWeight: o.weight, strokeColor: o.color, strokeOpacity: o.opacity, strokeStyle: o.dash ? 'shortdash' : 'solid', zIndex: o.z || 0 });
    l.setMap(this.map); return { remove: () => l.setMap(null) };
  },
  kakao: true,
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
  // 경로 선은 그리지 않음 (update14): 카카오 길찾기 결과를 다른 지도(OpenStreetMap) 위에 표시하는 것은 약관 확인 전이라 카카오맵에서만
  polyline() { return { remove() {} }; },
  kakao: false,
};
let MAP = null;
async function initMap() {
  const onClick = (lat, lng) => setPoint(st.pick, { name: '지도에서 선택한 위치', lat, lng }, true);
  const tries = st.cfg.kakaoJsKey ? [[kakaoAdapter, st.cfg.kakaoJsKey], [leafletAdapter]] : [[leafletAdapter]];
  for (const [ad, key] of tries) {
    try { await ad.load(key); ad.init($('#map'), st.origin, onClick); MAP = ad; drawPoints(true); if (st.tab === 'compare') render(); return; } catch { /* 다음 지도로 */ }
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
//   근처 지하철역(환승역 후보)은 출발지에만 달려 있어 목적지만 바뀌면 그대로 둠 (카카오 호출 절약)
function invalidate(which) {
  st.mapSel = null;
  st.plans = []; st.plansAt = 0; st.planWhy = null; st.routeCount = 0; st.extraStops = []; st.legs = {}; st.tashuNear = {}; st.drive = {};
  if (which === 'origin') { st.stops = []; st.arr = {}; st.tashu = null; st.tashuAt = 0; st.hubSearch = []; st.hubsWhy = null; }
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
// 지도 표시용 경로 좌표 (update14): 서버가 준 [[위도,경도], …](또는 이미 정리한 {lat,lng} 목록)에서 정상 좌표만 {lat,lng}로. 2점 미만이면 null (그리기만 생략)
function cleanPath(path) {
  if (!Array.isArray(path)) return null;
  const a = [];
  for (const q of path) {
    const p = Array.isArray(q) && q.length >= 2 ? { lat: fnum(q[0]), lng: fnum(q[1]) } : q && typeof q === 'object' && !Array.isArray(q) ? { lat: fnum(q.lat), lng: fnum(q.lng) } : null;
    if (p && validPt(p)) a.push(p);
  }
  return a.length >= 2 ? a : null;
}
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
// 불러오는 순서: 근처 정류장 → (대중교통 후보 · 근처 지하철역) → (도착정보·타슈·도보/자전거 · 택시 · 열차시각표)
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
    await Promise.all([loadTransit(), loadHubs()]);      // 대중교통 후보(매번 새로 조회) · 근처 지하철역(환승역 후보)
    if (gen !== st.gen) return;
    await Promise.all([loadArrivals(true, refresh), loadDrives(refresh), loadTimetables(refresh), loadDist(neededPairs())]);
  } finally { if (gen === st.gen) { st.loading = false; render(); } }
}
// 목적지만 바뀌었을 때: 대중교통 후보·택시·도보/자전거·시각표를 새 목적지로 다시 (근처 지하철역은 출발지 기준이라 그대로)
async function loadDest() {
  await loadTransit();
  await Promise.all([loadArrivals(true), loadDrives(), loadTimetables(), loadDist(neededPairs())]);
}
// 30초마다 부르는 갱신: 버스 도착정보와 타슈만. 카카오 길찾기(택시·대중교통·도보·자전거·지하철역 검색)는 화면의 결과를 그대로 쓰고 다시 부르지 않음
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
// 열차시각표: 역 구간(승차역-하차역)마다 따로 보관 → 다른 역 구간의 시각표가 섞이지 않음. 없는 구간·새로고침 때만 조회
//   (시각표 원천은 서버가 12시간 캐시 — 구간이 여러 개여도 외부 호출은 12시간에 1번)
function neededPairs() {
  const s = new Set();
  for (const p of st.plans) if (p.pair) s.add(p.pair);
  for (const hb of hubCands()) s.add(hb.pair);
  return [...s];
}
//   같은 역 구간을 여러 번 요청하면 마지막 요청의 결과만 저장·삭제 (늦게 온 이전 요청이 최신 시각표를 덮거나 지우지 않음 · update12 감사)
async function loadTimetables(force) {
  const pairs = neededPairs().filter((k) => force || !st.tt[k]);
  await Promise.all(pairs.map(async (k) => {
    const [from, to] = k.split('-'), my = (st.ttSeq[k] = (st.ttSeq[k] || 0) + 1);
    try {
      const c = cleanTimetable(await api('/api/subway', { from, to }));
      if (st.ttSeq[k] !== my) return;
      if (c) { st.tt[k] = c; delete st.ttWhy[k]; } else { delete st.tt[k]; st.ttWhy[k] = 'bad'; }
    } catch (e) { if (st.ttSeq[k] !== my) return; delete st.tt[k]; st.ttWhy[k] = 'fail'; console.warn('열차시각표:', e.message); }
  }));
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
// 택시 시간·요금(카카오모빌리티 길찾기): 목적지 1구간 + 택시 연계 환승역 후보(추정 상위 hubLegsTaxi곳). 위치 변경·새로고침 때만 조회
//   카카오 결과는 재사용하지 않음(update11): 조회할 때마다 호출. 화면에 표시 중인 결과만 30초 갱신 동안 유지
async function loadDrives(force) {
  if (!st.cfg.drive) return;
  const ok = ticket('drive');
  if (!supported()) { st.drive = {}; return; }        // 비교 구간 밖이면 조회하지 않음
  const jobs = [['dest', st.dest], ...pickHubs('taxi', RS.hubLegsTaxi || 2).map((hb) => [hb.stNum, hb])], out = { dest: null, hub: {} };
  await Promise.all(jobs.map(async ([k, d]) => {
    let v = null;
    try {
      const r = await api('/api/drive', legQuery(st.origin, d));
      if (!validDrive(r)) throw new Error('택시 길찾기 응답이 올바르지 않아요');
      v = { ...r, taxiFare: nonNeg(r.taxiFare) && fnum(r.taxiFare) > 0 ? Number(r.taxiFare) : null, path: cleanPath(r.path), t: Date.now() };
    } catch { v = null; }
    if (k === 'dest') out.dest = v; else out.hub[k] = v;
  }));
  if (!ok()) return;                                  // 조회하는 동안 위치가 바뀌었으면 옛 결과로 덮지 않음
  st.drive = out;
}

/* ---------------- 일반 대중교통 후보 (카카오 대중교통 길찾기 · update12) ---------------- */
// 카카오 공식 답변(devtalk 151980): 경로 결과는 임시 캐싱도 허용하지 않음 → 재사용 캐시 없음.
//   도보·자전거·장소 검색도 같은 기준. 새 조회는 항상 카카오를 호출하고, 화면에 표시 중인 결과만 30초 자동 갱신 동안 그대로 둠
const legQuery = (a, b) => ({ olat: c4(a.lat), olng: c4(a.lng), dlat: c4(b.lat), dlng: c4(b.lng) });
const CITY_TYPES = () => SC.fare.cityBusTypes || [];
// 지하철 요금 구간 (update12): ① 대전교통공사 공식 역간 거리(/api/stdist)로 판정 — 10㎞ 이하 1구간·초과 2구간(scenario.js fare.subway.zoneKm)
//   ② 거리가 없으면 scenario.js zoneConfirmed(확인값) ③ 둘 다 없으면 null(요금 계산 쪽에서 카카오 대조).
//   공식 거리 구간과 확인값이 다르면 확정하지 않음(null + 이유). API의 운임(fee)은 금액으로 쓰지 않음 —
//   2026-11-20 실제 응답의 fee(1,400·1,500)는 현행 교통카드 운임(1,550·1,650)보다 150원 낮은 과거 금액이라 거리만 사용하고, 금액은 현행 운임표로 계산
function zoneOf(pair) {
  const d = st.dist[pair], conf = (SC.subway.zoneConfirmed || {})[pair], km = d && !d.err ? d.km : null;
  const api = km != null ? (km <= (SC.fare.subway.zoneKm || 10) ? 1 : 2) : null;
  if (api && (conf === 1 || conf === 2) && conf !== api) return { zone: null, why: `공식 역간 거리 ${km}㎞(${api}구간)와 확인값(${conf}구간)이 달라 확인 필요` };
  if (api) return { zone: api, src: `공식 역간 거리 ${km}㎞`, km };
  if (conf === 1 || conf === 2) return { zone: conf, src: '확인값' };
  return null;
}
// 공식 역간 거리 불러오기: 서로 다른 역 구간만, 성공한 구간은 이 세션 동안 재사용(공공 데이터 · 서버도 1일 캐시), 실패·이상 값은 다음 조회 때 다시
//   응답 항목(2026-11-20 실제): distfloat(㎞) · min·sec(소요) · fee(과거 운임 — 금액으로 안 씀). 거리는 0 초과 40㎞ 이하만 인정(1호선 전체 약 22.6㎞)
// 역간 거리 항목 검사 (update12 · 서버·화면 같은 기준): distfloat는 일반 10진수(정수 또는 소수, 부호·지수·16진수·NaN·Infinity·빈 값 불가) · 0 초과 40㎞ 이하(1호선 전체 약 22.6㎞)
//   min·sec는 0 이상 정수, sec는 0~59. 응답에 요청변수와 같은 이름의 역번호(strstnno·endstnno)가 있으면 요청 역과 같아야 함 — 없으면(실제 응답) 검사하지 않음.
//   역번호 항목 이름은 공식 응답 명세에 없어 요청변수 이름이 응답에 그대로 올 때만 대조(다른 이름을 표준으로 단정하지 않음)
const DIST_RE = /^\d+(\.\d+)?$/, INT_RE = /^\d+$/;
function checkDistItem(it, from, to) {
  if (!it || typeof it !== 'object') return { why: '항목 없음' };
  const d = it.distfloat, m = it.min, s = it.sec;
  if (typeof d !== 'string' || !DIST_RE.test(d)) return { why: `거리(distfloat) 형식 오류: ${JSON.stringify(d)}` };
  const km = Number(d);
  if (!(km > 0 && km <= 40)) return { why: `거리(distfloat) 범위 오류: ${d}` };
  // min·sec: 0 이상 10진 정수 문자열이고 변환값이 안전한 정수(309자리처럼 Infinity가 되는 값 불가) · sec 0~59 · min 60 이하
  //   (1호선 전 구간: 시각표상 반석 122→대전역 104가 34분, 대전역→판암 101까지 더해도 40분 안쪽 — 여유를 둔 상한)
  const mi = typeof m === 'string' && INT_RE.test(m) ? Number(m) : NaN, se = typeof s === 'string' && INT_RE.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(mi) || !Number.isSafeInteger(se) || se > 59 || mi > 60) return { why: `소요시간(min·sec) 오류: ${String(JSON.stringify(m)).slice(0, 20)}·${String(JSON.stringify(s)).slice(0, 20)}` };
  if (it.strstnno !== undefined && String(it.strstnno).trim() !== String(from)) return { why: `응답 출발역(${it.strstnno})이 요청(${from})과 다름` };
  if (it.endstnno !== undefined && String(it.endstnno).trim() !== String(to)) return { why: `응답 도착역(${it.endstnno})이 요청(${to})과 다름` };
  return { km, min: mi, sec: se };
}
async function loadDist(pairs) {
  //   같은 로딩(st.gen) 안에서 실패한 구간은 다시 부르지 않음(경로 계산 전·후 두 단계에서 중복 호출 방지) — 다음 로딩 때 재시도
  const want = [...new Set(pairs)].filter((k) => k && (!st.dist[k] || (st.dist[k].err && st.dist[k].gen !== st.gen)));
  await Promise.all(want.map(async (k) => {
    const [from, to] = k.split('-'), my = (st.distSeq[k] = (st.distSeq[k] || 0) + 1);
    let v;
    try {
      // 서버가 정상(complete:true)으로 판정하고 item이 정확히 1개이며, 화면에서도 같은 규칙(checkDistItem)을 통과할 때만 사용
      const r = await api('/api/stdist', { from, to }), it = r && !r.mock && r.complete === true && Array.isArray(r.items) && r.items.length === 1 ? r.items[0] : null;
      const c = it ? checkDistItem(it, from, to) : { why: r && r.why ? r.why : '역간 거리 응답이 올바르지 않음' };
      v = c.why ? { err: c.why } : { km: c.km, min: c.min, sec: c.sec, fee: fnum(it.fee), at: fnum(r.at) || Date.now() };
    } catch (e) { v = { err: e.message }; }
    if (v.err) v.gen = st.gen;
    if (st.distSeq[k] === my) st.dist[k] = v;
  }));
}
// 카카오 경로들의 지하철 구간(승차역-하차역) 목록
const routePairs = (routes) => routes.map((r) => { const sb = r.steps.filter((s) => s.type === 'SUBWAY'); if (sb.length !== 1) return null; const a = stationNum(sb[0].stops[0]), b = stationNum(sb[0].stops[sb[0].stops.length - 1]); return a && b && a !== b ? pairOf(a, b) : null; }).filter(Boolean);
// 대중교통 요금 (update12 최종: 공식 요금표·환승 규정으로 먼저 계산하고, 카카오 요금은 대조·보조로만 사용)
//   대전 환승 규정(대전광역시버스운송사업조합 sub0302, 2026-11-19 확인): 교통카드 · 최대 3회 환승 · 요금이 다르면 높은 요금과의 차액만 추가
//   → 합계 = 탄 수단 중 가장 높은 요금. 시내·마을버스 + 도시철도 = 도시철도 구간 요금(1구간 1,550 · 2구간 1,650, 대전교통공사 운임표)
//   · 버스 구간마다 '탈 수 있는 일반·마을버스 후보'의 요금(scenario.js busByType). 좌석·광역 등은 요금표 미확인이라 후보에서 제외(탈 노선에서도 제외)
//   · 후보에 따라 합계가 달라질 수 있으면(예: 1,350~1,500원) 지금은 미확인 → 실제로 탈 버스가 정해지면 evalPlan에서 그 버스 요금으로 확정
//   · 같은 노선을 다시 탈 수 있으면(버스 구간 후보가 겹침) 환승 할인을 확정할 수 없어 미확인
//   · 지하철 구간 요금은 scenario.js zoneConfirmed(확인값)로만. 없으면 이전처럼 카카오 요금 대조
//   · 공식 계산과 카카오 요금이 다르면 확정하지 않음(미확인). 공식 계산이 불가능할 때만 카카오 안내 요금 사용
//   · 환승 가능 시간(다음 노선 배차 15분 이하 30분, 16분 이상 60분)은 지킨다고 가정
function routeFare(r) {
  const F = SC.fare, buses = r.steps.filter((s) => s.type === 'BUS'), subs = r.steps.filter((s) => s.type === 'SUBWAY'), rides = r.steps.filter((s) => s.type !== 'WALKING');
  const kv = fnum(r.fare) > 0 ? Number(r.fare) : null, km = fnum(r.fareMin) > 0 ? Number(r.fareMin) : null;
  const kakao = (why) => (kv != null ? { fare: kv, cityOnly: false, src: '카카오 안내 요금', selfWhy: why } : { fare: null, cityOnly: false, why });
  if (!rides.length) return { fare: 0, cityOnly: false, src: '도보' };
  if (subs.length > 1) return kakao('지하철을 두 번 이상 타는 경로는 요금 계산 미지원');
  if (rides.length - 1 > F.maxTransfers) return kakao(`환승 ${rides.length - 1}회 — 환승 할인은 최대 ${F.maxTransfers}회`);
  // 버스 구간별 탈 수 있는 일반·마을버스 후보와 요금
  const cand = buses.map((b) => b.vehicles.filter((v) => v.name && CITY_TYPES().includes(v.type) && F.busByType[v.type] > 0).map((v) => ({ name: v.name, fare: F.busByType[v.type] })));
  if (cand.some((c) => !c.length)) return kakao('탈 수 있는 일반·마을버스가 없는 구간이 있음(좌석·광역 등은 요금표 미확인)');
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) if (cand[i].some((x) => cand[j].some((y) => y.name === x.name))) return { fare: null, cityOnly: false, why: '같은 노선을 다시 탈 수 있어 환승 할인을 확정할 수 없음' };
  let subFare = 0;
  if (subs.length) {
    const sb = subs[0], from = stationNum(sb.stops[0]), to = stationNum(sb.stops[sb.stops.length - 1]);
    const zo = from && to ? zoneOf(pairOf(from, to)) : null;
    if (zo && zo.zone === null) return { fare: null, cityOnly: false, why: zo.why };
    const z = zo ? zo.zone : null;
    if (z === 1 || z === 2) subFare = F.subway['zone' + z];
    else {
      // 구간 확인값이 없으면 이전 방식: 카카오 요금이 공식 합계(1구간·2구간)와 같을 때만 인정
      const busMax = cand.length ? Math.max(...cand.map((c) => Math.max(...c.map((x) => x.fare)))) : 0, busMin = cand.length ? Math.max(...cand.map((c) => Math.min(...c.map((x) => x.fare)))) : 0;
      const k = kv != null ? kv : km;
      if (busMin === busMax && k != null && (k === Math.max(busMax, F.busSubway.zone1) || k === Math.max(busMax, F.busSubway.zone2))) return { fare: k, cityOnly: !!cand.length, src: '카카오 요금 대조' };
      return kakao('지하철 구간 요금(1·2구간) 확인 근거 없음(공식 역간 거리·확인값 없음)');
    }
  }
  const lo = Math.max(subFare, ...cand.map((c) => Math.min(...c.map((x) => x.fare)))), hi = Math.max(subFare, ...cand.map((c) => Math.max(...c.map((x) => x.fare))));
  if (lo !== hi) return { fare: null, cityOnly: true, why: `탈 버스에 따라 요금이 달라짐(${won(lo)}~${won(hi)})`, vary: { cand, subFare } };
  // 카카오 요금(값 또는 최저값)과 대조: 다르면 확정하지 않음
  const k = kv != null ? kv : km;
  if (k != null && k !== lo) return { fare: null, cityOnly: false, why: `공식 계산 ${won(lo)}과 카카오 안내 ${won(k)}이 달라 확인 필요` };
  return { fare: lo, cityOnly: !!cand.length, src: '공식 환승 규정', kakaoMatch: k != null };
}
// 요금이 탈 버스에 따라 달라지는 경로: 실제로 탈 첫 버스(노선 번호)가 정해지면 그 버스 요금으로 다시 계산 (나머지 구간이 한 가지로 정해질 때만)
function fareForBus(fare, routeNo) {
  if (!fare || !fare.vary || !routeNo) return null;
  const first = fare.vary.cand[0].filter((x) => norm(x.name) === norm(routeNo));
  if (!first.length) return null;
  const rest = fare.vary.cand.slice(1), f0 = first[0].fare;
  const lo = Math.max(fare.vary.subFare, f0, ...rest.map((c) => Math.min(...c.map((x) => x.fare)))), hi = Math.max(fare.vary.subFare, f0, ...rest.map((c) => Math.max(...c.map((x) => x.fare))));
  return lo === hi ? lo : null;
}
// '실질적으로 같은 경로' 판단 키: 타는 수단의 순서와 승·하차 정류장(버스)·역(지하철). 노선 후보 목록·도보 구간 차이는 같은 경로로 봄
function routeKey(r) {
  const k = r.steps.filter((s) => s.type !== 'WALKING').map((s) => (s.type === 'SUBWAY'
    ? `S:${stationNum(s.stops[0]) || norm(s.stops[0])}>${stationNum(s.stops[s.stops.length - 1]) || norm(s.stops[s.stops.length - 1])}`
    : `B:${norm(s.stops[0])}>${norm(s.stops[s.stops.length - 1])}`)).join('|');
  return k || 'WALK';
}
const kakaoEst = (r) => (fnum(r.totalSec) >= 0 ? Number(r.totalSec) : Infinity);   // 카카오 전체 소요(대기 포함 추정): 후보 고르기에만 사용
// 카카오 경로 1개 → 계산용 계획: 첫 버스(실시간 대기 대상), 지하철 구간(역번호·시각표 구간), 요금, 첫 도보 보충 지점
function makePlan(r) {
  const plan = { key: routeKey(r), route: r, fare: routeFare(r), board: null, stop: null, stopWhy: null, walk0Pt: null, walk0: null,
    subStep: null, from: null, to: null, pair: null, dir: null, hub: null, alight: null, unsupported: null };
  const subs = r.steps.filter((s) => s.type === 'SUBWAY');
  if (subs.length === 1) {
    const sb = subs[0], from = stationNum(sb.stops[0]), to = stationNum(sb.stops[sb.stops.length - 1]);
    if (from && to && from !== to && validPt(sb.start)) {
      Object.assign(plan, { subStep: sb, from, to, pair: pairOf(from, to), dir: subDir(from, to),
        hub: { name: stationName(sb.stops[0]), stNum: from, lat: sb.start.lat, lng: sb.start.lng },
        alight: { name: stationName(sb.stops[sb.stops.length - 1]), stNum: to, pt: validPt(sb.end) ? sb.end : null } });
    } else plan.unsupported = '1호선 역으로 확인되지 않는 지하철 구간';
  } else if (subs.length > 1) plan.unsupported = '지하철을 두 번 이상 타는 경로';
  // 실시간 버스 대기는 '처음 타는 교통수단이 버스'일 때만 계산 (지하철 뒤 버스는 도착 시각이 미래라 실시간 목록과 맞지 않음)
  const first = r.steps.find((s) => s.type !== 'WALKING');
  // 요금이 '일반·마을버스 기준'(min)으로 정해졌으면 그 버스들만 탈 노선으로 봄 (좌석버스 등은 요금이 달라 제외)
  const boardable = (s) => s.vehicles.filter((v) => !plan.fare.cityOnly || CITY_TYPES().includes(v.type)).map((v) => v.name).filter(Boolean);
  // 모든 버스 구간(첫 버스·환승 버스)의 승차 안내·요약·대기 안내는 이 목록만 씀 (update12 감사: 뒤 버스에 제외된 좌석버스가 보이지 않게)
  plan.namesOf = boardable;
  if (first && first.type === 'BUS') { plan.board = { name: first.stops[0], pt: validPt(first.start) ? first.start : null, head: validPt(first.head) ? first.head : null, routeNos: boardable(first) }; plan.boardStep = first; }
  // 카카오 경로는 출발지 → 첫 정류장(역) 도보 구간을 주지 않을 때가 있음(실제 응답: 첫 단계가 바로 BUS) → 따로 도보 길찾기
  if (r.steps[0].type !== 'WALKING' && validPt(r.steps[0].start)) plan.walk0Pt = r.steps[0].start;
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
/* ---------------- 버스 운행 방향 자동 검증 (TAGO 버스노선정보 · update12) ---------------- */
// 노선 번호별 공식 노선(노선 ID)과 경유 정류장(정류장 ID·이름·좌표·순번·상하행)을 받아, 카카오 버스 구간의
//   승차 → 하차가 '같은 운행 구간(상행 또는 하행)' 안에서 이 순서로 이어지는지 확인합니다.
//   확인 조건(모두 만족해야 '자동 확인'):
//   ① 승차·하차 정류장: 이름이 같고 카카오 경로 좌표에서 stopMatchM 안
//   ② 하차가 승차보다 뒤 순번 · 그 사이 정류장의 상하행 코드가 모두 같음(회차를 넘지 않음). 노선에 상하행 코드가 아예 없으면 ③으로만 판단
//   ③ 그 사이 정류장 수가 카카오 정류장 수와 거의 같고(±15%, 최소 1), 카카오 정류장 이름이 순서대로 60% 이상 일치
//   ④ 승차 정류장을 노선이 두 번 지나면(순환·회차) 도착하는 차가 어느 쪽인지 알 수 없어 확정하지 않음
//   ⑤ 같은 번호의 여러 노선 ID에서 승차 정류장이 서로 다르게 나오면 확정하지 않음
//   실시간 도착 차량은 TAGO 도착정보의 노선 ID가 확인된 노선 ID와 같을 때만 '자동 확인'으로 계산합니다 (대전시 보조 도착정보는 노선 ID 체계가 달라 대조하지 않음)
function verifyDir(step, routeNo, info) {
  if (!info || info.err) return { state: 'fail', why: `${routeNo}번 노선 정보 조회 실패` };
  if (info.mock) return { state: 'fail', why: '예시 데이터' };
  const routes = Array.isArray(info.routes) ? info.routes : [];
  if (!routes.length && info.complete !== false) return { state: 'none', why: `${routeNo}번 공식 노선 정보 없음` };
  // 서버가 불완전하다고 표시한 결과(노선 ID 일부만 조회·경유 목록 이상)는 방향 확인에 쓰지 않음 (확인되지 않은 노선 ID에 다른 승차 정류장이 있을 수 있음)
  //   화면에서도 한 번 더: 경유 정류장 순번이 1 이상 정수로 엄격히 증가하지 않으면(중복·비정상 순번) 불완전으로 봄
  const ordOk = (S) => Array.isArray(S) && S.every((x, k) => Number.isInteger(x.ord) && x.ord >= 1 && (k === 0 || x.ord > S[k - 1].ord));
  if (info.complete === false || routes.some((r) => !r.complete || !ordOk(r.stops) || !okRid(r.routeId))) return { state: 'incomplete', why: `${routeNo}번 노선 정보 불완전${info.why ? ` (${info.why})` : ''}` };
  const bpt = validPt(step.start) ? step.start : null, apt = validPt(step.end) ? step.end : null;
  if (!bpt || !apt) return { state: 'fail', why: '카카오 승·하차 좌표 없음' };
  const M = TR.stopMatchM || 80, ks = step.stops.map(norm), hits = [];
  let loops = 0;
  const near = (x, name, q) => validPt(x) && norm(x.name) === norm(name) && dist(q, x) <= M;
  for (const r of routes) {
    const S = Array.isArray(r.stops) ? r.stops : [];
    if (!S.length) continue;
    const B = [], A = [];
    S.forEach((x, k) => { if (near(x, step.stops[0], bpt)) B.push(k); if (near(x, step.stops[step.stops.length - 1], apt)) A.push(k); });
    for (const b of B) for (const a of A) {
      if (a <= b) continue;
      const seg = S.slice(b, a + 1);
      if (r.hasUd) { if (seg.some((x) => x.ud == null || x.ud !== seg[0].ud)) continue; }   // 상하행이 섞이거나 빠지면 같은 운행 구간으로 보지 않음
      if (Math.abs(seg.length - ks.length) > Math.max(1, Math.round(ks.length * 0.15))) continue;
      let j = 0, hit = 0;
      for (const x of seg) { const k = ks.indexOf(norm(x.name), j); if (k >= 0) { hit++; j = k + 1; } }
      if (hit / ks.length < 0.6) continue;
      if (S.filter((x) => x.nodeId === S[b].nodeId).length > 1) { loops++; continue; }
      hits.push({ routeId: r.routeId, node: S[b] });
    }
  }
  // 완전한 공식 목록에서 확인되지 않음: 순환·회차(승차 정류장을 두 번 지남)는 모호, 그 밖은 불일치 → 둘 다 공식 정보가 거부한 것으로 봄
  if (!hits.length) return loops ? { state: 'ambiguous', why: `${routeNo}번 승차 정류장을 두 번 지나는 노선(순환·회차)이라 방향을 정할 수 없음` }
    : { state: 'mismatch', why: `${routeNo}번 공식 경유 정류장에서 카카오 승·하차 순서를 확인하지 못함` };
  const nodes = [...new Set(hits.map((h) => h.node.nodeId))];
  if (nodes.length > 1) return { state: 'ambiguous', why: `${routeNo}번 승차 정류장 후보가 둘 이상(노선 ID ${hits.length}개)` };
  const node = hits[0].node, res = { state: 'auto', nodeId: node.nodeId, node, routeIds: [...new Set(hits.map((h) => h.routeId))] };
  // 수동 확인(verifiedStops)이 같은 승차 지점의 다른 정류장을 가리키면 충돌 → 확인 상태를 주지 않음
  const man = (SC.bus.verifiedStops || {})[norm(routeNo)] || [];
  if (man.length && !man.includes(node.nodeId) && routes.some((r) => (r.stops || []).some((x) => man.includes(x.nodeId) && near(x, step.stops[0], bpt)))) { res.state = 'conflict'; res.why = `${routeNo}번 수동 확인 정류장과 공식 노선 정보가 달라 방향 미확인`; }
  return res;
}
// 공식 노선 정보가 '완전한 목록으로 검증했는데 맞지 않는다'고 판정한 상태 → 수동 확인 목록(verifiedStops)으로 확인 상태를 주지 않음 (update12 감사)
//   수동 목록은 공식 정보를 확보하지 못한 경우(조회 실패·예시 데이터·공식 노선 없음·불완전 목록·조회 상한)에만 보조로 씀
// 노선 ID 검사(서버와 같은 기준): 영문·숫자·_·- 1~40자, 문자열 'null'·'undefined'(대소문자·공백 무관) 제외 — 불량 ID끼리 같다고 자동 확인하지 않음 (update12 최종)
const okRid = (v) => (typeof v === 'string' || typeof v === 'number') && /^[A-Za-z0-9_-]{1,40}$/.test(String(v)) && !/^(null|undefined)$/i.test(String(v).trim());
const OFFICIAL_REJECT = ['mismatch', 'ambiguous', 'conflict'];
const officialRejects = (d) => !!d && OFFICIAL_REJECT.includes(d.state);
// 수동 확인을 쓸 수 있는지: 그 노선+정류장이 목록에 있고, 공식 정보가 자동 확인도 거부도 하지 않았을 때만
const manualOk = (p, routeNo, stopId) => { const d = p.dirs && p.dirs[norm(routeNo)]; return verifiedFor(routeNo, stopId) && !(d && (d.state === 'auto' || officialRejects(d))); };
// 대중교통 후보의 첫 버스 노선 번호들에 대해 노선 정보를 불러옴 (서로 다른 번호만, routeInfoMax개까지, 4개씩 동시에)
async function loadRouteInfo(nos, force) {
  // 실패·불완전(complete=false)한 결과는 이번 계산에서만 쓰고, 다음 조회 때 다시 받음 (완전한 결과만 이 세션 동안 재사용 · update12 감사)
  const incomplete = (r) => r.complete === false || (Array.isArray(r.routes) && r.routes.some((x) => !x || x.complete !== true || !okRid(x.routeId)));
  const want = nos.filter((n) => force || !st.routeInfo[n] || st.routeInfo[n].err || incomplete(st.routeInfo[n]));
  for (let i = 0; i < want.length; i += 4) {
    await Promise.all(want.slice(i, i + 4).map(async (n) => {
      try {
        const r = await api('/api/busroute', { routeNo: n });
        st.routeInfo[n] = r && Array.isArray(r.routes) ? r : { err: '노선 정보 형식 오류' };
      } catch (e) { st.routeInfo[n] = { err: e.message }; }   // 실패는 이번 계산에서만 '확인 실패'로 쓰고 다음 조회 때 다시 시도
    }));
  }
}
// 실제로 탈 버스의 방향 상태: auto(공식 노선 정보로 자동 확인) · manual(수동 확인 목록, 자동 확인이 안 될 때만) · geometry(경로 좌표 추정) · conflict · unknown
function busDirOf(p, bus) {
  if (!bus) return { state: 'unknown' };
  const d = p.dirs && p.dirs[norm(bus.routeNo)];
  if (d && d.state === 'conflict') return { state: 'conflict', why: d.why };
  if (d && d.state === 'auto') {
    if (bus.stop.id !== d.nodeId) return { state: 'unknown', why: `${bus.routeNo}번 공식 노선 정보의 승차 정류장이 아님` };
    return bus.arrSrc === 'tago' && okRid(bus.routeId) && d.routeIds.includes(bus.routeId) ? { state: 'auto' } : { state: 'unknown', why: `${bus.routeNo}번 실시간 차량의 노선 ID를 확인된 노선과 대조할 수 없음` };
  }
  // 공식 정보가 거부(불일치·모호)한 노선은 수동 확인 목록에 있어도 확인하지 않음
  if (officialRejects(d)) return { state: 'unknown', why: d.why + (verifiedFor(bus.routeNo, bus.stop.id) ? ' · 공식 정보와 맞지 않아 수동 확인 목록 미적용' : '') };
  if (verifiedFor(bus.routeNo, bus.stop.id)) return { state: 'manual' };
  if (bus.stop.side === 'right') return { state: 'geometry', why: d && d.why };
  return { state: 'unknown', why: d && d.why };
}

// 카카오 탑승 정류장 → TAGO 정류장: 이름이 같고 경로 좌표에서 stopMatchM 안인 정류장만 후보
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
// 대중교통 후보 불러오기: 카카오 경로 전체(보통 15개) → 같은 경로 합치기 → 카카오 예상 소요 짧은 순 transitEval개만 실시간 평가
//   (수단 조합에 우선순위 없음. 화면 순서는 실시간으로 다시 계산한 도착 시각으로 정함)
//   탑승 정류장 추가 조회·첫 도보 길찾기는 서로 다른 지점만, 상한 안에서만 부름 (호출량 관리)
async function loadTransit() {
  const ok = ticket('transit');
  if (!st.cfg.route || !supported()) { st.plans = []; st.plansAt = 0; st.routeCount = 0; st.extraStops = []; st.planWhy = !st.cfg.route ? '카카오 대중교통 길찾기를 쓸 수 없음(키 없음·예시 데이터)' : null; return; }
  let plans = [], why = null, count = 0;
  try {
    const v = await api('/api/transit', legQuery(st.origin, st.dest));
    const routes = validRoutes(v.routes);
    if (!routes.length) throw new Error('길찾기 결과가 비어 있거나 올바르지 않아요');
    await loadDist(routePairs(routes));   // 요금 구간 판정에 쓸 공식 역간 거리(실패해도 확인값·카카오 대조로 계속)
    count = routes.length;
    const seen = new Map();
    for (const r of routes) { const p = makePlan(r), prev = seen.get(p.key); if (!prev || kakaoEst(r) < kakaoEst(prev.route)) seen.set(p.key, p); }
    plans = [...seen.values()].sort((a, b) => kakaoEst(a.route) - kakaoEst(b.route)).slice(0, RS.transitEval || 8);
  } catch (e) { why = `대중교통 길찾기 실패 (${e.message})`; }
  if (!ok()) return;
  // 탑승 정류장 연결 (TAGO): 출발지 600m 안 정류장에서 찾고, 없으면 탑승 지점 근처를 조회(서로 다른 지점만, extraStopMax회까지 · 서버 1일 캐시)
  const lookups = new Map();
  await Promise.all(plans.filter((p) => p.board).map(async (p) => {
    let m = resolveStop(p.board, st.stops);
    if (!m && p.board.pt) {
      const k = c4(p.board.pt.lat) + ',' + c4(p.board.pt.lng);
      if (!lookups.has(k)) {
        if (lookups.size >= (RS.extraStopMax || 4)) { p.stopWhy = `탑승 정류장 '${p.board.name}' 조회 생략(조회 상한)`; return; }
        lookups.set(k, api('/api/stops', { lat: c4(p.board.pt.lat), lng: c4(p.board.pt.lng) }).then((r) => r.stops || []).catch(() => []));
      }
      m = resolveStop(p.board, await lookups.get(k));
    }
    if (m) p.stop = { ...m, d: dist(st.origin, m) };
    else if (!p.stopWhy) p.stopWhy = p.board.pt ? `탑승 정류장 '${p.board.name}'을 TAGO 정류장과 연결하지 못함` : '탑승 정류장 좌표가 올바르지 않음';
  }));
  if (!ok()) return;
  // 버스 운행 방향 자동 검증: 첫 버스 노선 번호(서로 다른 것만, routeInfoMax개까지)의 공식 노선 정보로 확인
  const nos = [];
  for (const p of plans) for (const n of (p.board ? p.board.routeNos : [])) if (!nos.includes(n)) nos.push(n);
  const fetchNos = nos.slice(0, RS.routeInfoMax || 16);
  await loadRouteInfo(fetchNos);
  if (!ok()) return;
  for (const p of plans) {
    if (!p.board) continue;
    p.dirs = {};
    for (const n of p.board.routeNos) p.dirs[norm(n)] = fetchNos.includes(n) ? verifyDir(p.boardStep, n, st.routeInfo[n]) : { state: 'fail', why: `${n}번 노선 정보 조회 생략(조회 상한)` };
    // 자동 확인된 승차 정류장(공식 정류장 ID)은 실시간 도착정보 감시 대상에 넣음
    p.autoStops = [];
    for (const d of Object.values(p.dirs)) if (d.state === 'auto' && !p.autoStops.some((x) => x.id === d.nodeId)) {
      const known = [...st.stops, ...(p.stop ? [p.stop] : [])].find((x) => x.id === d.nodeId);
      p.autoStops.push(known || { id: d.nodeId, no: d.node.no, name: d.node.name, lat: d.node.lat, lng: d.node.lng, d: dist(st.origin, d.node), side: null, auto: true });
    }
  }
  // 출발지 → 첫 정류장 도보: 카카오 순서대로 서로 다른 탑승 지점 walk0Max곳만 도보 길찾기, 나머지는 직선거리 도보 규칙
  const walks = new Map();
  for (const p of plans) {
    if (!p.walk0Pt) continue;
    const k = c4(p.walk0Pt.lat) + ',' + c4(p.walk0Pt.lng);
    if (!walks.has(k) && walks.size < (RS.walk0Max || 3)) walks.set(k, api('/api/walk', legQuery(st.origin, p.walk0Pt)).then((v) => (validLeg(v) ? { sec: Number(v.sec), m: Number(v.m), path: cleanPath(v.path) } : null)).catch(() => null));
  }
  await Promise.all(plans.map(async (p) => { if (p.walk0Pt) { const k = c4(p.walk0Pt.lat) + ',' + c4(p.walk0Pt.lng); if (walks.has(k)) p.walk0 = await walks.get(k); } }));
  if (!ok()) return;
  st.plans = plans; st.plansAt = plans.length ? Date.now() : 0; st.planWhy = why; st.routeCount = count;
  const ex = [];
  for (const p of plans) for (const x of [...(p.autoStops || []), ...(p.stop ? [p.stop] : [])]) if (!st.stops.some((s) => s.id === x.id) && !ex.some((s) => s.id === x.id)) ex.push(x);
  st.extraStops = ex.slice(0, RS.extraStopMax || 4);
}

/* ---------------- 환승역 후보 (복합경로 · update12) ---------------- */
// 근처 지하철역: 카카오 로컬 '지하철역' 카테고리(SW8)로 출발지 반경 hubRadiusM 검색 (위치 변경·새로고침 때 1회, 재사용 없음)
async function loadHubs() {
  const ok = ticket('hubs');
  if (!st.cfg.search || !supported()) { st.hubSearch = []; st.hubsWhy = !st.cfg.search ? '근처 지하철역 검색을 쓸 수 없음(키 없음·예시 데이터)' : null; return; }
  let list = [], why = null;
  try {
    const r = await api('/api/stations', { lat: c4(st.origin.lat), lng: c4(st.origin.lng), r: RS.hubRadiusM || 4000 });
    list = (r.stations || []).filter((s) => s && validPt(s)).map((s) => { const x = stationFromPlace(s.name); return x ? { ...x, lat: Number(s.lat), lng: Number(s.lng), src: 'kakao' } : null; }).filter(Boolean);
    if (!list.length) why = '근처 지하철역을 찾지 못함';
  } catch (e) { why = `근처 지하철역 검색 실패 (${e.message})`; }
  if (!ok()) return;
  st.hubSearch = list; st.hubsWhy = why;
}
// 환승역 후보 = 근처 지하철역 검색 결과 ∪ 카카오 대중교통 경로에 나온 승차역 (대전역 제외). 둘 다 없으면 기본 환승역(가정)
//   1차 추정(직선거리·역 수)이 짧은 순 hubCandMax곳. A(특정 대중교통 경로)의 환승역에 묶이지 않음
const rideEst = (stNum) => Math.abs(Number(stNum) - Number(DEST_ST)) * (SC.subway.minPerStation || 2);
function hubEst(mode, hb) {
  const T = SC.tashu, ride = rideEst(hb.stNum);
  return mode === 'taxi' ? SC.taxi.waitMin + estMin(st.origin, hb, SC.taxi.estKmh || 25) + SC.taxi.hubWalkMin + ride
    : estMin(st.origin, hb, T.estKmh || 13) + T.dockMin * 2 + (TR.inStationMin || 0) + ride;
}
function hubCands() {
  const m = new Map();
  for (const s of st.hubSearch) if (s.stNum !== DEST_ST && !m.has(s.stNum)) m.set(s.stNum, { name: s.name, stNum: s.stNum, lat: s.lat, lng: s.lng, src: 'kakao' });
  for (const p of st.plans) if (p.hub && p.from !== DEST_ST && !m.has(p.from)) m.set(p.from, { name: p.hub.name, stNum: p.from, lat: p.hub.lat, lng: p.hub.lng, src: 'route' });
  let list = [...m.values()];
  if (!list.length) list = [{ name: SC.hub.name, stNum: SC.subway.stNum, lat: SC.hub.lat, lng: SC.hub.lng, src: 'default' }];
  return list.map((hb) => ({ ...hb, d: dist(st.origin, hb), pair: pairOf(hb.stNum, DEST_ST), dir: subDir(hb.stNum, DEST_ST), alight: { name: stName(DEST_ST), stNum: DEST_ST } }))
    .sort((a, b) => hubEst('tashu', a) - hubEst('tashu', b)).slice(0, RS.hubCandMax || 6);
}
// 길찾기 API를 부를 환승역: 유형별 1차 추정 상위 N곳 (나머지 후보는 추정값으로만 계산 → '가정값 포함'이라 대표로 뽑히지 않음)
const pickHubs = (mode, n) => hubCands().slice().sort((a, b) => hubEst(mode, a) - hubEst(mode, b)).slice(0, n);
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
// 타슈 구간 길찾기: 출발 대여소까지 도보, 타슈 연계 환승역 후보(추정 상위 hubLegsTashu곳)마다 자전거 + 반납 후 도보, 전 구간 타슈 자전거
async function loadLegs(force) {
  if (!st.cfg.route || !supported()) { st.legs = {}; return; }
  const ok = ticket('legs');
  const tStart = curTStart(), hubs = pickHubs('tashu', RS.hubLegsTashu || 2);
  const ends = await Promise.all(hubs.map((hb) => tashuNear(hb, force).catch(() => null)));
  const endDest = await tashuNear(st.dest, force).catch(() => null);
  if (!ok()) return;
  const want = {};
  if (tStart) want.walkStart = ['walk', st.origin, tStart];
  hubs.forEach((hb, i) => { const e = ends[i]; if (!e) return; want['walkHub:' + hb.stNum] = ['walk', e, hb]; if (tStart) want['bikeHub:' + hb.stNum] = ['bike', tStart, e]; });
  if (endDest && tStart) want.bikeDest = ['bike', tStart, endDest];
  const prev = st.legs || {}, next = { endDest, tStartId: tId(tStart), endHub: Object.fromEntries(hubs.map((hb, i) => [hb.stNum, ends[i]])) };
  await Promise.all(Object.entries(want).map(async ([name, [kind, a, b]]) => {
    const q = legQuery(a, b), key = kind + ':' + Object.values(q).join(','), old = prev[name];
    // 30초 갱신: 화면에 표시 중인 같은 구간 결과는 그대로(재호출 없음). 실패한 구간은 5분 뒤에만 다시 시도
    if (!force && old && old.key === key && (old.v || Date.now() - old.t < LEG_RETRY_MS)) { next[name] = old; return; }
    try {
      const v = await api('/api/' + kind, q);
      if (!validLeg(v)) throw new Error('길찾기 응답이 올바르지 않아요');
      next[name] = { key, v: { sec: Number(v.sec), m: Number(v.m), path: cleanPath(v.path) }, t: Date.now() };   // path: 지도 표시용 (update14)
    } catch (e) { next[name] = { key, err: e.message, t: Date.now() }; }
  }));
  if (!ok()) return;
  st.legs = next;
}

/* ---------------- 경로 계산 ---------------- */
// 열차 대기: 그 역 구간(pair)의 시각표만 사용 (다른 역 구간의 시각표 적용 방지)
const ttDays = (pair) => { const c = st.tt[pair] ? cleanTimetable(st.tt[pair]) : null; return c ? c.days : null; };
function dayOf(platformMs, t) { const wd = new Date(platformMs - (t >= 1440 ? 86400000 : 0)).getDay(); return wd === 0 || wd === 6 ? SC.subway.dayHoliday : SC.subway.dayWeekday; }
function subwayNext(platformMs, pair, dir) {
  const d = new Date(platformMs);
  let t = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  if (t < 240) t += 1440;                      // 자정 이후는 전날 시각표의 24시대
  const tb = t + (SC.bufferMin || 0);          // 승강장 도착 후 최소 여유 이후 열차만 탑승
  const tt = ttDays(pair);
  if (tt) {
    const day = dayOf(platformMs, t), set = tt[day] && tt[day][dir];
    if (set && set.from.length) {
      const dep = set.from.find((x) => x >= tb - 1e-9);
      if (dep == null) return { wait: 0, dep: null, table: true, ended: true, day };   // 막차 이후: 탈 열차 없음
      return { wait: dep - t, dep, table: true, day, holiday: day === SC.subway.dayHoliday };
    }
  }
  // 시각표로 확인 못 함 → 간격 가정(미확인). 이유를 구분: 조회 실패 · 응답 불완전(그날·그 방향 열차 목록 없음 포함) · 아직 없음
  const [ah, am] = SC.subway.anchor.split(':').map(Number);
  const a = ah * 60 + am, hw = SC.subway.headwayMin;
  const next = a + Math.ceil((tb - a) / hw - 1e-9) * hw;
  const why = st.ttWhy[pair] === 'fail' ? '열차 시각표 확인 실패' : st.ttWhy[pair] === 'bad' || tt ? '열차 시각표 불완전' : '열차 시각표 없음';
  return { wait: next - t, dep: next, table: false, day: dayOf(platformMs, t), why };
}
// 지하철 승차시간: 같은 역 구간이면 어느 경로든 같은 값. 우선순위: 시각표 역간 소요 → 확인된 구간 값(scenario.js rideConfirmed)
//   → 카카오 지하철 구간 시간(같은 구간을 지나는 카카오 경로, 미확인) → 역 수 × 역당 분(추정·미확인)
function subwayRide(hb, day) {
  const tt = ttDays(hb.pair), set = tt && tt[day] && tt[day][hb.dir];
  if (set && fnum(set.ride) > 0) return { min: Number(set.ride), ok: true, note: '시각표 기준' };
  const conf = (SC.subway.rideConfirmed || {})[hb.pair];
  if (fnum(conf) > 0) return { min: Number(conf), ok: true, note: '확인된 소요시간' };
  const p = st.plans.find((x) => x.pair === hb.pair && fnum(x.subStep.sec) > 0);
  if (p) return { min: p.subStep.sec / 60, ok: false, note: '카카오 구간 시간', why: '열차 소요시간 시각표 없음 · 카카오 구간 시간' };
  const n = Math.abs(Number(hb.stNum) - Number(hb.alight.stNum));
  return { min: n * (SC.subway.minPerStation || 2), ok: false, note: `${n}개 역 × ${SC.subway.minPerStation || 2}분 추정`, why: '열차 소요시간 추정' };
}
// 버스 대기 (기존 원리 유지: 정류장까지 걸어가 최소 여유 1분 뒤에 오는 차만 탑승 가능)
//   · 탈 수 있는 실제 도착정보(뒤에 오는 차 포함)를 먼저 사용
//   · 목록의 차를 모두 놓치면 '목록의 마지막 차 + 배차 가정 간격 × k'에서 정류장 도착(+여유) 이후 첫 차를 가정
//     → 대기는 항상 여유(1분) 이상이고, 탑승 시각이 정류장 도착보다 앞서지 않음 (0으로 자르지 않음)
//   allow: 이 노선을 타도 되는 정류장인지 (명시적 정류장 제한 · fixed 정류장도 예외 없음)
function findBus({ routeNos, allow, walkOf, accept }) {
  const nos = routeNos.map(norm), buf = SC.bufferMin || 0, hw = SC.bus.headwayMin;
  let live = null, assumed = null;
  for (const s of [...st.stops, ...st.extraStops]) {
    if (!allow(s)) continue;
    const a = st.arr[s.id]; if (!a || !a.list) continue;
    const walk = walkOf(s), need = walk + buf;
    // 실시간 탑승 후보 = 노선 번호 일치 · 차량 노선 ID 유효(okRid: 누락·빈 값·'null'·'undefined' 등 제외 — 자동·수동·추정 모든 경로 공통, update12 최종) · 경로별 방향 조건(accept)
    //   불량 ID 차량은 목록에서 빠지므로 '다음 차 가정'의 기준 차량으로도 쓰이지 않음
    const buses = a.list.filter((x) => nos.includes(norm(x.routeNo)) && okRid(x.routeId) && (!accept || accept(s, x, a))).map((b) => ({ b, rem: remainSec(b, a.at) / 60 })).sort((x, y) => x.rem - y.rem);
    if (!buses.length) continue;
    const c = buses.find((x) => x.rem >= need);
    if (c) {
      const r = { stop: s, walk, wait: c.rem - walk, catchable: true, source: 'live', total: c.rem, prevCnt: c.b.prevCnt, routeNo: c.b.routeNo, routeId: c.b.routeId || '', arrSrc: a.source || '', later: c !== buses[0] };
      if (!live || r.total < live.total) live = r;
    } else {
      const last = buses[buses.length - 1].rem, k = Math.max(1, Math.ceil((need - last) / hw - 1e-9));
      const dep = last + k * hw;
      const lb = buses[buses.length - 1].b;      // 가정 출발 시각의 기준 차량(목록의 마지막 차) — 노선 번호·노선 ID를 같은 차량에서 가져옴
      const r = { stop: s, walk, wait: dep - walk, catchable: false, source: 'assumed', total: dep, prevCnt: null, routeNo: lb.routeNo, routeId: lb.routeId || '', arrSrc: a.source || '' };
      if (!assumed || r.total < assumed.total) assumed = r;
    }
  }
  return live || assumed;
}
function build(o, segs) {
  let t = Date.now();
  const steps = segs.map((s) => { const start = t; t += s.min * 60000; return { ...s, start, end: t }; });
  return { ...o, steps, arrive: t, total: (t - Date.now()) / 60000 };
}
const secMin = (s) => Number(s) / 60;
const walkSeg = (s, label) => ({ type: 'walk', min: secMin(s.sec), label, note: `카카오 길찾기${nonNeg(s.m) ? ` · ${Math.round(s.m)}m` : ''}` });
const busNames = (s) => s.vehicles.map((v) => v.name).filter(Boolean);
const busLabel = (s, namesOf = busNames) => `${namesOf(s).join('·') || '버스'}번 버스`;
const rideSeg = (s, names) => ({ type: 'ride', min: secMin(s.sec), label: names ? `${names.join('·') || '버스'}번 버스` : busLabel(s), note: `${s.stops[0] || ''} → ${s.stops[s.stops.length - 1] || ''}${s.stops.length > 1 ? ` · ${s.stops.length - 1}정거장` : ''} · 카카오 길찾기` });
// 처음 탄 교통수단 뒤에 오는 구간(지하철 하차 후 도보·버스 등): 도보는 카카오 구간 시간, 버스는 환승 대기 가정 + 승차, 그 밖은 지원하지 않음(미확인)
//   namesOf: 그 경로의 요금 기준과 같은 노선 목록 (일반·마을버스 기준 요금이면 좌석버스 등 제외)
function laterSegs(steps, unk, namesOf = busNames) {
  const out = [];
  steps.forEach((s, i) => {
    if (s.type === 'WALKING') out.push(walkSeg(s, i === steps.length - 1 ? `${st.dest.name}까지 도보` : '도보'));
    else if (s.type === 'BUS') {
      out.push({ type: 'wait', min: TR.transferWaitMin || 5, label: `${busLabel(s, namesOf)} 환승 대기`, note: '실시간 미연결 · 가정값' }, rideSeg(s, namesOf(s)));
      unk.push('환승 버스 대기는 가정값');
    } else {
      out.push({ type: s.type === 'SUBWAY' ? 'sub' : 'ride', min: secMin(s.sec), label: s.guidance || s.type, note: '대기 미반영 · 카카오 구간 시간' });
      unk.push('지원하지 않는 복합 구간 포함');
    }
  });
  return out;
}
// 카카오 경로의 마지막 지점 → 실제 목적지 (경로가 도보로 끝나지 않을 때). 기존 도보 규칙(직선거리 × 1.25 ÷ 70m)
function finalWalk(p) {
  const last = p && p.route.steps[p.route.steps.length - 1];
  if (!last || last.type === 'WALKING' || !validPt(last.end)) return [];
  const m = dist(last.end, st.dest);
  return m <= 30 ? [] : [{ type: 'walk', min: walkMin(m), label: `${st.dest.name}까지 도보`, note: `약 ${Math.round(m)}m (직선거리 × 1.25)` }];
}
// 복합경로·기존 고정 경로의 지하철 하차(대전역) 후 목적지까지: 대전역에서 내려 도보로만 끝나는 카카오 경로의 하차 후 구간을 같이 씀,
//   그런 경로가 없으면 대전역(기준점) → 목적지 직선거리 도보(30m 넘으면 추정값으로 표시)
function tailAtDest(unk) {
  const p = st.plans.find((x) => x.to === DEST_ST && x.subStep && x.route.steps.slice(x.route.steps.indexOf(x.subStep) + 1).every((s) => s.type === 'WALKING'));
  if (p) return [...laterSegs(p.route.steps.slice(p.route.steps.indexOf(p.subStep) + 1), unk, p.namesOf), ...finalWalk(p)];
  const m = dist(SC.dest, st.dest);
  if (m < 30) return [];
  unk.push('하차 후 목적지까지 직선거리 추정');
  return [{ type: 'walk', min: walkMin(m), label: `${st.dest.name}까지 도보`, note: `${stName(DEST_ST)}에서 약 ${Math.round(m)}m · 직선거리 추정` }];
}

/* ---------------- 요금 (공식 요금표 · scenario.js fare) ---------------- */
// 지하철 구간: 대전교통공사 이동구간제(여행개시역에서 10㎞ 이내 1구간·초과 2구간). 역간 거리는 공식 원본 미확보 →
//   ① scenario.js zoneConfirmed(팀 확인값) ② 같은 역 구간을 지나는 카카오 경로 요금 대조(일반·마을버스 + 지하철 1회 경로의 요금이 공식 환승 합계와 일치) 로만 확정
function subwayZone(pair) {
  const zo = zoneOf(pair);
  if (zo) return zo.zone ? { zone: zo.zone, src: zo.src } : null;   // 공식 거리·확인값이 서로 다르면 확정하지 않음(카카오 대조로 넘어가지 않음)
  const F = SC.fare;
  for (const p of st.plans) {
    if (p.pair !== pair || !p.fare || !(p.fare.fare > 0)) continue;
    const steps = p.route.steps, buses = steps.filter((s) => s.type === 'BUS'), fare = p.fare.fare;
    if (buses.length === 0) { if (fare === F.subway.zone1) return { zone: 1, src: '카카오 요금 대조' }; if (fare === F.subway.zone2) return { zone: 2, src: '카카오 요금 대조' }; }
    else if (buses.every((b) => b.vehicles.length) && (p.fare.cityOnly || buses.every((b) => b.vehicles.every((v) => CITY_TYPES().includes(v.type))))) {
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
//   avail 'ok'      = 운행·대여 가능 여부를 실시간 정보나 시각표로 확인함 → 추천·비교 기준 대상
//   avail 'unknown' = 조회 실패·가정값·추정값·미확인 정보(좌표·정류장 방향·요금 등)가 섞임 → 참고용으로만 표시, 추천하지 않음
//   avail 'no'      = 막차 종료·자전거 없음 → 이용 불가, 추천하지 않음
// 반환: list = 화면에 보이는 경로(도착 순, 이용 불가는 맨 뒤) · baseline = 비교 기준 · 그 밖은 안내 문구용 정보
//   allow: 추가 비용 허용 범위(원, null = 상관없음). 복합경로 유형별 대표를 고를 때 씀 → 바꿔도 외부 API는 다시 부르지 않음(계산된 후보만 다시 평가)
function computeRoutes(allow = st.allow) {
  const now = Date.now(), mock = !!st.cfg.mock, legacy = legacyOrigin(), F = SC.fare, T = SC.tashu;
  const origUnk = st.origin.verified === false ? ['출발지 좌표 미확인'] : [];
  const status = (no, unk) => { unk = [...unk, ...origUnk]; if (mock) unk = [...unk, '예시 데이터']; return { avail: no.length ? 'no' : unk.length ? 'unknown' : 'ok', why: [...new Set(no.length ? no : unk)] }; };
  // 지하철 대기·승차 (모든 경로 공통 계산): hb = { name, stNum, pair, dir, alight:{name, stNum} }
  const subwaySegs = (before, hb, unk, no) => {
    const used = before.reduce((a, s) => a + s.min, 0);
    const n = subwayNext(now + used * 60000, hb.pair, hb.dir);
    if (n.ended) { no.push('지하철 운행 종료'); return [{ type: 'wait', min: 0, label: '지하철 운행 종료', note: '열차 시각표상 지금 이후 탈 수 있는 열차가 없어요' }]; }
    if (!n.table) unk.push(`${n.why} · 간격 가정`);
    const ride = subwayRide(hb, n.day);
    if (!ride.ok) unk.push(ride.why);
    const depClock = clock(now + (used + n.wait) * 60000);
    return [{ type: 'wait', min: n.wait, label: '열차 대기', note: n.table ? `${hb.name} ${depClock} 출발 · ${n.holiday ? '휴일' : '평일'} 시각표` : `${hb.name} 출발 ${depClock} 열차 (${n.why} · 간격 ${SC.subway.headwayMin}분 가정)` },
      { type: 'sub', min: ride.min, label: '지하철 1호선', note: `${hb.name} → ${hb.alight.name} · ${ride.note}` }];
  };
  const subFareOf = (pair) => { const z = subwayZone(pair); return z ? { fare: F.subway['zone' + z.zone], zone: z } : null; };
  const fareUnk = (hb, ok) => (ok ? [] : [`요금 미확인 (지하철 ${hb.name}→${hb.alight.name} 요금 구간 확인 필요)`]);
  const planStale = st.plans.length && now - st.plansAt > ROUTE_STALE_MS ? ['경로 정보가 오래됨 · 새로고침 필요'] : [];
  const legacyHubObj = { name: SC.hub.name, stNum: SC.subway.stNum, lat: SC.hub.lat, lng: SC.hub.lng, src: 'default', pair: pairOf(SC.subway.stNum, DEST_ST), dir: subDir(SC.subway.stNum, DEST_ST), alight: { name: stName(DEST_ST), stNum: DEST_ST } };

  // ---- 1) 일반 대중교통: 카카오 후보마다 실시간 버스 대기·열차 시각표로 다시 계산 ----
  const evalPlan = (p) => {
    const steps = p.route.steps, segs = [], unk = [...planStale], no = [];
    let firstSeen = false, bus = null, dirInfo = null;
    if (p.unsupported) unk.push(p.unsupported);
    if (p.walk0Pt) {
      const m0 = dist(st.origin, p.walk0Pt), s0 = steps[0], to = s0.type === 'SUBWAY' ? stationName(s0.stops[0]) : s0.stops[0];
      segs.push(p.walk0 ? { type: 'walk', min: secMin(p.walk0.sec), label: `${to}까지 도보`, note: `카카오 도보 길찾기 · ${p.walk0.m}m` }
        : { type: 'walk', min: walkMin(m0), label: `${to}까지 도보`, note: `약 ${Math.round(m0)}m (직선거리 × 1.25)` });
    }
    let done = false;
    for (let i = 0; i < steps.length && !done; i++) {
      const s = steps[i], next = steps[i + 1];
      if (s.type === 'WALKING') segs.push(walkSeg(s, !next ? `${st.dest.name}까지 도보` : next.stops.length ? `${next.type === 'SUBWAY' ? stationName(next.stops[0]) : next.stops[0]}까지 도보` : '도보'));
      else if (s.type === 'BUS' && !firstSeen) {
        const walkBefore = segs.reduce((a, x) => a + x.min, 0);          // 출발지 → 정류장 도보 (지금까지 구간은 모두 도보)
        // 탈 수 있는 정류장: 자동 확인된 노선은 그 승차 정류장(공식 정류장 ID)에서만, 나머지 노선은 이름·좌표로 연결한 정류장에서
        const autoOf = (no) => { const d = p.dirs && p.dirs[norm(no)]; return d && d.state === 'auto' ? d : null; };
        const autoIds = (p.autoStops || []).map((x) => x.id);
        // 방향이 확인된 노선(자동·수동)이 하나라도 있으면 방향 미확인 노선의 차량은 타지 않음 (먼저 와도 반대 방향일 수 있음)
        const bnos = p.board ? p.board.routeNos : [];
        const confirmedNo = (n) => !!autoOf(n) || !!(p.stop && manualOk(p, n, p.stop.id));
        const anyConfirmed = bnos.some(confirmedNo), skipped = anyConfirmed ? bnos.filter((n) => !confirmedNo(n)) : [];
        bus = p.stop || autoIds.length ? findBus({ routeNos: p.board ? p.board.routeNos : [], walkOf: () => walkBefore,
          allow: (x) => (p.stop && x.id === p.stop.id) || autoIds.includes(x.id),
          // 자동 확인된 노선: 그 승차 정류장 + (TAGO 도착정보면) 확인된 노선 ID의 차량만. 같은 번호의 다른 노선 ID 차량은 타지 않음
          //   (대전시 보조 도착정보는 노선 ID 체계가 달라 차량은 받되 방향은 '미확인'으로 둠)
          accept: (x, b, a) => { const d = autoOf(b.routeNo); return d ? x.id === d.nodeId && (a.source !== 'tago' || (okRid(b.routeId) && d.routeIds.includes(String(b.routeId)))) : !!(p.stop && x.id === p.stop.id) && (!anyConfirmed || manualOk(p, b.routeNo, x.id)); } }) : null;
        if (bus) dirInfo = busDirOf(p, bus);
        const DIRTXT = { auto: ' · 방향: 공식 노선 정보로 확인', manual: ' · 방향: 수동 확인 목록' };
        if (bus) segs.push({ type: 'wait', min: bus.wait, label: `${bus.routeNo}번 버스 대기`, live: bus.catchable,
          note: (bus.catchable ? `실시간 · ${bus.stop.name}${bus.later ? ' · 뒤차' : ''}${prevTxt(bus.prevCnt)}` : `목록의 차는 모두 놓침 → 그 뒤 차(${SC.bus.headwayMin}분 간격) 가정`) + (DIRTXT[dirInfo.state] || '') + (skipped.length ? ` · 방향 미확인 노선(${skipped.join('·')}번) 제외` : '') });
        else segs.push({ type: 'wait', min: SC.bus.fallbackWaitMin, label: `${(p.board ? p.board.routeNos : []).join('·') || '버스'}번 버스 대기`, note: (p.stop || autoIds.length ? '실시간 도착정보 없음' : '정류장 연결 안 됨') + ' · 가정값' });
        if (!p.stop && !autoIds.length) unk.push(p.stopWhy || '탑승 정류장 연결 실패');
        else if (!bus) unk.push('버스 도착정보 없음(노선 미확인)');
        else {
          if (dirInfo.state === 'geometry') unk.push(`${bus.routeNo}번 운행 방향 추정(경로 좌표) · 확인 필요`);
          else if (dirInfo.state === 'conflict') unk.push(dirInfo.why);
          else if (dirInfo.state !== 'auto' && dirInfo.state !== 'manual') unk.push(dirInfo.why ? `${bus.routeNo}번 운행 방향 미확인 (${dirInfo.why})` : `${bus.routeNo}번 운행 방향 미확인`);
          else if (!bus.catchable) unk.push('다음 버스 시각은 가정값');
        }
        segs.push(rideSeg(s, p.board ? p.board.routeNos : null));   // 승차 안내도 요금 기준과 같은 노선만 (좌석버스 등 제외)
      } else if (s.type === 'SUBWAY' && s === p.subStep) {
        segs.push({ type: 'walk', min: TR.inStationMin || 0, label: '역내 이동·승강장까지', note: '가정값 (API 미제공)' });
        segs.push(...subwaySegs(segs, { ...p.hub, pair: p.pair, dir: p.dir, alight: p.alight }, unk, no));
        segs.push(...laterSegs(steps.slice(i + 1), unk, p.namesOf), ...finalWalk(p));   // 지하철 하차 후 구간: 앞선 이동·대기가 모두 반영된 시각부터 이어서 계산
        done = true;
      } else segs.push(...laterSegs([s], unk, p.namesOf));            // 처음 탄 교통수단 뒤의 버스, 확인 안 되는 지하철 등: 대기 가정(미확인)
      if (s.type !== 'WALKING') firstSeen = true;
    }
    if (!done) segs.push(...finalWalk(p));
    // 경로 요금: 공식 요금표·환승 규정 계산(routeFare) → 탈 버스에 따라 달라지면 실제로 탈 첫 버스 기준 → 그래도 안 되면 미확인(이유 표시)
    const busFare = p.fare.fare == null && bus ? fareForBus(p.fare, bus.routeNo) : null;
    const kf = p.fare.fare != null ? p.fare.fare : busFare;
    if (kf == null) unk.push(`요금 미확인 (${p.fare.why || '요금 정보 없음'})`);
    const rides = steps.filter((s) => s.type !== 'WALKING');
    const name = rides.length ? rides.map((s) => (s.type === 'BUS' ? '버스' : '지하철')).join(' + ') : '도보';
    const short = (ns) => (ns.length > 3 ? `${ns.slice(0, 3).join('·')}번 외 ${ns.length - 3}개` : `${ns.join('·')}번`);   // 카드 부제가 길어지지 않게 (단계별 안내에는 전체 노선)
    const sub = rides.map((s, i) => (s.type === 'BUS' ? short(i === 0 && p.board ? p.board.routeNos : p.namesOf(s))
      : `${stationName(s.stops[0])} → 1호선 → ${stationName(s.stops[s.stops.length - 1])}`)).join(' → ') || '도보';
    // busDir: 실제로 탈 버스의 방향 상태 — auto(공식 노선 자동 확인)·manual(수동 목록)·geometry·conflict·unknown (이전 'verified'는 auto·manual로 나눔)
    return build({ id: 'transit:' + p.key, kind: 'transit', name, sub, fare: kf, live: !!(bus && bus.catchable), bus, plan: p, busDir: dirInfo ? dirInfo.state : null, dirWhy: dirInfo ? dirInfo.why || null : null,
      fareNote: kf == null ? null : busFare != null ? `공식 요금 · ${bus.routeNo}번 기준` : p.fare.src === '공식 환승 규정' ? `공식 요금${p.fare.kakaoMatch ? '(카카오 요금과 일치)' : ''}${p.fare.cityOnly && p.route.steps.some((x) => x.type === 'BUS' && x.vehicles.some((v) => !CITY_TYPES().includes(v.type))) ? ' · 일반·마을버스 기준' : ''}` : p.fare.src || '카카오 안내 요금', ...status(no, unk) }, segs);
  };
  // 대중교통 길찾기를 못 쓸 때: 공대 3호관은 기존 고정 경로(108번 → 월평역), 다른 출발지는 직선거리 추정(노선 미확인)
  const legacyTransit = () => {
    const ids = SC.bus.stopIds || [], ars = (SC.bus.arsStops || []).map((x) => String(x.arsId)), hb = legacyHubObj;
    const bus = findBus({ routeNos: [SC.bus.routeNo], allow: (s) => (s.fixed ? ars.includes(String(s.arsId)) : !ids.length || ids.includes(s.id)), walkOf: (s) => walkMin(s.d) });
    const unk = [], no = [];
    const segs = bus ? [
      { type: 'walk', min: bus.walk, label: `${bus.stop.name}까지 도보`, note: `약 ${Math.round(bus.stop.d)}m` },
      { type: 'wait', min: bus.wait, label: `${SC.bus.routeNo}번 버스 대기`, live: bus.catchable, note: bus.catchable ? `실시간${bus.later ? ' · 뒤차' : ''}${prevTxt(bus.prevCnt)}` : `목록의 차는 모두 놓침 → 그 뒤 차(${SC.bus.headwayMin}분 간격) 가정` },
    ] : [
      { type: 'walk', min: 4, label: '정류장까지 도보', note: '근처 정류장 정보 없음 · 가정값' },
      { type: 'wait', min: SC.bus.fallbackWaitMin, label: `${SC.bus.routeNo}번 버스 대기`, note: '실시간 도착정보 없음 · 가정값' },
    ];
    if (!bus) unk.push('버스 도착정보 없음'); else if (!bus.catchable) unk.push('다음 버스 시각은 가정값');
    segs.push({ type: 'ride', min: SC.bus.rideMin, label: `${SC.bus.routeNo}번 버스`, note: `${SC.hub.name} 인근 하차` },
      { type: 'walk', min: SC.bus.walkToPlatformMin, label: '승강장까지 도보·역내 이동' });
    segs.push(...subwaySegs(segs, hb, unk, no), ...tailAtDest(unk));
    const z = subwayZone(hb.pair), fare = z ? F.busSubway['zone' + z.zone] : null;              // 시내버스 1회 + 도시철도 환승 (공식 환승운임표)
    unk.push(...fareUnk(hb, !!z));
    return build({ id: 'transit:legacy108', kind: 'transit', name: '버스 + 지하철', sub: `${SC.bus.routeNo}번 → ${SC.hub.name} → 1호선 → ${stName(DEST_ST)}`, fare, live: !!(bus && bus.catchable), bus,
      fareNote: z ? `시내버스+지하철 ${z.zone}구간 환승 (${z.src})` : null, ...status(no, unk) }, segs);
  };
  const estimateTransit = () => {
    const Fb = TR.fallback || { walkMin: 5, busKmh: 15 }, hb = legacyHubObj, unk = [st.planWhy || '대중교통 경로 미확인', '직선거리 추정', '환승역 미확인(기본 환승역 가정)', '요금 미확인'], no = [];
    const segs = [
      { type: 'walk', min: Fb.walkMin, label: '정류장까지 도보', note: '가정값' },
      { type: 'wait', min: SC.bus.fallbackWaitMin, label: '버스 대기', note: '가정값' },
      { type: 'ride', min: estMin(st.origin, hb, Fb.busKmh), label: '버스', note: `${hb.name}까지 직선거리 추정 · 노선 미확인` },
      { type: 'walk', min: TR.inStationMin || 3, label: '역내 이동·승강장까지', note: '가정값' },
    ];
    segs.push(...subwaySegs(segs, hb, unk, no), ...tailAtDest(unk));
    return build({ id: 'transit:estimate', kind: 'transit', name: '버스 + 지하철', sub: `→ ${hb.name} → 1호선 (추정)`, fare: null, live: false, ...status(no, unk) }, segs);
  };
  let transitAll = st.plans.length ? st.plans.map(evalPlan) : [legacy ? legacyTransit() : estimateTransit()];
  // 같은 경로(같은 key)는 하나만: 이용 가능 확인 → 빠른 도착 순으로 남김. 순서: 이용 불가는 뒤, 그다음 도착 시각
  const order = (a, b) => (a.avail === 'no') - (b.avail === 'no') || a.arrive - b.arrive;
  const okFirst = (a, b) => (a.avail !== 'ok') - (b.avail !== 'ok') || order(a, b);
  const uniq = new Map();
  for (const r of transitAll.slice().sort(okFirst)) if (!uniq.has(r.id)) uniq.set(r.id, r);
  transitAll = [...uniq.values()].sort(order);
  // 비교 기준: 실시간 정보를 반영한 일반 대중교통 후보 중 이용 가능이 확인되고 요금도 확인된 가장 빠른 경로 (없으면 비교·추천 보류)
  //   같은 분에 도착하면 요금이 싼 경로, 시간·요금이 같으면 기존 순서(정렬은 안정 정렬) — update12 최종
  const baseline = transitAll.filter((r) => r.avail === 'ok' && r.fare != null).sort(byArriveFare)[0] || null;
  let transitShown = transitAll.slice(0, RS.transitShow || 5);
  if (baseline && !transitShown.includes(baseline)) transitShown = [...transitShown.slice(0, (RS.transitShow || 5) - 1), baseline];   // 비교 기준은 항상 화면에

  // ---- 2) 전 구간 택시 ----
  const driveUnk = (d) => (!d ? ['택시 시간·요금 조회 실패 · 고정값'] : now - d.t > DRIVE_STALE_MS ? ['택시 정보가 오래됨 · 새로고침 필요'] : d.taxiFare == null ? ['택시 요금 미확인'] : []);
  const driveNote = (d, extra) => (d ? `카카오 길찾기 · ${clock(d.t)} 조회${extra || ''}` : null);
  const dDest = st.drive.dest;
  const taxi = build({ id: 'taxi', kind: 'taxi', name: '택시', sub: `${st.origin.name} → ${st.dest.name}`, fare: dDest ? dDest.taxiFare : SC.taxi.toDestFare, live: !!dDest, ...status([], driveUnk(dDest)) }, [
    { type: 'wait', min: SC.taxi.waitMin, label: '택시 호출·대기', note: '가정값' },
    { type: 'ride', min: dDest ? dDest.durationSec / 60 : SC.taxi.toDestMin, label: '택시 주행', live: !!dDest, note: driveNote(dDest, dDest ? ` · ${(dDest.distanceM / 1000).toFixed(1)}km` : '') || '고정값' },
  ]);

  // ---- 3) 전 구간 타슈 ----
  // 타슈 상태: 'ok' 자전거 있는 대여소 확인 / 'none' 근처 대여소에 0대 / 'unknown' 조회 실패·키 없음·오래됨
  const tLive = st.tashu && !st.tashu.mock && now - st.tashuAt <= TASHU_STALE_MS;
  const tStart = tLive ? st.tashu.stations.find((x) => x.bikes > 0) : null;
  const tState = !tLive ? 'unknown' : tStart ? 'ok' : 'none';
  const tNo = tState === 'none' ? ['근처 대여소에 자전거 없음'] : [];
  const tUnk = tState === 'unknown' ? ['타슈 대여 가능 여부 미확인'] : [];
  // 도보·자전거 길찾기 결과: 지금 출발 대여소 기준이고 정상 응답일 때만 사용 (반납 후 도보는 출발 대여소와 무관)
  const LG = st.legs || {}, sameT = tStart && LG.tStartId === tId(tStart);
  const leg = (name) => { const x = LG[name]; return x && x.v && (/^walkHub:/.test(name) || sameT) ? x : null; };
  const legStale = (...xs) => (xs.some((x) => x && now - x.t > ROUTE_STALE_MS) ? ['길찾기 정보가 오래됨 · 새로고침 필요'] : []);
  const kk = ' · 카카오 길찾기';
  const wS = leg('walkStart'), bD = leg('bikeDest');
  const tWalk = tStart
    ? { type: 'walk', min: wS ? secMin(wS.v.sec) : walkMin(tStart.d), label: `${tStart.name}까지 도보`, live: true, note: `자전거 ${tStart.bikes}대 · 실시간 · ${wS ? wS.v.m + 'm' + kk : tStart.d + 'm'}` }
    : { type: 'walk', min: T.walkMin, label: '타슈 대여소까지 도보', note: tState === 'none' ? '근처 대여소에 자전거 없음' : '대여소 정보 없음 · 가정값' };
  const bikeFrom = tStart || st.origin;
  const cUnk = [...tUnk, ...legStale(wS, bD)];
  const toDest = bD ? { min: secMin(bD.v.sec), note: `${LG.endDest.name}까지 · ${bD.v.m}m${kk}` }
    : legacy ? { min: T.toDestMin, note: `${st.dest.name} 인근 대여소까지 · 고정값` }
    : (cUnk.push('타슈 주행 직선거리 추정'), { min: estMin(bikeFrom, st.dest, T.estKmh || 13), note: `${st.dest.name} 인근까지 직선거리 추정` });
  const cFee = tashuFee(T.dockMin * 2 + toDest.min);
  if (!cFee.ok) cUnk.push(cFee.why);
  const tashu = build({ id: 'tashu', kind: 'tashu', name: '타슈 (공영자전거)', sub: '1시간 내 반납 시 무료 · 초과 30분당 500원', fare: cFee.fare, plus: true, ...status(tNo, cUnk) }, [
    tWalk, { type: 'dock', min: T.dockMin, label: '타슈 대여' },
    { type: 'ride', min: toDest.min, label: '타슈 주행', note: toDest.note }, { type: 'dock', min: T.dockMin, label: '타슈 반납', note: '반납 후 도보는 미포함' },
  ]);

  // ---- 4) 복합경로: 환승역 후보마다 타슈·택시 연계를 따로 계산 → 유형별 대표 1개 ----
  const hubs = hubCands();
  const hubUnkOf = (hb) => (hb.src === 'default' && !legacy ? ['환승역 미확인(기본 환승역 가정)'] : []);
  const isLegacyHub = (hb) => legacy && hb.stNum === SC.subway.stNum;   // 공대 3호관 → 월평역 고정값을 쓸 수 있는 경우
  const tashuMix = (hb) => {
    const unk = [...tUnk, ...hubUnkOf(hb)], no = [...tNo];
    const bH = leg('bikeHub:' + hb.stNum), wH = leg('walkHub:' + hb.stNum), endHub = (LG.endHub || {})[hb.stNum];
    unk.push(...legStale(wS, bH, wH));
    const toHub = bH ? { min: secMin(bH.v.sec), note: `${endHub ? endHub.name : hb.name + ' 인근 대여소'}까지 · ${bH.v.m}m${kk}` }
      : isLegacyHub(hb) ? { min: T.toHubMin, note: `${hb.name} 인근 대여소까지 · 고정값` }
      : (unk.push('타슈 주행 직선거리 추정'), { min: estMin(bikeFrom, endHub || hb, T.estKmh || 13), note: `${hb.name} 인근까지 직선거리 추정` });
    const hubWalk = wH ? { min: secMin(wH.v.sec) + (TR.inStationMin || 0), note: `반납 후 ${hb.name}까지 ${wH.v.m}m${kk} + 역내 ${TR.inStationMin || 0}분(가정)` }
      : isLegacyHub(hb) ? { min: T.hubWalkMin, note: '고정값' }
      : { min: (endHub ? walkMin(dist(endHub, hb)) : T.hubWalkMin) + (TR.inStationMin || 0), note: '가정값' };
    const segs = [tWalk, { type: 'dock', min: T.dockMin, label: '타슈 대여' },
      { type: 'ride', min: toHub.min, label: '타슈 주행', note: toHub.note }, { type: 'dock', min: T.dockMin, label: '타슈 반납' },
      { type: 'walk', min: hubWalk.min, label: '승강장까지 도보·역내 이동', note: hubWalk.note }];
    segs.push(...subwaySegs(segs, hb, unk, no), ...tailAtDest(unk));
    const fee = tashuFee(T.dockMin * 2 + toHub.min), sf = subFareOf(hb.pair);
    if (!fee.ok) unk.push(fee.why);
    unk.push(...fareUnk(hb, !!sf));
    return build({ id: 'tashuMix:' + hb.stNum, kind: 'tashuMix', mix: true, hub: hb, name: '타슈 + 지하철', sub: `타슈 → ${hb.name} → 1호선 → ${hb.alight.name}`,
      fare: sf ? sf.fare + fee.fare : null, live: !!tStart, fareNote: sf ? `지하철 ${sf.zone.zone}구간(${sf.zone.src})${fee.fare ? ` + 타슈 추가 ${won(fee.fare)}` : ''}` : null, ...status(no, unk) }, segs);
  };
  const taxiMix = (hb) => {
    const dHub = (st.drive.hub || {})[hb.stNum], unk = [...driveUnk(dHub), ...hubUnkOf(hb)], no = [];
    let ride;
    if (dHub) ride = { min: dHub.durationSec / 60, note: driveNote(dHub) };
    else if (isLegacyHub(hb)) ride = { min: SC.taxi.toHubMin, note: `${hb.name}까지 고정값` };
    else { unk.push('택시 직선거리 추정'); ride = { min: estMin(st.origin, hb, SC.taxi.estKmh || 25), note: `${hb.name}까지 직선거리 추정` }; }
    const segs = [{ type: 'wait', min: SC.taxi.waitMin, label: '택시 호출·대기', note: '가정값' },
      { type: 'ride', min: ride.min, label: '택시 주행', live: !!dHub, note: ride.note },
      { type: 'walk', min: SC.taxi.hubWalkMin, label: '승강장까지 도보·역내 이동' }];
    segs.push(...subwaySegs(segs, hb, unk, no), ...tailAtDest(unk));
    const taxiFare = dHub ? dHub.taxiFare : isLegacyHub(hb) ? SC.taxi.toHubFare : null, sf = subFareOf(hb.pair);
    if (taxiFare == null && !dHub) unk.push('택시 요금 미확인');
    unk.push(...fareUnk(hb, !!sf));
    return build({ id: 'taxiMix:' + hb.stNum, kind: 'taxiMix', mix: true, hub: hb, name: '택시 + 지하철', sub: `택시 → ${hb.name} → 1호선 → ${hb.alight.name}`,
      fare: taxiFare != null && sf ? taxiFare + sf.fare : null, fareNote: taxiFare != null && sf ? `택시 ${won(taxiFare)} + 지하철 ${sf.zone.zone}구간(${sf.zone.src})` : null, live: !!dHub, ...status(no, unk) }, segs);
  };
  // 유형별 대표 (update12 감사: 예산을 먼저 적용): 비교 기준이 있으면 예산(비교 기준 요금 + 추가 비용) 안에서 이용 가능·요금 확인된 가장 빠른 환승역 경로
  //   → 예산 안 후보가 없으면 이용 가능이 확인된 가장 빠른 경로를 '추가 비용 범위 초과'로 표시(추천 제외) → 그것도 없으면 이용 불가가 아닌 가장 빠른 것(가정값 포함)
  //   비교 기준이 없으면(예산을 정할 수 없음) 이용 가능이 확인된 가장 빠른 경로
  const cap = baseline ? (allow == null ? Infinity : baseline.fare + allow) : null;
  const fastest = (xs) => xs.slice().sort((a, b) => a.arrive - b.arrive)[0] || null;
  const rep = (cands) => {
    const inBudget = cap == null ? null : fastest(cands.filter((r) => r.avail === 'ok' && r.fare != null && r.fare <= cap));
    if (inBudget) return inBudget;
    const r = fastest(cands.filter((x) => x.avail === 'ok')) || cands.slice().sort(order)[0] || null;
    if (r && cap != null && r.avail === 'ok' && r.fare != null && r.fare > cap) r.overBudget = true;
    return r;
  };
  const mixT = hubs.map(tashuMix), mixX = hubs.map(taxiMix);
  const list = [...transitShown, taxi, tashu, rep(mixT), rep(mixX)].filter(Boolean).sort(order);
  if (baseline) baseline.baseline = true;
  return { list, baseline, transitAll, transitShown, hubs, mix: { tashu: mixT, taxi: mixX }, allow };
}
// 추천 (update12): 비교 기준 = 실시간 정보를 반영한 일반 대중교통 후보 중 이용 가능·시간·요금이 확인된 가장 빠른 경로
//   · 비교 기준이 없으면 추천 보류 (시간·요금 비교도 하지 않음)
//   · 예산 = 비교 기준 요금 + 사용자가 고른 추가 비용(0 · 3,000 · 7,000 · 상관없음, 기본 0)
//   · 화면의 경로 중 이용 가능이 확인되고 요금이 확인된 경로(전 구간 타슈의 '이상' 도착 제외) 가운데 예산 안에서 가장 빨리 도착하는 경로
//   · 비교 기준과 같은 분(반올림)에 도착하면 비교 기준 (시간 절감 없음)
/* ---------------- 지도 표시용 경로 모양 (update14 2단계 · 그리기는 3단계) ---------------- */
// 경로 카드 하나(r)를 지도에 그릴 수단별 선과 지점 표시로 바꿈. 시간·요금 계산과 무관하고, 외부 호출 없이 이미 받은 결과만 씀
//   (카카오 결과는 재사용 캐시 없음 정책 그대로 — 지금 화면에 있는 결과를 그리기만 함)
//   parts: [{ mode: 'walk'|'bus'|'subway'|'bike'|'taxi', pts: [{lat,lng}…], approx }]  approx=true: 좌표가 없어 두 지점을 직선으로 이은 구간(점선 표시용)
//   marks: [{ pt, kind: 'origin'|'dest'|'board'|'alight'|'dock', label }]
const SHAPE_NEAR_M = 30;                       // 이보다 가까우면 같은 지점으로 보고 잇는 선을 생략
const ptOf = (p) => ({ lat: Number(p.lat), lng: Number(p.lng) });
function nearestOnPath(p, pts) {              // 경로 위에서 p와 가장 가까운 점 (구간 투영, 평면 근사)
  const kx = Math.cos(p.lat * Math.PI / 180) * 111320, ky = 110540;
  let best = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = (pts[i].lng - p.lng) * kx, ay = (pts[i].lat - p.lat) * ky, bx = (pts[i + 1].lng - p.lng) * kx, by = (pts[i + 1].lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x, y);
    if (!best || d < best.d) best = { d, seg: i, pt: { lat: p.lat + y / ky, lng: p.lng + x / kx } };
  }
  return best;
}
// 환승역(hb) → 하차역 지하철 선: 같은 하차역으로 가는 카카오 경로의 지하철 구간 좌표 중 환승역에 가장 가까운 지점부터 잘라 씀
//   (1호선은 한 줄이라 더 먼 역에서 출발한 경로가 이 역을 지남). 경로 밖 역이면 가장 가까운 지점까지 직선(approx)으로 이음
function subwayShape(hb) {
  const from = ptOf(hb);
  let best = null;
  for (const p of st.plans) {
    if (!p.subStep || p.to !== hb.alight.stNum) continue;
    const pts = cleanPath(p.subStep.path); if (!pts) continue;
    const n = nearestOnPath(from, pts);
    if (n && (!best || n.d < best.n.d)) best = { n, pts };
  }
  if (!best) {
    const ap = (st.plans.find((p) => p.to === hb.alight.stNum && p.alight && validPt(p.alight.pt)) || {}).alight;
    const end = ap ? ap.pt : hb.alight.stNum === DEST_ST ? SC.dest : null;
    return validPt(end) ? [{ mode: 'subway', pts: [from, ptOf(end)], approx: true }] : [];
  }
  const out = [], { n, pts } = best;
  if (n.d > SHAPE_NEAR_M * 5) out.push({ mode: 'subway', pts: [from, n.pt], approx: true });
  out.push({ mode: 'subway', pts: [n.d > SHAPE_NEAR_M * 5 ? n.pt : from, n.pt, ...pts.slice(n.seg + 1)].filter((q, i, a) => i === 0 || q.lat !== a[i - 1].lat || q.lng !== a[i - 1].lng), approx: false });
  return out;
}
function routeShape(r) {
  if (!r || !validPt(st.origin) || !validPt(st.dest)) return null;
  const parts = [], marks = [];
  const last = () => { const q = parts[parts.length - 1]; return q ? q.pts[q.pts.length - 1] : ptOf(st.origin); };
  const line = (mode, path, a, b) => {                 // 카카오 좌표가 있으면 그것, 없으면 a→b 직선(approx)
    const pts = cleanPath(path);
    if (pts) { parts.push({ mode, pts, approx: false }); return; }
    if (validPt(a) && validPt(b) && dist(a, b) > SHAPE_NEAR_M) parts.push({ mode, pts: [ptOf(a), ptOf(b)], approx: true });
  };
  const link = (mode, b) => { if (validPt(b) && dist(last(), b) > SHAPE_NEAR_M) parts.push({ mode, pts: [last(), ptOf(b)], approx: true }); };   // 앞 구간 끝에서 b까지 이어 줌
  const mark = (p, kind, label) => { if (validPt(p)) marks.push({ pt: ptOf(p), kind, label }); };
  // 하차역 이후 목적지까지: 같은 하차역에서 내려 걷기만 하는 카카오 경로의 도보 좌표 → 그래도 멀면 직선
  const tail = () => {
    const p = st.plans.find((x) => x.to === DEST_ST && x.subStep && x.route.steps.slice(x.route.steps.indexOf(x.subStep) + 1).every((s) => s.type === 'WALKING'));
    if (p) for (const s of p.route.steps.slice(p.route.steps.indexOf(p.subStep) + 1)) { link('walk', s.start); line('walk', s.path, s.start, s.end); }
    link('walk', st.dest);
  };
  const subway = (hb) => {
    link('walk', hb);
    mark(hb, 'board', `${hb.name} 승차`);
    for (const q of subwayShape(hb)) parts.push(q);
    mark(last(), 'alight', `${hb.alight.name} 하차`);
  };
  const tStart = curTStart(), LG = st.legs || {}, sameT = !!tStart && LG.tStartId === tId(tStart);
  const legPath = (name) => { const x = LG[name]; return x && x.v && (/^walkHub:/.test(name) || sameT) ? x.v.path : null; };
  const busLbl = (s, p) => { const ns = (p && p.namesOf ? p.namesOf(s) : busNames(s)); return `${ns.length > 3 ? ns.slice(0, 3).join('·') + ' 외' : ns.join('·') || '버스'}번 승차`; };

  if (r.kind === 'transit' && r.plan) {
    const p = r.plan, steps = p.route.steps;
    if (p.walk0Pt) line('walk', p.walk0 && p.walk0.path, st.origin, p.walk0Pt);
    for (const s of steps) {
      const mode = s.type === 'BUS' ? 'bus' : s.type === 'SUBWAY' ? 'subway' : 'walk';
      if (mode !== 'walk') link('walk', s.start);
      if (s.type === 'BUS') mark(r.bus && r.bus.stop && s === p.boardStep && validPt(r.bus.stop) ? r.bus.stop : s.start, 'board', busLbl(s, p));
      if (s.type === 'SUBWAY') mark(s.start, 'board', `${stationName(s.stops[0])} 승차`);
      line(mode, s.path, s.start, s.end);
      if (s.type === 'SUBWAY') mark(s.end, 'alight', `${stationName(s.stops[s.stops.length - 1])} 하차`);
      else if (s.type === 'BUS') mark(s.end, 'alight', `${s.stops[s.stops.length - 1] || ''} 하차`);
    }
    link('walk', st.dest);
  } else if (r.kind === 'transit') {                  // 기존 고정 경로(108번)·직선 추정: 좌표가 없어 직선으로만
    const hb = { name: SC.hub.name, stNum: SC.subway.stNum, lat: SC.hub.lat, lng: SC.hub.lng, alight: { name: stName(DEST_ST), stNum: DEST_ST } };
    const stop = r.bus && r.bus.stop && validPt(r.bus.stop) ? r.bus.stop : null;
    if (stop) { link('walk', stop); mark(stop, 'board', `${r.bus.routeNo}번 승차`); }
    link('bus', hb);
    subway(hb); tail();
  } else if (r.kind === 'taxi') {
    const d = st.drive.dest;
    mark(st.origin, 'board', '택시 승차');
    line('taxi', d && d.path, st.origin, st.dest);
    link('walk', st.dest);
  } else if (r.kind === 'tashu' || r.kind === 'tashuMix') {
    if (tStart) {
      line('walk', legPath('walkStart'), st.origin, tStart);
      mark(tStart, 'dock', `대여 · ${tStart.name}`);
    }
    const from = tStart || st.origin;
    if (r.kind === 'tashu') {
      const end = LG.endDest && validPt(LG.endDest) ? LG.endDest : null;
      link('walk', from);
      line('bike', legPath('bikeDest'), from, end || st.dest);
      if (end) mark(end, 'dock', `반납 · ${end.name}`);
    } else {
      const hb = r.hub, end = (LG.endHub || {})[hb.stNum];
      link('walk', from);
      line('bike', legPath('bikeHub:' + hb.stNum), from, validPt(end) ? end : hb);
      if (validPt(end)) { mark(end, 'dock', `반납 · ${end.name}`); link('walk', end); line('walk', legPath('walkHub:' + hb.stNum), end, hb); }
      subway(hb); tail();
    }
  } else if (r.kind === 'taxiMix' && r.hub) {
    const d = (st.drive.hub || {})[r.hub.stNum];
    mark(st.origin, 'board', '택시 승차');
    line('taxi', d && d.path, st.origin, r.hub);
    subway(r.hub); tail();
  } else return null;
  if (!parts.length) return null;
  // 앞 구간 끝과 다음 구간 시작이 조금(30m 미만) 어긋나면 이어 붙임 (카카오 도보 끝·정류장 좌표 차이로 생기는 짧은 끊김)
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i - 1].pts[parts[i - 1].pts.length - 1], b = parts[i].pts[0];
    if ((a.lat !== b.lat || a.lng !== b.lng) && dist(a, b) < SHAPE_NEAR_M) parts[i] = { ...parts[i], pts: [a, ...parts[i].pts] };
  }
  // 표시 겹침 줄이기: 바로 다음 승차 지점(200m 이내)이 있는 하차 표시는 생략, 출발지와 같은 곳(30m 이내)의 승차 표시는 생략('출발' 표시와 겹침)
  const keep = marks.filter((k, i) => !(k.kind === 'alight' && marks.slice(i + 1).some((x) => x.kind === 'board' && dist(x.pt, k.pt) < 200))
    && !(k.kind === 'board' && dist(k.pt, st.origin) < SHAPE_NEAR_M));
  marks.length = 0; marks.push(...keep);
  marks.unshift({ pt: ptOf(st.origin), kind: 'origin', label: st.origin.name || '출발' });
  marks.push({ pt: ptOf(st.dest), kind: 'dest', label: st.dest.name || '도착' });
  return { parts, marks };
}
/* ---------------- 지도에 경로 그리기 (update14 3단계) ---------------- */
// 기본은 추천 경로(없으면 비교 기준 → 이용 가능한 첫 경로). 카드의 '지도에서 보기'로 바꿀 수 있음. 이용 불가 경로는 그리지 않음
const MODE_STYLE = { walk: { color: '#6b7280', weight: 4 }, bus: { color: '#ff5530', weight: 6 }, subway: { color: '#1456f0', weight: 6 }, bike: { color: '#12855a', weight: 6 }, taxi: { color: '#a855f7', weight: 6 } };
const MODE_NAME = { walk: '도보', bus: '버스', subway: '지하철', bike: '타슈', taxi: '택시' };
const MARK_CLS = { board: 'rb', alight: 'ra', dock: 'rd' };
const canDrawRoute = () => !!(MAP && MAP.kakao);
function mapRouteOf(list, best) {
  const usable = (r) => r && r.avail !== 'no';
  const sel = list.find((r) => r.id === st.mapSel);
  return (usable(sel) && sel) || (usable(best) && best) || list.find((r) => r.baseline && usable(r)) || list.find((r) => r.avail === 'ok') || null;
}
function clearRoute() {
  st.routeOverlays.forEach((o) => { try { o.remove(); } catch { /* 이미 지워짐 */ } });
  st.routeOverlays = []; st.mapSig = null;
}
function drawRoute(r) {
  if (!canDrawRoute() || !r) { clearRoute(); return null; }
  const sh = routeShape(r);
  if (!sh) { clearRoute(); return null; }
  const sig = r.id + '|' + JSON.stringify(sh);
  if (sig === st.mapSig) return sh;                       // 30초 갱신에서 모양이 같으면 다시 그리지 않음 (깜빡임 방지)
  clearRoute();
  const add = (o) => st.routeOverlays.push(o);
  for (const q of sh.parts) {                             // 흰 테두리 → 색 선 (approx: 좌표가 없어 직선으로 이은 구간은 점선·연하게)
    const m = MODE_STYLE[q.mode] || MODE_STYLE.walk;
    add(MAP.polyline(q.pts, { color: '#ffffff', weight: m.weight + 3, opacity: q.approx ? 0.5 : 0.9, z: 1 }));
    add(MAP.polyline(q.pts, { color: m.color, weight: m.weight, opacity: q.approx ? 0.6 : 0.95, dash: q.approx || q.mode === 'walk', z: 2 }));
  }
  for (const k of sh.marks) if (MARK_CLS[k.kind]) add(MAP.label(k.pt, MARK_CLS[k.kind], escapeHtml(k.label)));
  st.mapSig = sig;
  const fitKey = tripKey() + '|' + r.id;                  // 출발·목적지나 고른 경로가 바뀔 때만 지도 범위를 맞춤 (사용자가 옮긴 화면을 30초마다 되돌리지 않음)
  if (st.mapFitKey !== fitKey) { MAP.fit([...sh.parts.flatMap((q) => q.pts), st.origin, st.dest]); st.mapFitKey = fitKey; }
  return sh;
}
function showOnMap(id) {
  st.mapSel = id; st.mapFitKey = null;
  render();
  const m = $('#map');
  if (m && m.getBoundingClientRect && m.scrollIntoView && m.getBoundingClientRect().bottom < 60) m.scrollIntoView({ behavior: 'smooth', block: 'start' });   // 휴대폰에서 지도가 화면 위로 지나갔으면 올려서 보여 줌
}

const minsVs = (r, base) => Math.round((r.arrive - base.arrive) / 60000);
// 도착 시각(화면에 보이는 분) → 요금 순서 (같으면 원래 순서 유지)
const byArriveFare = (a, b) => Math.floor(a.arrive / 60000) - Math.floor(b.arrive / 60000) || (a.fare ?? Infinity) - (b.fare ?? Infinity);
function pickBest(list, allow = st.allow) {
  const base = list.find((r) => r.baseline);
  if (!base) return null;
  const cap = allow == null ? Infinity : base.fare + allow;
  const top = list.filter((r) => r.avail === 'ok' && r.fare != null && r.fare <= cap && !r.plus).sort(byArriveFare)[0];
  if (!top) return null;
  return top !== base && minsVs(top, base) < 0 ? top : base;
}

/* ---------------- 화면 ---------------- */
const KIND = { transit: '대중교통', taxi: '택시', tashu: '타슈', tashuMix: '타슈 연계', taxiMix: '택시 연계' };
function segBar(r, maxMin) {
  const segs = h('div', { class: 'segs' });
  r.steps.forEach((s) => segs.append(h('i', { class: s.live ? 'live' : null, style: `flex:${Math.max(s.min, 0.2)} 1 0;background:var(--${s.type})`, title: `${SEG[s.type]} ${Math.round(s.min)}분` })));
  return h('div', { class: 'track', style: `width:${Math.min(100, (r.total / maxMin) * 100)}%` }, segs);
}
function routeCard(r, rank, base, bestId, maxMin, mapId) {
  const off = r.avail === 'no', unk = r.avail === 'unknown';
  const fareTxt = (f) => (f == null ? '요금 미확인' : won(f));
  const pills = [];
  (r.why || []).forEach((w) => pills.push(h('span', { class: 'pill ' + (off ? 'bad' : 'warn') }, w)));
  // 시간·요금 비교는 모두 같은 비교 기준 경로로 (기준이 없으면 비교하지 않음)
  if (base && !r.baseline && !off) {
    const dmin = minsVs(r, base);
    pills.push(h('span', { class: 'pill ' + (dmin < 0 ? 'good' : dmin > 0 ? 'bad' : '') }, dmin === 0 ? '비교 기준과 같은 시각' : `비교 기준보다 ${Math.abs(dmin)}분 ${dmin < 0 ? '빠름' : '늦음'}${r.plus && dmin > 0 ? ' 이상' : ''}`));
    if (r.fare != null) { const extra = r.fare - base.fare; pills.push(h('span', { class: 'pill ' + (extra > 0 ? 'bad' : extra < 0 ? 'good' : '') }, extra === 0 ? '추가 비용 없음' : extra > 0 ? `추가 ${won(extra)}` : `${won(-extra)} 저렴`)); }
    if (r.overBudget) pills.push(h('span', { class: 'pill bad' }, `추가 비용 범위(${allowLabel(st.allow)}) 초과 · 추천 제외`));
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

  return h('article', { class: 'route' + (r.baseline ? ' base' : '') + (r.id === bestId ? ' best' : '') + (off ? ' off' : ''), 'data-kind': r.kind },
    h('div', { class: 'rh' }, h('span', { class: 'letter', title: '도착 순서' }, String(rank)), h('div', { class: 'rn' }, r.name, h('small', null, r.sub)),
      r.mix ? h('span', { class: 'tag mix' }, '복합경로') : h('span', { class: 'tag kind' }, KIND[r.kind]),
      r.live && r.avail === 'ok' ? h('span', { class: 'tag live' }, '실시간') : null,
      off ? h('span', { class: 'tag off' }, '이용 불가') : null,
      unk ? h('span', { class: 'tag assume' }, '가정값 포함') : null,
      r.baseline ? h('span', { class: 'tag base' }, '비교 기준') : null,
      r.id === bestId ? h('span', { class: 'tag best' }, '추천') : null),
    h('div', { class: 'nums' }, h('span', { class: 'arr' }, off ? '—' : clock(r.arrive) + (r.plus ? '+' : ''), h('small', null, off ? '이용 불가' : unk ? '도착(참고)' : '도착')),
      h('span', { class: 'mins' }, off ? '' : `${Math.round(r.total)}분${r.plus ? '+' : ''}`), h('span', { class: 'fare' }, fareTxt(r.fare))),
    off ? null : segBar(r, maxMin),
    h('div', { class: 'pills' }, pills),
    !off && canDrawRoute() ? h('button', { type: 'button', class: 'mapbtn' + (r.id === mapId ? ' on' : ''), 'aria-pressed': String(r.id === mapId), onclick: () => showOnMap(r.id) }, r.id === mapId ? '지도에 표시 중' : '지도에서 보기') : null,
    h('details', { open: st.open.has(r.id), ontoggle: (e) => { if (e.target.open) st.open.add(r.id); else st.open.delete(r.id); } }, h('summary', null, '단계별 시각 보기'), tl));
}
const allowLabel = (a) => (a == null ? '상관없음' : a === 0 ? '0원' : `+${won(a)}`);
// 추가 비용 직접 입력 (update12): 0 이상 정수(원), 쉼표·'원'·공백은 허용, 상한 scenario.js allowanceMax(기본 50,000원).
//   음수·소수·문자·빈값·상한 초과는 거절하고 직전 설정을 그대로 둠(입력값과 적용값 불일치 방지). 바꿔도 외부 API는 다시 부르지 않음(화면만 다시 그림)
const ALLOW_MAX = SC.allowanceMax || 50000;
function parseAllow(str) {
  const t = String(str == null ? '' : str).replace(/[,\s원]/g, '');
  if (!t) return { err: '추가 비용을 입력해 주세요' };
  if (!/^\d+$/.test(t)) return { err: '0 이상의 정수(원)로 입력해 주세요' };
  const v = Number(t);
  if (!Number.isSafeInteger(v) || v > ALLOW_MAX) return { err: `최대 ${won(ALLOW_MAX)}까지 입력할 수 있어요 (더 크면 '상관없음'을 고르세요)` };
  return { v };
}
function setAllowFixed(a) { st.allow = a; st.allowCustom = false; st.allowErr = null; render(); }
function setAllowCustom(str) {
  const r = parseAllow(str);
  st.allowInput = String(str == null ? '' : str);
  if (r.err) st.allowErr = r.err; else { st.allow = r.v; st.allowCustom = true; st.allowErr = null; }
  render();
  return r;
}
// 비교 기준에서 빠진 일반 대중교통 경로의 실제 원인 (경로마다 대표 원인 1개씩 세어 표시)
const EXCL = [[/운행 종료/, '지하철 운행 종료'], [/시각표 확인 실패/, '열차 시각표 확인 실패'], [/시각표/, '열차 시각표 불완전·없음'], [/도착정보 없음|정류장 연결|탑승 정류장/, '실시간 버스 도착정보 없음'],
  [/운행 방향|방향 추정|수동 확인|노선 ID|충돌/, '버스 운행 방향 확인 안 됨'], [/요금 미확인/, '요금 미확인'], [/환승 버스 대기|다음 버스 시각/, '환승 대기·다음 버스 가정값 포함']];
function exclusionText(transitAll) {
  const cnt = {};
  for (const r of transitAll || []) {
    if (r.avail === 'ok' && r.fare != null) continue;
    const why = r.avail === 'ok' ? ['요금 미확인'] : r.why || [];
    const hit = EXCL.find(([re]) => why.some((w) => re.test(w)));
    const k = hit ? hit[1] : '기타 데이터 불완전';
    cnt[k] = (cnt[k] || 0) + 1;
  }
  const t = Object.entries(cnt).map(([k, v]) => `${k} ${v}개`).join(' · ');
  return t ? ` 제외 원인: ${t}` : '';
}
function renderCompare(c) {
  if (!supported()) {
    clearRoute();
    const names = SC.origins.map((p) => p.name).join(' · ');
    c.append(h('div', { class: 'empty' }, h('b', null, `지금은 지원 출발지(${names}) ${R / 1000}km 안 → ${SC.dest.name} 구간만 비교할 수 있어요.`),
      h('p', { style: 'margin:6px 0 10px' }, '위의 출발지 버튼을 누르거나, 다른 위치는 "주변 정류장 실시간" 탭에서 버스 도착정보를 볼 수 있습니다. 대전 전역 경로 비교는 다음 단계에서 추가됩니다.'),
      h('button', { class: 'pm on', onclick: () => { st.dest = { ...SC.dest }; setPoint('origin', { ...SC.origin }); } }, '기본 구간으로 돌아가기')));
    return;
  }
  const { list, baseline, hubs, transitAll } = computeRoutes(st.allow);
  const best = pickBest(list, st.allow);
  const onMap = mapRouteOf(list, best);
  const maxMin = Math.max(60, ...list.filter((r) => r.avail !== 'no').map((r) => r.total));
  const allowBox = h('div', { class: 'allow', role: 'group', 'aria-label': '추가 비용 허용 범위' }, h('span', null, '추가 비용'),
    ...(SC.allowances || [0]).map((a) => { const on = !st.allowCustom && st.allow === a; return h('button', { type: 'button', class: 'pm' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => setAllowFixed(a) }, allowLabel(a)); }),
    h('form', { class: 'allow-in' + (st.allowCustom ? ' on' : ''), onsubmit: (e) => { e.preventDefault(); const f = e.target.elements && e.target.elements.amt; setAllowCustom(f ? f.value : ''); } },
      h('input', { name: 'amt', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '9', placeholder: '직접 입력', 'aria-label': `추가 비용 직접 입력 (원, 최대 ${won(ALLOW_MAX)})`, 'aria-invalid': st.allowErr ? 'true' : null, value: st.allowInput || null }),
      h('span', null, '원'), h('button', { type: 'submit', class: 'pm' + (st.allowCustom ? ' on' : ''), 'aria-pressed': String(st.allowCustom) }, '적용')));
  const allowErr = st.allowErr ? h('p', { class: 'err allow-err', role: 'alert' }, `${st.allowErr} · 지금 적용 중: ${allowLabel(st.allow)}`) : null;
  const noBest = baseline ? null
    : list.every((r) => r.avail === 'no') ? '지금은 이용할 수 있는 경로가 없어요. (지하철 운행 종료·타슈 자전거 없음)'
    : `실시간 정보와 요금이 확인된 일반 대중교통 경로가 없어 비교 기준을 정할 수 없어요. 시간·요금 비교와 추천을 보류해요 (아래 경로는 참고용으로 볼 수 있어요).${exclusionText(transitAll)}`;
  const transitCnt = list.filter((r) => r.kind === 'transit').length;
  const hubNames = hubs.map((hb) => hb.name).join(' · ');
  // 조건부 요소는 null을 걸러 붙임 (브라우저 append(null)은 'null' 글자를 화면에 붙임 — update12 수정)
  c.append(...[
    allowBox, allowErr,
    h('p', { class: 'hint' }, baseline
      ? `지금(${clock(Date.now())}) 출발 기준 · 추천: 지금 이용할 수 있다고 확인된 경로 중 비교 기준(가장 빠른 확인된 대중교통 ${won(baseline.fare)}) + 추가 비용 ${allowLabel(st.allow)}${st.allowCustom ? '(직접 입력)' : ''} 안에서 가장 빨리 도착하는 경로`
      : `지금(${clock(Date.now())}) 출발 기준`),
    noBest ? h('p', { class: 'banner' }, noBest) : null,
    h('div', { class: 'legend' }, ...['walk', 'wait', 'ride', 'dock', 'sub'].map((k) => h('span', null, h('i', { style: `background:var(--${k})` }), SEG[k]))),
    canDrawRoute() && onMap ? h('p', { class: 'hint maplegend' }, h('b', null, `지도: ${onMap.id === (best && best.id) ? '추천 경로' : onMap.name}`),
      ...['walk', 'bus', 'subway', 'bike', 'taxi'].map((k) => h('span', null, h('i', { style: `background:${MODE_STYLE[k].color}` }), MODE_NAME[k])), h('span', null, '점선: 도보·좌표 없는 구간(직선)')) : null,
    ...list.map((r, i) => routeCard(r, i + 1, baseline, best && best.id, maxMin, onMap && onMap.id)),
    h('p', { class: 'note' }, st.plans.length
      ? `일반 대중교통: 카카오 대중교통 길찾기 경로 ${st.routeCount}개에서 같은 경로를 합치고, ${st.plans.length}개를 실시간 버스 도착·열차 시각표로 다시 계산해 도착 순 ${transitCnt}개를 보여 줘요 (카카오 전체 소요시간은 쓰지 않음).`
      : `${st.planWhy || '대중교통 길찾기 정보 없음'} → ${legacyOrigin() ? `기존 고정 경로(${SC.bus.routeNo}번 → ${SC.hub.name})` : `기본 환승역(${SC.hub.name}) 기준 추정`}으로 계산했어요.`),
    h('p', { class: 'note' }, `복합경로: 출발지 반경 ${(RS.hubRadiusM || 4000) / 1000}km 지하철역과 카카오 경로의 승차역 중 ${hubNames}을(를) 환승역 후보로, 타슈·택시 연계 경로를 따로 계산하고, 유형별로 추가 비용 범위 안에서 가장 빨리 도착하는(이용 가능·요금 확인) 경로를 하나씩 보여 줘요 (범위 안 경로가 없으면 가장 빠른 경로를 '범위 초과'로 표시).${st.hubsWhy ? ` (${st.hubsWhy})` : ''}`),
    st.origin.verified === false ? h('p', { class: 'note' }, `출발지 '${st.origin.name}' 좌표는 아직 확인 전이에요${st.origin.from ? ` (카카오 장소 검색 1순위: ${st.origin.from})` : ''}.`) : null,
    h('p', { class: 'note' }, `지하철은 대전교통공사 열차시각표(평일·휴일, 역 구간별) 기준이고 공휴일은 평일 시각표로 계산돼요. 버스 방향은 국토교통부 버스노선정보의 경유 정류장 순서로 자동 확인하고(실시간 차량의 노선 ID까지 대조), 자동 확인이 안 되면 팀이 확인한 노선·정류장 목록에 있을 때만 '확인됨'이에요. 역내 이동·택시 호출 대기·타슈 대여/반납은 가정값입니다.`),
  ].filter(Boolean));
  drawRoute(onMap);
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
  const hlRoutes = (st.plans.length ? st.plans.flatMap((p) => (p.board ? p.board.routeNos : [])) : [SC.bus.routeNo]).map(norm);   // 대중교통 후보에서 타는 노선 강조
  for (const s of [...st.stops, ...st.extraStops]) {
    const a = st.arr[s.id], walk = walkMin(s.d);
    const rows = !a ? [h('li', null, h('span', { class: 'when' }, '불러오는 중…'))]
      : a.err ? [h('li', null, h('span', { class: 'err' }, a.err))]
      : !a.list.length ? [h('li', null, h('span', { class: 'when' }, '도착 예정 버스 없음'))]
      : a.list.slice(0, 6).map((b) => {
        const rem = remainSec(b, a.at), m = Math.floor(rem / 60), ok = catchOk(rem / 60, walk);
        return h('li', null, h('span', { class: 'rno' + (hlRoutes.includes(norm(b.routeNo)) ? ' hl' : '') }, b.routeNo),
          h('span', { class: 'when' }, h('b', null, rem < 60 ? '곧 도착' : `${m}분 후`), prevOk(b.prevCnt) ? h('small', null, `${Number(b.prevCnt)}정거장 전`) : null),
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
  if (st.tab !== 'compare') clearRoute();             // 주변 정류장 탭에서는 경로 선을 지움
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
  await loadStops();
  setInterval(() => { if (document.visibilityState === 'visible') loadArrivals(); }, REFRESH_MS);
  setInterval(() => { if (document.visibilityState === 'visible') render(); }, 10000);
}
start();
})();
