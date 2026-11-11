(function () {
'use strict';
const SC = window.SCENARIO;
const SEG = { walk: '도보', wait: '대기', ride: '버스·택시·타슈', dock: '타슈 대여·반납', sub: '지하철' };
const REFRESH_MS = 30000;

const st = {
  origin: { ...SC.origin }, dest: { ...SC.dest }, pick: 'origin', tab: 'compare',
  stops: [], stopsErr: null, arr: {}, drive: {}, cfg: { mock: true, drive: false }, loading: false, updated: null,
  map: null, overlays: {}, stopOverlays: [], open: new Set(),
};
const $ = (s) => document.querySelector(s);
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
function setPoint(which, p, keepView) {
  st[which] = p;
  $('#oName').textContent = st.origin.name; $('#dName').textContent = st.dest.name;
  drawPoints(!keepView);
  if (which === 'origin') loadStops();
  else loadDrives().then(render);
}
function setPick(which) {
  st.pick = which;
  $('#pickOrigin').classList.toggle('on', which === 'origin'); $('#pickOrigin').setAttribute('aria-pressed', which === 'origin');
  $('#pickDest').classList.toggle('on', which === 'dest'); $('#pickDest').setAttribute('aria-pressed', which === 'dest');
}

/* ---------------- 데이터 ---------------- */
async function loadStops() {
  st.stopsErr = null; st.stopsNote = null; st.loading = true; render();
  try {
    const r = await api('/api/stops', { lat: st.origin.lat.toFixed(6), lng: st.origin.lng.toFixed(6) });
    st.stops = r.stops.map((s) => ({ ...s, d: dist(st.origin, s) })).filter((s) => s.d <= 600).sort((a, b) => a.d - b.d).slice(0, 8);
    drawStops();
    await loadArrivals();
  } catch (e) {
    // 근처 정류장 API가 안 될 때(미승인 등): scenario.js에 적어 둔 정류장 번호로 대전시 도착정보 사용
    const fixed = (SC.bus.arsStops || []).filter((x) => x.arsId);
    if (fixed.length) {
      st.stops = fixed.map((x) => ({ id: 'ars' + x.arsId, arsId: String(x.arsId), no: String(x.arsId), name: x.name || `정류장 ${x.arsId}`, lat: x.lat, lng: x.lng, fixed: true }))
        .map((x) => ({ ...x, d: x.lat && x.lng ? dist(st.origin, x) : 300 }));
      st.stopsNote = `근처 정류장 찾기 API를 쓸 수 없어 scenario.js에 지정한 정류장 ${fixed.length}곳의 도착정보를 보여 줘요. (${e.message})`;
      drawStops();
      await loadArrivals();
    } else { st.stops = []; st.stopsErr = e.message; await Promise.all([loadDrives(), loadTashu()]); }
  } finally { st.loading = false; render(); }
}
async function loadArrivals() {
  await Promise.all(st.stops.map(async (s) => {
    try {
      let r = await (s.arsId ? api('/api/arrivals-dj', { arsId: s.arsId }) : api('/api/arrivals', { nodeId: s.id }).catch((e) => { if (!s.no) throw e; return { list: [] }; }));
      if (!s.arsId && !r.list.length && s.no && !r.mock) r = await api('/api/arrivals-dj', { arsId: s.no }); // TAGO가 비면 대전시 API로 보조 조회
      st.arr[s.id] = { ...r, err: null };
    }
    catch (e) { st.arr[s.id] = { list: [], at: Date.now(), err: e.message }; }
  }));
  st.updated = Date.now();
  await Promise.all([loadDrives(), loadTashu()]);
  drawStops();
  render();
}
async function loadSubway() {
  try { st.subway = await api('/api/subway', { from: SC.subway.stNum, to: SC.subway.destStNum }); }
  catch (e) { st.subway = null; console.warn('열차시각표:', e.message); }
}
async function loadTashu() {
  if (!st.cfg.tashu && !st.cfg.mock) { st.tashu = null; return; }
  try { st.tashu = await api('/api/tashu', { lat: st.origin.lat.toFixed(6), lng: st.origin.lng.toFixed(6) }); st.tashuErr = null; }
  catch (e) { st.tashu = null; st.tashuErr = e.message; }
}
async function loadDrives() {
  if (!st.cfg.drive) return;
  const pairs = { dest: [st.origin, st.dest], hub: [st.origin, SC.hub] };
  await Promise.all(Object.entries(pairs).map(async ([k, [o, d]]) => {
    try { st.drive[k] = await api('/api/drive', { olat: o.lat, olng: o.lng, dlat: d.lat, dlng: d.lng }); }
    catch { st.drive[k] = null; }
  }));
}

/* ---------------- 경로 계산 ---------------- */
// 승강장 도착 시각(ms) → 탈 열차. 시각표가 있으면 대전교통공사 시각표, 없으면 '기준 시각 + 간격' 가정
function subwayNext(platformMs) {
  const d = new Date(platformMs);
  let t = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  if (t < 240) t += 1440;                      // 자정 이후는 전날 시각표의 24시대
  const tb = t + (SC.bufferMin || 0);          // 승강장 도착 후 최소 여유 이후 열차만 탑승
  const tt = st.subway && !st.subway.mock && st.subway.days;
  if (tt) {
    const wd = new Date(platformMs - (t >= 1440 ? 86400000 : 0)).getDay();
    const day = wd === 0 || wd === 6 ? SC.subway.dayHoliday : SC.subway.dayWeekday;
    const set = tt[day] && tt[day][SC.subway.dir];
    if (set && set.from.length) {
      const dep = set.from.find((x) => x >= tb - 1e-9);
      if (dep == null) return { wait: 0, ride: SC.subway.rideMin, dep: null, table: true, ended: true };
      const fromTable = !!set.ride;
      return { wait: dep - t, ride: fromTable ? set.ride : SC.subway.rideMin, dep, table: true, rideTable: fromTable, holiday: day === SC.subway.dayHoliday };
    }
  }
  const [ah, am] = SC.subway.anchor.split(':').map(Number);
  const a = ah * 60 + am, hw = SC.subway.headwayMin;
  const next = a + Math.ceil((tb - a) / hw - 1e-9) * hw;
  return { wait: next - t, ride: SC.subway.rideMin, dep: next, table: false };
}
function findBus() {
  const ids = SC.bus.stopIds;
  let best = null;
  for (const s of st.stops) {
    if (ids.length && !s.fixed && !ids.includes(s.id)) continue;
    const a = st.arr[s.id]; if (!a || !a.list) continue;
    for (const bus of a.list.filter((x) => x.routeNo === SC.bus.routeNo)) {
      const walk = walkMin(s.d), rem = remainSec(bus, a.at) / 60;
      const catchable = rem >= walk + (SC.bufferMin || 0);
      const wait = catchable ? rem - walk : rem + SC.bus.headwayMin - walk;
      const total = walk + wait;
      if (!best || total < best.total) best = { stop: s, walk, wait, catchable, total, prevCnt: bus.prevCnt };
    }
  }
  return best;
}
function build(key, name, sub, segs, fare, opts = {}) {
  let t = Date.now();
  const steps = segs.map((s) => { const start = t; t += s.min * 60000; return { ...s, start }; });
  return { key, name, sub, steps, fare, arrive: t, total: (t - Date.now()) / 60000, ...opts };
}
function computeRoutes() {
  const now = Date.now(), list = [];
  const subwayTail = (startMs, before) => {
    const used = before.reduce((a, s) => a + s.min, 0);
    const n = subwayNext(startMs + used * 60000);
    const depClock = clock(startMs + (used + n.wait) * 60000);
    const waitNote = n.ended ? '시각표상 오늘 열차 운행이 끝났어요'
      : n.table ? `${SC.hub.name} ${depClock} 출발 · ${n.holiday ? '휴일' : '평일'} 시각표`
      : `${SC.hub.name} 출발 ${depClock} 열차 (간격 ${SC.subway.headwayMin}분 가정)`;
    return [{ type: 'wait', min: n.wait, label: '열차 대기', note: waitNote },
      { type: 'sub', min: n.ride, label: '지하철 1호선', note: `${SC.hub.name} → ${SC.dest.name}${n.rideTable ? ' · 시각표 기준' : ''}` }];
  };

  // A 버스 + 지하철 (버스 대기 = 실시간)
  const bus = findBus();
  const aHead = bus ? [
    { type: 'walk', min: bus.walk, label: `${bus.stop.name}까지 도보`, note: `약 ${Math.round(bus.stop.d)}m` },
    { type: 'wait', min: bus.wait, label: `${SC.bus.routeNo}번 버스 대기`, live: bus.catchable, note: bus.catchable ? `실시간 · ${bus.prevCnt}정거장 전` : `곧 오는 차는 걸어가면 놓침 → 다음 차(${SC.bus.headwayMin}분 간격) 가정` },
  ] : [
    { type: 'walk', min: 4, label: '정류장까지 도보', note: '근처 정류장 정보 없음 · 가정값' },
    { type: 'wait', min: SC.bus.fallbackWaitMin, label: `${SC.bus.routeNo}번 버스 대기`, note: '실시간 도착정보 없음 · 가정값' },
  ];
  aHead.push({ type: 'ride', min: SC.bus.rideMin, label: `${SC.bus.routeNo}번 버스`, note: `${SC.hub.name} 인근 하차` },
    { type: 'walk', min: SC.bus.walkToPlatformMin, label: '승강장까지 도보·역내 이동' });
  list.push(build('A', '버스 + 지하철', `${SC.bus.routeNo}번 → ${SC.hub.name} → 지하철`, [...aHead, ...subwayTail(now, aHead)], SC.fare.busSubway, { base: true, live: !!(bus && bus.catchable) }));

  // B 택시
  const dDest = st.drive.dest;
  list.push(build('B', '전 구간 택시', `${st.origin.name} → ${st.dest.name}`, [
    { type: 'wait', min: SC.taxi.waitMin, label: '택시 호출·대기', note: '가정값' },
    { type: 'ride', min: dDest ? dDest.durationSec / 60 : SC.taxi.toDestMin, label: '택시 주행', live: !!dDest, note: dDest ? `카카오 길찾기 · ${(dDest.distanceM / 1000).toFixed(1)}km` : '고정값' },
  ], dDest && dDest.taxiFare ? dDest.taxiFare : SC.taxi.toDestFare, { live: !!dDest }));

  // D 타슈 + 지하철
  const T = SC.tashu;
  // 타슈 실시간: 자전거가 1대 이상 있는 가장 가까운 대여소
  const tStart = st.tashu && !st.tashu.mock ? st.tashu.stations.find((x) => x.bikes > 0) : null;
  const tWalk = tStart
    ? { type: 'walk', min: walkMin(tStart.d), label: `${tStart.name}까지 도보`, live: true, note: `자전거 ${tStart.bikes}대 · 실시간 · ${tStart.d}m` }
    : { type: 'walk', min: T.walkMin, label: '타슈 대여소까지 도보', note: st.tashu && !st.tashu.mock ? '근처 대여소에 자전거 없음 · 가정값' : '가정값' };
  const dHead = [
    tWalk, { type: 'dock', min: T.dockMin, label: '타슈 대여' },
    { type: 'ride', min: T.toHubMin, label: '타슈 주행', note: `${SC.hub.name} 인근 대여소까지` }, { type: 'dock', min: T.dockMin, label: '타슈 반납' },
    { type: 'walk', min: T.hubWalkMin, label: '승강장까지 도보·역내 이동' },
  ];
  list.push(build('D', '타슈 + 지하철', `타슈 → ${SC.hub.name} → 지하철`, [...dHead, ...subwayTail(now, dHead)], SC.fare.busSubway, { live: !!tStart, noBike: !!(st.tashu && !st.tashu.mock && !tStart) }));

  // E 택시 + 지하철
  const dHub = st.drive.hub;
  const eHead = [
    { type: 'wait', min: SC.taxi.waitMin, label: '택시 호출·대기', note: '가정값' },
    { type: 'ride', min: dHub ? dHub.durationSec / 60 : SC.taxi.toHubMin, label: '택시 주행', live: !!dHub, note: dHub ? '카카오 길찾기' : `${SC.hub.name}까지 고정값` },
    { type: 'walk', min: SC.taxi.hubWalkMin, label: '승강장까지 도보·역내 이동' },
  ];
  list.push(build('E', '택시 + 지하철', `택시 → ${SC.hub.name} → 지하철`, [...eHead, ...subwayTail(now, eHead)],
    (dHub && dHub.taxiFare ? dHub.taxiFare : SC.taxi.toHubFare) + SC.fare.busSubway, { live: !!dHub }));

  // C 전 구간 타슈
  list.push(build('C', '전 구간 타슈', '60분 내 반납 시 무료', [
    tWalk, { type: 'dock', min: T.dockMin, label: '타슈 대여' },
    { type: 'ride', min: T.toDestMin, label: '타슈 주행', note: `${st.dest.name} 인근 대여소까지` }, { type: 'dock', min: T.dockMin, label: '타슈 반납', note: '반납 후 도보는 미포함' },
  ], T.fare, { plus: true }));

  return { list, bus };
}

/* ---------------- 화면 ---------------- */
function segBar(r, maxMin) {
  const segs = h('div', { class: 'segs' });
  r.steps.forEach((s) => segs.append(h('i', { class: s.live ? 'live' : null, style: `flex:${Math.max(s.min, 0.2)} 1 0;background:var(--${s.type})`, title: `${SEG[s.type]} ${Math.round(s.min)}분` })));
  return h('div', { class: 'track', style: `width:${Math.min(100, (r.total / maxMin) * 100)}%` }, segs);
}
function routeCard(r, base, bestKey, maxMin) {
  const dmin = Math.round((r.arrive - base.arrive) / 60000), extra = r.fare - base.fare;
  const pills = [];
  if (!r.base) {
    pills.push(h('span', { class: 'pill ' + (dmin < 0 ? 'good' : dmin > 0 ? 'bad' : '') }, dmin === 0 ? '버스+지하철과 같은 시각' : `버스+지하철보다 ${Math.abs(dmin)}분 ${dmin < 0 ? '일찍' : '늦게'}${r.plus && dmin > 0 ? ' 이상' : ''}`));
    pills.push(h('span', { class: 'pill ' + (extra > 0 ? 'bad' : extra < 0 ? 'good' : '') }, extra === 0 ? '추가 요금 없음' : (extra > 0 ? '+' : '') + won(extra)));
  }
  if (r.noBike) pills.unshift(h('span', { class: 'pill bad' }, '근처 대여소 자전거 없음'));
  const waitSum = r.steps.filter((s) => s.type === 'wait').reduce((a, s) => a + s.min, 0);
  pills.push(h('span', { class: 'pill' }, `기다림 ${Math.round(waitSum)}분`));

  const tl = h('ol', { class: 'tl' });
  r.steps.forEach((s) => tl.append(h('li', null, h('time', null, clock(s.start)),
    h('div', { class: 'rail' }, h('b', { style: `background:var(--${s.type})` }), h('s', { style: `background:var(--${s.type})` })),
    h('div', { class: 'w' }, h('b', null, s.label, s.live ? h('span', { class: 'live-mark' }, ' · 실시간') : null),
      h('span', null, `${Math.round(s.min)}분${s.note ? ' · ' + s.note : ''}`)))));
  tl.append(h('li', null, h('time', null, clock(r.arrive)), h('div', { class: 'rail' }, h('b', { style: 'background:var(--ink)' })),
    h('div', { class: 'w' }, h('b', null, `${st.dest.name} 도착`), h('span', null, `총 ${Math.round(r.total)}분 · ${won(r.fare)}`))));

  return h('article', { class: 'route' + (r.base ? ' base' : '') + (r.key === bestKey ? ' best' : '') },
    h('div', { class: 'rh' }, h('span', { class: 'letter' }, r.key), h('div', { class: 'rn' }, r.name, h('small', null, r.sub)),
      r.live ? h('span', { class: 'tag live' }, '실시간') : null,
      r.base ? h('span', { class: 'tag base' }, '기준') : null,
      r.key === bestKey ? h('span', { class: 'tag best' }, '추천') : null),
    h('div', { class: 'nums' }, h('span', { class: 'arr' }, clock(r.arrive) + (r.plus ? '+' : ''), h('small', null, '도착')),
      h('span', { class: 'mins' }, `${Math.round(r.total)}분${r.plus ? '+' : ''}`), h('span', { class: 'fare' }, won(r.fare))),
    segBar(r, maxMin),
    h('div', { class: 'pills' }, pills),
    h('details', { open: st.open.has(r.key), ontoggle: (e) => { if (e.target.open) st.open.add(r.key); else st.open.delete(r.key); } }, h('summary', null, '단계별 시각 보기'), tl));
}
function renderCompare(c) {
  const offO = dist(st.origin, SC.origin), offD = dist(st.dest, SC.dest);
  if (offO > 1000 || offD > 1000) {
    c.append(h('div', { class: 'empty' }, h('b', null, `지금은 '${SC.name}' 구간만 비교할 수 있어요.`),
      h('p', { style: 'margin:6px 0 10px' }, '다른 위치는 아래 "주변 정류장 실시간" 탭에서 버스 도착정보를 볼 수 있습니다. 대전 전역 경로 비교는 다음 단계에서 추가됩니다.'),
      h('button', { class: 'pm on', onclick: () => { st.origin = { ...SC.origin }; st.dest = { ...SC.dest }; setPoint('origin', st.origin); } }, '기본 구간으로 돌아가기')));
    return;
  }
  const { list, bus } = computeRoutes();
  const base = list.find((r) => r.base);
  const limitFare = base.fare; // 추천: 추가 요금 없는 경로 중 가장 빨리 도착
  const best = list.filter((r) => r.fare <= limitFare && !r.plus).sort((a, b) => a.arrive - b.arrive)[0];
  const maxMin = Math.max(60, ...list.map((r) => r.total));
  const others = list.filter((r) => !r.base).sort((a, b) => a.arrive - b.arrive);
  c.append(
    h('p', { class: 'hint' }, `지금(${clock(Date.now())}) 출발 기준 · 추천은 버스+지하철 요금 안에서 가장 빨리 도착하는 경로`),
    h('div', { class: 'legend' }, ...['walk', 'wait', 'ride', 'dock', 'sub'].map((k) => h('span', null, h('i', { style: `background:var(--${k})` }), SEG[k]))),
    routeCard(base, base, best && best.key, maxMin),
    ...others.map((r) => routeCard(r, base, best && best.key, maxMin)),
    h('p', { class: 'note' }, bus
      ? `${SC.bus.routeNo}번 실시간 정보: ${bus.stop.name} (${bus.stop.fixed ? '번호 ' + bus.stop.arsId : bus.stop.id})${SC.bus.stopIds.length || bus.stop.fixed ? '' : ' · 방향 미지정 — scenario.js의 stopIds에 월평역 방면 정류장 ID를 넣으세요'}`
      : `근처 정류장에서 ${SC.bus.routeNo}번 도착정보를 찾지 못해 버스 대기는 가정값입니다.`),
    h('p', { class: 'note' }, `${st.subway && st.subway.days ? '지하철은 대전교통공사 열차시각표(평일·휴일) 기준입니다. 공휴일은 평일 시각표로 계산돼요.' : `지하철 시각표를 불러오지 못해 ${SC.subway.anchor} 기준 ${SC.subway.headwayMin}분 간격으로 가정했습니다.`} 도보·타슈·역내 이동은 실측 전 고정값입니다.${st.cfg.drive ? '' : ' 택시는 고정값입니다.'}`));
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
  for (const s of st.stops) {
    const a = st.arr[s.id], walk = walkMin(s.d);
    const rows = !a ? [h('li', null, h('span', { class: 'when' }, '불러오는 중…'))]
      : a.err ? [h('li', null, h('span', { class: 'err' }, a.err))]
      : !a.list.length ? [h('li', null, h('span', { class: 'when' }, '도착 예정 버스 없음'))]
      : a.list.slice(0, 6).map((b) => {
        const rem = remainSec(b, a.at), m = Math.floor(rem / 60), ok = catchOk(rem / 60, walk);
        return h('li', null, h('span', { class: 'rno' + (b.routeNo === SC.bus.routeNo ? ' hl' : '') }, b.routeNo),
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
  try { places = (await api('/api/search', { q })).places; }
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
  $('#pickOrigin').onclick = () => setPick('origin');
  $('#pickDest').onclick = () => setPick('dest');
  $('#tabCompare').onclick = () => { st.tab = 'compare'; render(); };
  $('#tabStops').onclick = () => { st.tab = 'stops'; render(); };
  $('#refresh').onclick = () => loadStops();
  $('#swap').onclick = () => { const o = st.origin; st.origin = st.dest; st.dest = o; setPoint('origin', st.origin); };
  $('#searchForm').onsubmit = (e) => { e.preventDefault(); const q = $('#q').value.trim(); if (q) search(q); };
  $('#myLoc').onclick = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => setPoint('origin', { name: '내 위치', lat: p.coords.latitude, lng: p.coords.longitude }),
      () => { const b = $('#banner'); b.hidden = false; b.textContent = '위치 권한이 없어 현재 위치를 가져오지 못했어요.'; }, { enableHighAccuracy: true, timeout: 8000 });
  };

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
