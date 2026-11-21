// 오프라인 검증: 실제 외부 API를 부르지 않습니다 (모의 fetch만 사용). 실행: node tests/offline.cjs
// update10: U10/S10 항목(출발지 확대·카카오 대중교통/도보/자전거 길찾기) + R10 항목(독립 감사 회귀) 추가
// update12: D12 항목(버스 운행 방향 자동 검증·추가 비용 직접 입력·화면 null) · S12-04~10(TAGO 버스노선정보 서버) 추가
// update12: A21 항목(resultCode 중첩 태그 거부, min/sec 안전 정수·Infinity·상한 60분)
// update12: A20 항목(역간 거리 응답 검사 — XML 형식·결과 코드·item 1개·거리 10진수·시간·역번호, 캐시 금지·복구, 화면 같은 기준)
// update12: A19 항목(공식 역간 거리 → 지하철 요금 구간, 10㎞ 경계, 확인값 충돌, 실패·이상 값 대체, 호출 재사용) · S18-06 실제 응답 구조
// update12: S18 항목(대전교통공사 역간 소요시간/거리/요금 서버 래퍼 — 주소 설정·검증·캐시·병합·오류·한도)
// update12 최종: A17 항목(공식 요금 우선 계산·요금 미확인 원인·비교 기준/추천 동률·시각표 상태·제외 원인 안내)
// update12 최종: A16 항목(실시간 차량 노선 ID 유효성 — 자동·수동·고정 경로 공통, 다음 차 가정)
// update12 최종: A15 항목(routeid 문자열 'null'·'undefined' 거절, 화면 경계 검사)
// update12 최종: A14 항목(TAGO totalCount·routeid 원본 값 검사, 불량 응답 캐시 금지)
// update12 감사: A13 항목(독립 감사 결함 회귀 — 공식·수동 방향 충돌, 페이지·순번 완전성, 불완전 결과 캐시, 예산 반영 대표 선정, 뒤 버스 요금·안내, 시각표 경쟁, 정거장 수 null)
// update12: A~E 고정 구조 폐지 → 기존 시험은 새 유형(L 도우미)으로 읽고, N12 항목(동적 경로·중복 제거·환승역별 탐색·추가 비용·호출량·화면) 추가
process.env.TZ = 'Asia/Seoul';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', 'cnu-route-web');
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✅' : '❌'} ${name}${info ? ' — ' + info : ''}`); };

/* ---------- 화면 코드(app.js)를 격리 실행 ---------- */
function loadApp({ fetchImpl, now, doc }) {
  const el = () => ({ textContent: '', hidden: false, value: '', classList: { toggle() {} }, setAttribute() {}, replaceChildren() {}, append() {}, addEventListener() {}, remove() {} });
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [FakeDate.now()])); } static now() { return now.t; } }
  const ctx = { window: {}, document: doc || { querySelector: el, createElement: el, createTextNode: (t) => t, visibilityState: 'visible', head: el() },
    location: { hostname: 'test' }, navigator: {}, console, URLSearchParams, setInterval() {}, setTimeout, Date: FakeDate, fetch: fetchImpl, Math, Number, Object, Promise, Set, Map, JSON, String, Array };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/scenario.js'), 'utf8'), ctx);
  let src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  src = src.replace(/\nstart\(\);\n\}\)\(\);\s*$/, '\nwindow.__T = { st, SC, computeRoutes, pickBest, loadStops, loadArrivals, loadDrives, setPoint, search, selectOrigin, stationNum, loadTimetables, loadTransit, loadHubs, tashuFee, stationFromPlace, routeKey, hubCands, pickHubs, render, setAllowCustom, setAllowFixed, parseAllow };\n})();');
  vm.runInContext(src, ctx);
  return ctx.window.__T;
}
// update12: A~E 고정 유형이 없어짐 → 이전 시험의 A~E를 새 유형에 대응시켜 읽는 도우미
//   A = 일반 대중교통 중 비교 기준(없으면 가장 빠른 대중교통) · B = 전 구간 택시 · C = 전 구간 타슈 · D = 타슈 연계 복합경로 · E = 택시 연계 복합경로
const L = (list) => { const t = list.filter((r) => r.kind === 'transit'); return { A: t.find((r) => r.baseline) || t[0], B: list.find((r) => r.kind === 'taxi'), C: list.find((r) => r.kind === 'tashu'), D: list.find((r) => r.kind === 'tashuMix'), E: list.find((r) => r.kind === 'taxiMix') }; };
const K = { A: 'transit', B: 'taxi', C: 'tashu', D: 'tashuMix', E: 'taxiMix' };
const KST = (h, m) => new Date(2026, 10, 16, h, m, 0).getTime();   // 2026-11-16 월요일
const mins = (h, m) => h * 60 + m;
const timetable = (lastHour) => { const from = [], to = []; for (let t = mins(5, 30); t <= mins(lastHour, 0); t += 10) { from.push(t); to.push(t + 19); }
  const set = { from, ride: 19 }; return { mock: false, days: { 0: { 0: set, 1: set }, 1: { 0: set, 1: set } } }; };
function world(o = {}) {
  const calls = {}; const count = (p) => (calls[p] = (calls[p] || 0) + 1);
  const now = { t: o.now || KST(14, 0) };
  const fetchImpl = async (url) => {
    const p = String(url).split('?')[0]; count(p); (calls.urls = calls.urls || []).push(String(url));
    const dl = o.delayOf ? o.delayOf(String(url)) : o.delay;
    if (dl) await new Promise((r) => setTimeout(r, dl));
    const fail = (o.fail || []).includes(p);
    let body = {};
    if (o.api && o.api[p]) body = o.api[p](String(url), now);
    else if (p === '/api/stops') body = { stops: [{ id: 'DJB8005589', no: '42630', name: '충남대산학연', lat: 36.36524, lng: 127.345184 }, { id: 'DJB8002725', no: '42650', name: '충남대학교입구', lat: 36.361355, lng: 127.34603 }] };
    else if (p === '/api/arrivals') body = { list: [{ routeNo: '108', routeId: 'DJBR108', arrSec: 600, prevCnt: 4 }], at: now.t };
    else if (p === '/api/arrivals-dj') body = { list: [], at: now.t };
    else if (p === '/api/tashu') body = { mock: false, stations: [{ name: '충남대 공대', d: 120, bikes: o.bikes ?? 5, lat: 36.366, lng: 127.346 }] };
    else if (p === '/api/drive') body = { durationSec: 1500, distanceM: 11000, taxiFare: 13000 };
    else if (p === '/api/subway') body = timetable(o.lastHour || 23);
    else if (p === '/api/search') body = { places: [{ name: '대전역', address: '', lat: 36.3324, lng: 127.4343 }] };
    return { ok: !fail, status: fail ? 503 : 200, json: async () => (fail ? { error: '조회 실패' } : body) };
  };
  const T = loadApp({ fetchImpl, now, doc: o.doc });
  T.st.cfg = { mock: false, drive: true, search: true, tashu: true, ...(o.cfg || {}) };
  // 시험 전제(입력): 월평(114)→대전역(104) 지하철 요금 구간이 '확인된' 상황 (update10 감사: 요금 미확인 경로는 추천하지 않음).
  // 실제 scenario.js의 zoneConfirmed는 비어 있음 → 미확인 상황은 world({ zone: false })로 따로 시험 (R10-11b)
  if (o.zone !== false) T.SC.subway.zoneConfirmed = { '114-104': 1 };
  else T.SC.subway.zoneConfirmed = {};                 // 요금 구간 확인값이 없는 상황
  // 좌표 미확인 출발지(장소 검색으로 좌표를 찾는 경로) 시험용: 실제 scenario.js는 4곳 모두 좌표 확인됨(2026-11-17)
  if (o.unknownPos) for (const k of o.unknownPos) Object.assign(T.SC.origins.find((x) => x.key === k), { lat: null, lng: null, verified: false });
  return { T, calls, now };
}

(async () => {
  /* ===== 화면·추천 (M01) ===== */
  async function scenario(o) {
    const w = world(o);
    // 시각표: 실패 설정이면 null
    w.T.st.subway = (o.fail || []).includes('/api/subway') ? null : timetable(o.lastHour || 23);
    await w.T.loadStops();
    const { list } = w.T.computeRoutes(), best = w.T.pickBest(list);
    const by = L(list);
    return { w, list, best, by };
  }
  let s = await scenario({});
  ok('M01-01 정상: 추천은 D, 전 경로 이용 가능 확인', s.best && s.best.kind === K.D && ['A', 'B', 'D', 'E'].every((k) => s.by[k].avail === 'ok'), `A ${Math.round(s.by.A.total)}분 / D ${Math.round(s.by.D.total)}분`);
  s = await scenario({ bikes: 0 });
  ok('M01-02 타슈 0대: D·C는 이용 불가, 추천에서 제외', s.by.D.avail === 'no' && s.by.C.avail === 'no' && s.best && s.best.kind === K.A, `D: ${s.by.D.why.join(',')} / 추천 ${s.best && s.best.kind}`);
  s = await scenario({ now: KST(23, 50), lastHour: 22 });
  ok('M01-03 막차 이후: 지하철 포함 A·D·E 이용 불가, 추천 없음', ['A', 'D', 'E'].every((k) => s.by[k].avail === 'no') && s.best === null, `B는 ${s.by.B.avail}(요금 초과로 추천 제외)`);
  s = await scenario({ fail: ['/api/arrivals', '/api/arrivals-dj', '/api/tashu', '/api/drive', '/api/subway'] });
  ok('M01-04 실시간 조회 전부 실패: 모두 가정값 포함, 추천 없음', s.list.every((r) => r.avail === 'unknown') && s.best === null, s.by.D.why.join(' / '));
  s = await scenario({ fail: ['/api/drive'] });
  ok('M01-10 택시 조회만 실패: B·E만 가정값 포함, D 추천 유지', s.by.B.avail === 'unknown' && s.by.E.avail === 'unknown' && s.best.kind === K.D);
  s = await scenario({ fail: ['/api/tashu'] });
  ok('타슈 조회 실패(0대와 구별): D는 미확인 → 추천 안 함', s.by.D.avail === 'unknown' && s.by.D.why[0].includes('미확인') && s.best.kind === K.A);

  /* ===== 호출 횟수 (H01 · 카카오) ===== */
  let w = world({}); w.T.st.subway = timetable(23);
  await w.T.loadStops();
  ok('첫 로딩: 길찾기 2회', w.calls['/api/drive'] === 2);
  await w.T.loadArrivals(); await w.T.loadArrivals(); await w.T.loadArrivals();
  ok('30초 갱신 3번: 길찾기 추가 호출 0회', w.calls['/api/drive'] === 2, `도착정보는 ${w.calls['/api/arrivals']}회`);
  w.T.setPoint('dest', { name: '대전역 근처', lat: 36.3330, lng: 127.4340 }); await new Promise((r) => setTimeout(r, 20));
  ok('목적지 변경: 택시 길찾기 재사용 없이 두 구간 모두 다시 조회 (update11)', w.calls['/api/drive'] === 4);
  await w.T.loadStops(true);
  ok('새로고침 버튼: 길찾기 다시 조회(+2)', w.calls['/api/drive'] === 6);
  w.T.setPoint('origin', { name: '멀리', lat: 36.40, lng: 127.40 }); await new Promise((r) => setTimeout(r, 30));
  ok('비교 구간(1km) 밖: 길찾기 호출 안 함', w.calls['/api/drive'] === 6);

  w = world({ delay: 30 }); w.T.st.subway = timetable(23); await w.T.loadStops();
  const before = w.calls['/api/arrivals'];
  await Promise.all([w.T.loadArrivals(), w.T.loadArrivals(), w.T.loadArrivals()]);
  ok('H01-12 갱신 겹침 방지: 동시에 3번 불러도 1번만 실행', w.calls['/api/arrivals'] - before === 2, `정류장 2곳 × 1회`);

  w = world({}); await w.T.search('대전역'); await w.T.search('대전역'); await w.T.search('충남대');
  ok('검색: 재사용 없음 — 같은 검색어도 다시 조회 (update11)', w.calls['/api/search'] === 3);

  /* ===== 서버 (core.js) ===== */
  const fresh = () => { for (const k of Object.keys(require.cache)) if (k.includes('cnu-route-web')) delete require.cache[k]; return require(path.join(ROOT, 'lib/core.js')); };
  const run = (core, fn, opts, q, ip = '1.1.1.1') => new Promise((r) => { const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { r({ status: this.statusCode, cache: this.headers['Cache-Control'], body: JSON.parse(b) }); } }; core.handler(fn, opts)({ query: q, headers: { 'x-forwarded-for': ip } }, res); });
  Object.assign(process.env, { DATA_GO_KR_KEY: 'fake', KAKAO_REST_KEY: 'fake', TASHU_KEY: 'fake', MOCK: '0' });
  let ext = {}, store = { n: {}, down: false };
  const tagoOk = JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [{ routeno: 108, arrtime: 300, arrprevstationcnt: 3, routeid: 'r' }] } } } });
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (u.startsWith('https://store.test')) {                 // 공유 저장소(Upstash REST) 흉내
      if (store.down) throw new Error('down');
      const cmds = JSON.parse(opt.body);
      return { ok: true, status: 200, json: async () => cmds.map(([c, k]) => ({ result: c === 'INCR' ? (store.n[k] = (store.n[k] || 0) + 1) : c === 'GET' ? store.n[k] || null : 1 })) };
    }
    const host = new URL(u).host + (u.includes('Arvl') ? '/arr' : ''); ext[host] = (ext[host] || 0) + 1;
    await new Promise((r) => setTimeout(r, 5));
    let body = '{}';
    if (u.includes('kakaomobility')) body = JSON.stringify({ routes: [{ result_code: 0, summary: { duration: 600, distance: 5000, fare: { taxi: 7000 } } }] });
    else if (u.includes('dapi.kakao')) body = JSON.stringify({ documents: [{ place_name: 'x', address_name: 'y', x: '127.4', y: '36.3' }] });
    else if (u.includes('Arvl')) body = tagoOk;
    return { ok: true, status: 200, text: async () => body };
  };
  let core = fresh();
  const dq = { olat: 36.36525, olng: 127.34648, dlat: 36.3324, dlng: 127.4343 };
  const d1 = await run(core, core.drive, { perMin: 30 }, dq); await run(core, core.drive, { perMin: 30 }, dq);
  ok('카카오 길찾기: 서버 캐시 없음 (같은 요청 2번 → 외부 2회), no-store', ext['apis-navi.kakaomobility.com'] === 2 && d1.cache === 'no-store');
  const s1 = await run(core, core.search, { perMin: 30 }, { q: '대전역' }); await run(core, core.search, { perMin: 30 }, { q: '대전역' });
  ok('카카오 검색: 서버 캐시 없음 (같은 검색 2번 → 외부 2회), no-store', ext['dapi.kakao.com'] === 2 && s1.cache === 'no-store');
  await Promise.all(Array.from({ length: 6 }, () => core.arrivals({ nodeId: 'DJB8005589' })));
  ok('H01-08 공공데이터: 같은 정류장 동시 6건 → 외부 1회로 병합', ext['apis.data.go.kr/arr'] === 1);

  process.env.QUOTA_TAGO_ARRIVAL = '3'; core = fresh(); ext = {};
  const rs = []; for (let i = 0; i < 5; i++) rs.push(await run(core, core.arrivals, {}, { nodeId: 'DJB800000' + i }));
  ok('하루 한도(인스턴스): 한도 3 → 4번째부터 외부 호출 없이 429', ext['apis.data.go.kr/arr'] === 3 && rs[3].status === 429 && rs[4].status === 429);

  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://store.test', UPSTASH_REDIS_REST_TOKEN: 't', QUOTA_TAGO_ARRIVAL: '8' }); ext = {}; store = { n: {}, down: false };
  const A = fresh(), B = fresh(); let allowed = 0;                 // 서버 인스턴스 2개가 같은 저장소를 공유
  for (let i = 0; i < 20; i++) { const r = await run(i % 2 ? A : B, (i % 2 ? A : B).arrivals, {}, { nodeId: 'DJB81' + String(i).padStart(5, '0') }); if (r.status === 200) allowed++; }
  ok('H01-09 하루 한도(공유 저장소): 인스턴스 2개 합계 20요청 → 8건만 외부 호출', allowed === 8 && ext['apis.data.go.kr/arr'] === 8, `허용 ${allowed} / 외부 ${ext['apis.data.go.kr/arr']}`);
  store.down = true; ext = {}; const C = fresh();
  const rd = await run(C, C.arrivals, {}, { nodeId: 'DJB8999999' });
  ok('공유 저장소 장애: 외부 호출 0회로 멈춤(503)', rd.status === 503 && !ext['apis.data.go.kr/arr']);

  /* ===== 개발 통신 보호 · 위치 (H01-13, H02) ===== */
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.MOCK = '1'; ext = {}; core = fresh();
  await run(core, core.search, { perMin: 30 }, { q: '대전역' });
  const hm = await core.health({});
  await core.arrivals({ nodeId: 'DJB8005589' }).catch(() => {});
  ok('H01-13 MOCK=1: 검색·점검·도착정보 모두 외부 호출 0회', Object.keys(ext).length === 0 && !!hm.note, JSON.stringify(ext));
  process.env.MOCK = '0'; core = fresh();
  const R13 = require(path.join(ROOT, 'lib/routes.js')), stopsHandler = R13.stops, tashuHandler = R13.tashu;
  const hdr = (hd, q) => new Promise((r) => { const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { r(this.headers['Cache-Control']); } }; hd({ query: q, headers: { 'x-forwarded-for': '9.9.9.9' } }, res); });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: '' } }, results: [] }) });
  const cs = await hdr(stopsHandler, { lat: '36.3653', lng: '127.3465' }), ctz = await hdr(tashuHandler, { lat: '36.3653', lng: '127.3465' });
  ok('H02 좌표가 들어간 응답(정류장·타슈)은 CDN 공유 캐시 안 함', cs === 'no-store' && ctz === 'no-store', `${cs} / ${ctz}`);
  w = world({}); w.T.st.subway = timetable(23); w.T.st.origin = { name: 'x', lat: 36.3652480902867, lng: 127.346479084829 };
  await w.T.loadStops();
  const coordUrls = w.calls.urls.filter((u) => /lat=|olat=/.test(u));
  const maxDec = Math.max(...coordUrls.flatMap((u) => [...new URLSearchParams(u.split('?')[1]).values()].filter((v) => /^-?\d+\.\d+$/.test(v)).map((v) => v.split('.')[1].length)));
  ok('H02 서버로 보내는 좌표는 소수 4자리 이하', maxDec <= 4, `요청 ${coordUrls.length}건 · 최대 ${maxDec}자리`);

  /* ===== update10: 출발지 확대 · 카카오 대중교통/도보/자전거 길찾기 (U10 · S10) ===== */
  {
    const P = { lat: 36.3640, lng: 127.3420 };                         // 시험용 출발지 (실제 좌표 아님)
    const BUS0 = { lat: 36.3632, lng: 127.3428 }, HEAD = { lat: 36.3632, lng: 127.3438 }, HUB = { lat: 36.3610, lng: 127.3710 };   // 버스는 동쪽으로 진행
    const sub = (o) => ({ type: 'SUBWAY', sec: 1500, m: 9000, stops: ['갑천', '월평', '대전역'], vehicles: [{ name: '1호선', type: '' }], start: HUB, end: { lat: 36.3324, lng: 127.4343 } });
    const tr = (o = {}) => ({ at: 0, routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 99999, fare: o.fare ?? 1550, steps: o.steps || [
      { type: 'WALKING', sec: o.walk0 ?? 180, m: 200, stops: [], vehicles: [], start: P, end: BUS0 },
      { type: 'BUS', sec: 600, m: 3000, stops: [o.stopName || '궁동네거리', '유성구청', '갑천역'], vehicles: [{ name: o.route || '104', type: '일반' }], start: BUS0, head: HEAD, end: HUB },
      { type: 'WALKING', sec: 120, m: 100, stops: [], vehicles: [], start: HUB, end: HUB },
      sub(o),
      { type: 'WALKING', sec: 60, m: 50, stops: [], vehicles: [], start: null, end: null },
    ] }] });
    const stops = { stops: [{ id: 'DJB_X', no: '41111', name: '궁동네거리', lat: BUS0.lat, lng: BUS0.lng },
      { id: 'DJB_Y', no: '41112', name: '궁동네거리', lat: BUS0.lat + 0.0003, lng: BUS0.lng + 0.0001 }] };   // 같은 이름 반대편 정류장
    const arrivals = (u, now) => ({ at: now.t, list: u.includes('DJB_X') ? [{ routeNo: '104', routeId: 'DJBR104', arrSec: 600, prevCnt: 3 }] : [{ routeNo: '104', routeId: 'DJBR104', arrSec: 300, prevCnt: 1 }] });   // 반대편(DJB_Y)이 더 빨리 와도 쓰면 안 됨
    const tt21 = () => { const t = timetable(23); t.days[0][0].ride = 21; return t; };
    // 시험 전제(입력): 기본은 '확인된' 출발지 좌표 + 104번 DJB_X 방향 확인됨. 미확인 상황은 o.unverified / o.noVerified로 따로 시험
    const setup = async (o = {}) => {
      const w = world({ ...o, cfg: { route: true }, api: { '/api/transit': (u) => tr(o), '/api/stops': () => o.stops || stops, '/api/arrivals': o.arrivals || arrivals, '/api/subway': o.tt || tt21, ...(o.api || {}) } });
      if (!o.noVerified) w.T.SC.bus.verifiedStops['104'] = ['DJB_X'];
      w.T.st.subway = null;
      w.T.st.presetPos.haksa = { ...P };
      w.T.st.origin = { key: 'haksa', name: '학사마을(시험)', lat: P.lat, lng: P.lng, verified: !o.unverified }; w.T.st.originKey = 'haksa';
      await w.T.loadStops();
      const { list } = w.T.computeRoutes();
      return { w, by: L(list), best: w.T.pickBest(list) };
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    ok('U10-01 1호선 역번호: 괄호·"역" 표기 차이를 맞춤', w.T.stationNum('월평(한국과학기술원)') === '114' && w.T.stationNum('대전역') === '104' && w.T.stationNum('갑천역') === '115');

    let u = await setup();
    const A = u.by.A, aw = A.steps.find((x) => x.type === 'wait');
    ok('U10-02 대중교통 길찾기로 A 구성: 104번 → 갑천역 (108번·월평역 강제 안 함)', A.avail === 'ok' && /104번/.test(A.sub) && /갑천역/.test(A.sub) && !/108/.test(A.sub), A.sub);
    ok('U10-03 같은 이름 반대편 정류장 제외: 경로 좌표에 가까운 정류장의 실시간만 사용', u.w.T.st.plans[0].stop.id === 'DJB_X' && Math.round(aw.min) === 7, `대기 ${aw.min}분 (도착 10분 - 도보 3분)`);
    ok('U10-04 대기 중복 없음: 카카오 전체 소요(totalTime) 미사용 · 구간 시간 + 자체 대기만', Math.round(A.total) === 52, `A ${Math.round(A.total)}분 = 도보3+대기7+버스10+도보2+역내3+열차대기5+지하철21(시각표)+도보1`);
    ok('U10-05 환승역 따라 시각표·택시·D/E 변경', u.w.calls.urls.some((x) => x.includes('/api/subway?from=115&to=104')) && /갑천역/.test(u.by.D.sub) && /갑천역/.test(u.by.E.sub)
      && u.w.calls.urls.some((x) => x.includes('/api/drive') && x.includes('dlat=36.361')));
    // 감사-6: 지하철 하차 후 이동 구간 (D·E도 카카오 경로의 하차 후 도보 1분 포함)
    const lastD = u.by.D.steps[u.by.D.steps.length - 1], lastE = u.by.E.steps[u.by.E.steps.length - 1];
    ok('R10-06 지하철 하차 후 목적지까지 이동 구간: A·D·E 모두 포함', [lastD, lastE, A.steps[A.steps.length - 1]].every((x) => x.type === 'walk' && Math.round(x.min) === 1 && /대전역까지 도보/.test(x.label)), `${lastD.label} ${lastD.min}분`);
    ok('R10-13a 같은 역 구간은 A·D·E에 같은 지하철 승차시간', [A, u.by.D, u.by.E].every((r) => r.steps.find((x) => x.type === 'sub').min === 21));

    u = await setup({ stopName: '궁동 사거리' });
    ok('U10-06 정류장 이름 불일치: 연결하지 않고 A는 가정값 포함', u.w.T.st.plans[0].stop === null && u.by.A.avail === 'unknown' && u.by.A.why.some((x) => x.includes('연결')) && u.w.calls['/api/stops'] === 2, u.by.A.why.join(' / '));

    const tashuT1 = (x) => ({ mock: false, stations: [x.includes('lat=36.33') ? { id: 'TD', name: '대전역 대여소', d: 80, bikes: 2, lat: 36.3330, lng: 127.4340 } : { id: 'T1', name: '출발대여소', d: 120, bikes: 5, lat: P.lat + 0.001, lng: P.lng }] });
    u = await setup({ api: { '/api/walk': () => ({ sec: 240, m: 300 }), '/api/bike': () => ({ sec: 600, m: 2500 }), '/api/tashu': tashuT1 } });
    const D = u.by.D.steps;
    ok('U10-07 타슈 구간에 카카오 도보·자전거 길찾기 반영', Math.round(D[0].min) === 4 && Math.round(D[2].min) === 10 && Math.round(D[4].min) === 7 && /카카오/.test(D[2].note), `도보 ${D[0].min} · 주행 ${D[2].min} · 반납 후 ${D[4].min}`);
    const wb = [u.w.calls['/api/walk'], u.w.calls['/api/bike']];
    await u.w.T.loadArrivals(); await u.w.T.loadArrivals();
    ok('U10-08 30초 갱신: 도보·자전거·대중교통 길찾기 재호출 없음 (화면의 결과 유지)', u.w.calls['/api/walk'] === wb[0] && u.w.calls['/api/bike'] === wb[1] && u.w.calls['/api/transit'] === 1, `도보 ${wb[0]} · 자전거 ${wb[1]} · 대중교통 ${u.w.calls['/api/transit']}`);
    // 감사-8: 카카오 공식 답변(임시 캐싱 불허) → 같은 구간을 다시 열면 재사용 없이 다시 조회 (이전 U10-09 '세션 재사용' 조건을 정책에 맞게 변경)
    const tsub = u.w.calls['/api/subway'], ttash = u.w.calls['/api/tashu'];
    await u.w.T.loadStops(); const t1 = u.w.calls['/api/transit']; await u.w.T.loadStops(true);
    ok('U10-09 대중교통 재조회 캐시 제거: 같은 구간 다시 열기·새로고침 모두 다시 조회', t1 === 2 && u.w.calls['/api/transit'] === 3, `다시 열기 후 ${t1} · 새로고침 후 ${u.w.calls['/api/transit']}`);
    ok('R10-15 사용자 새로고침: 도보·자전거·타슈·시각표까지 다시 조회', u.w.calls['/api/walk'] > wb[0] && u.w.calls['/api/bike'] > wb[1] && u.w.calls['/api/subway'] > tsub && u.w.calls['/api/tashu'] > ttash + 1,
      `도보 ${wb[0]}→${u.w.calls['/api/walk']} · 자전거 ${wb[1]}→${u.w.calls['/api/bike']} · 시각표 ${tsub}→${u.w.calls['/api/subway']}`);

    u = await setup({ fail: ['/api/transit'] });
    ok('U10-10 대중교통 길찾기 실패(다른 출발지): A는 추정값 · 108번 고정 경로 미사용', u.by.A.avail === 'unknown' && !/108/.test(u.by.A.sub) && u.by.A.why.some((x) => x.includes('실패')), u.by.A.why.join(' / '));
    ok('R10-10b 직선거리 추정 경로는 추천 제외', u.by.D.why.some((x) => x.includes('직선거리')) && u.by.D.avail === 'unknown' && u.best === null, u.by.D.why.join(' / '));
    let w2 = world({ cfg: { route: true }, fail: ['/api/transit'] }); w2.T.st.subway = timetable(23); await w2.T.loadStops();
    let r2 = L(w2.T.computeRoutes().list).A;
    ok('U10-11 대중교통 길찾기 실패(공대 3호관): 기존 108번 → 월평역 경로로 계산', /108/.test(r2.sub) && r2.avail === 'ok');

    w2 = world({ cfg: { route: true }, unknownPos: ['yotgol'], api: { '/api/search': () => ({ places: [{ name: '욧골공원', address: '대전 유성구 궁동', lat: P.lat, lng: P.lng }] }), '/api/transit': () => tr(), '/api/stops': () => stops, '/api/arrivals': arrivals, '/api/subway': tt21 } });
    await w2.T.selectOrigin('yotgol'); await sleep(30);
    await w2.T.selectOrigin('yotgol'); await sleep(30);
    ok('U10-12 출발지 선택(좌표 미확인): 고를 때마다 장소 검색(재사용 없음, update11) · 미확인 표시', w2.calls['/api/search'] === 2 && w2.T.st.originKey === 'yotgol' && w2.T.st.origin.verified === false && w2.T.st.origin.lat === P.lat);
    ok('U10-13 서버로 보내는 좌표 소수 4자리 이하 (길찾기 포함)', w2.calls.urls.filter((x) => /lat=/.test(x)).every((x) => [...new URLSearchParams(x.split('?')[1]).values()].every((v) => !/^\d+\.\d{5,}$/.test(v))));

    /* ----- 독립 감사 회귀 (R10) ----- */
    // 1) 비동기 응답 순서
    w2 = world({ cfg: { route: true }, unknownPos: ['yotgol', 'haksa'], delayOf: (x) => (x.includes('search') && x.includes(encodeURIComponent('욧골')) ? 60 : 5),
      api: { '/api/search': (x) => ({ places: [x.includes(encodeURIComponent('욧골')) ? { name: '욧골', address: '', lat: 36.3650, lng: 127.3400 } : { name: '학사', address: '', lat: 36.3660, lng: 127.3390 }] }), '/api/transit': () => tr(), '/api/stops': () => stops, '/api/arrivals': arrivals, '/api/subway': tt21 } });
    const s1 = w2.T.selectOrigin('yotgol'), s2 = w2.T.selectOrigin('haksa'); await Promise.all([s1, s2]); await sleep(120);
    ok('R10-01 출발지 검색 응답 순서 역전: 늦게 온 이전 선택이 마지막 선택을 덮지 않음', w2.T.st.originKey === 'haksa' && w2.T.st.origin.lat === 36.366, `${w2.T.st.originKey} ${w2.T.st.origin.lat}`);

    w2 = world({ cfg: { route: true }, delayOf: (x) => (x.includes('/api/transit') && x.includes('dlat=36.3324') ? 60 : 3),
      api: { '/api/transit': (x) => tr({ route: x.includes('dlat=36.3324') ? '104' : '105' }), '/api/stops': () => stops, '/api/arrivals': arrivals, '/api/subway': tt21 } });
    w2.T.st.presetPos.haksa = { ...P }; w2.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; w2.T.st.originKey = 'haksa';
    const pl = w2.T.loadStops(); await sleep(10);
    w2.T.setPoint('dest', { name: '대전역 동광장', lat: 36.3330, lng: 127.4350 }); await pl; await sleep(150);
    const bn = w2.T.st.plans[0] && w2.T.st.plans[0].route.steps.find((x) => x.type === 'BUS').vehicles[0].name;
    ok('R10-02 목적지 변경 후 이전 경로 응답 도착: 버리고 새 목적지 경로만 적용', bn === '105', `적용된 노선 ${bn}`);

    w2 = world({ cfg: { route: true }, delayOf: (x) => (x.includes('/api/subway?from=114') ? 60 : 3),
      api: { '/api/subway': (x) => { const t = timetable(23); t.days[0][0] = { ...t.days[0][0], ride: x.includes('from=114') ? 19 : 21 }; return t; }, '/api/transit': () => tr(), '/api/stops': () => stops, '/api/arrivals': arrivals } });
    w2.T.st.presetPos.haksa = { ...P }; w2.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; w2.T.st.originKey = 'haksa';
    // (update12 구조 반영) 시각표를 역 구간별로 보관 → 늦게 온 월평(114) 시각표가 갑천(115) 구간 계산에 쓰이지 않는지 확인
    const old = w2.T.loadTimetables();                 // 경로·환승역 미정(기본 월평 114) 상태에서 요청 → 늦게 도착
    await w2.T.loadTransit(); await w2.T.loadTimetables(); await old; await sleep(20);
    const sub03 = L(w2.T.computeRoutes().list).A.steps.find((x) => x.type === 'sub');
    ok('R10-03 이전 환승역 시각표 응답 도착: 현재 환승역(갑천 115) 구간 시각표만 적용', w2.T.st.tt['115-104'].days[0][0].ride === 21 && sub03.min === 21 && /갑천역/.test(sub03.note), sub03.note);

    // 환승역이 바뀌었는데 새 시각표가 아직 없을 때: 이전 환승역(월평) 시각표를 갑천역에 적용하지 않음
    w2 = world({ cfg: { route: true }, api: { '/api/transit': () => tr(), '/api/stops': () => stops, '/api/arrivals': arrivals } });
    w2.T.st.presetPos.haksa = { ...P }; w2.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; w2.T.st.originKey = 'haksa';
    w2.T.SC.bus.verifiedStops['104'] = ['DJB_X'];
    await w2.T.loadTimetables(); const k114 = Object.keys(w2.T.st.tt).join(); await w2.T.loadTransit();   // 갑천(115) 구간 시각표는 아직 없음
    const rr = L(w2.T.computeRoutes().list).A;
    ok('R10-03b 새 환승역 시각표가 없으면 이전 역 시각표를 쓰지 않음(간격 가정 · 미확인)', k114 === '114-104' && rr.why.some((x) => x.includes('시각표 없음')), rr.why.join(' / '));

    // 2) 정류장·방향
    w2 = world({}); w2.T.st.subway = timetable(23); await w2.T.loadStops();
    w2.T.st.stops.push({ id: 'ars49999', arsId: '49999', no: '49999', name: '지정 안 된 정류장', lat: 36.3653, lng: 127.3466, fixed: true, d: 30 });
    w2.T.st.arr['ars49999'] = { at: w2.now.t, list: [{ routeNo: '108', routeId: 'DJBR108', arrSec: 240, prevCnt: 1 }] };
    let rA = w2.T.computeRoutes();
    ok('R10-04 명시적 정류장 제한 우회 방지: fixed 정류장도 지정 목록 밖이면 사용 안 함', L(rA.list).A.bus && L(rA.list).A.bus.stop.id !== 'ars49999', L(rA.list).A.bus && L(rA.list).A.bus.stop.id);

    const stopsLR = { stops: [{ id: 'DJB_R', no: '1', name: '궁동네거리', lat: BUS0.lat - 0.00008, lng: BUS0.lng + 0.0002 },     // 진행(동쪽) 오른쪽 = 남쪽
      { id: 'DJB_L', no: '2', name: '궁동네거리', lat: BUS0.lat + 0.00005, lng: BUS0.lng }] };                                  // 왼쪽(북쪽)이지만 더 가까움
    u = await setup({ noVerified: true, stops: stopsLR, arrivals: (x, now) => ({ at: now.t, list: [{ routeNo: '104', routeId: 'DJBR104', arrSec: 600, prevCnt: 3 }] }) });
    ok('R10-05 동일 이름 반대 방향 정류장: 진행 방향 오른쪽 정류장 선택 · 방향 미확인이라 추천 제외', u.w.T.st.plans[0].stop.id === 'DJB_R' && u.w.T.st.plans[0].stop.dir === 'geometry' && u.by.A.avail === 'unknown' && u.by.A.why.some((x) => x.includes('방향')), u.by.A.why.join(' / '));

    // 3) 경로별 시간 계산
    u = await setup({ steps: [
      { type: 'WALKING', sec: 300, m: 350, stops: [], vehicles: [], start: P, end: HUB }, sub({}),
      { type: 'WALKING', sec: 120, m: 100, stops: [], vehicles: [], start: null, end: null },
      { type: 'BUS', sec: 420, m: 2000, stops: ['대전역', '대동'], vehicles: [{ name: '601', type: '간선' }], start: { lat: 36.3324, lng: 127.4343 }, end: null },
      { type: 'WALKING', sec: 60, m: 50, stops: [], vehicles: [], start: null, end: null }] });
    const sA = u.by.A.steps, iSub = sA.findIndex((x) => x.type === 'sub'), iBw = sA.findIndex((x, i) => i > iSub && x.type === 'wait');
    ok('R10-07 지하철 이후 버스: 앞선 이동·대기 뒤에 이어서 계산 · 실시간 대신 환승 대기 가정(미확인)', u.w.T.st.plans[0].board === null && iBw > iSub && sA[iBw].start >= sA[iSub].end && u.by.A.avail === 'unknown' && u.by.A.why.some((x) => x.includes('환승 버스')), u.by.A.why.join(' / '));

    // 4) 버스 대기시간
    u = await setup({ walk0: 1800, arrivals: (x, now) => ({ at: now.t, list: [{ routeNo: '104', routeId: 'DJBR104', arrSec: 120, prevCnt: 1 }] }) });
    const bw = u.by.A.steps.find((x) => x.type === 'wait');
    ok('R10-08 음수 버스 대기 방지: 놓친 뒤 가정 차는 정류장 도착(+여유) 이후 · 0으로 자르지 않음', bw.min >= 1 && Math.round(bw.min) === 2 && u.w.T.st.plans[0] && u.by.A.why.some((x) => x.includes('가정')), `대기 ${bw.min}분 (기존식이면 2+15-30=-13분)`);
    w2 = world({ api: { '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '108', routeId: 'DJBR108', arrSec: 60, prevCnt: 1 }, { routeNo: '108', routeId: 'DJBR108', arrSec: 1200, prevCnt: 9 }] }) } });
    w2.T.st.subway = timetable(23); await w2.T.loadStops(); rA = w2.T.computeRoutes();
    const rAA = L(rA.list).A;
    ok('R10-09 복수 버스 도착정보: 놓치는 첫 차 대신 실제로 탈 수 있는 뒤차(실시간) 사용', L(rA.list).A.bus.source === 'live' && L(rA.list).A.bus.later && Math.round(L(rA.list).A.bus.wait) === 17 && rAA.avail === 'ok', `대기 ${L(rA.list).A.bus.wait}분`);

    // 5) 신뢰도·요금
    u = await setup({ unverified: true });
    ok('R10-10a 미확인 출발지 좌표: 모든 경로 가정값 포함 · 추천 없음', Object.values(u.by).every((r) => r.avail !== 'ok') && u.best === null && u.by.A.why.includes('출발지 좌표 미확인'));
    u = await setup({ fare: 1650 });
    // (정책 변경 반영) 이전: '예산 1,550원 고정 → 2구간 D 추천 제외' → 지금: 기준은 A 실제 요금(1,650원), 고정 예산 없음
    ok('R10-11 실제 경로 요금 표시: A 1,650원(카카오) · 2구간 D 1,650원 · 고정 예산 없음 · 추천은 비교 기준 요금 이하만(추가 비용 0원)', u.by.A.fare === 1650 && u.w.T.SC.fare.budget === undefined && u.by.D.fare === 1650 && (!u.best || u.best.fare <= u.by.A.fare), `A ${u.by.A.fare} · D ${u.by.D.fare} · 추천 ${u.best && u.best.kind}`);
    w2 = world({ zone: false }); w2.T.st.subway = timetable(23); await w2.T.loadStops();
    let lz = w2.T.computeRoutes().list, bz = w2.T.pickBest(lz), Az = L(lz).A;
    ok('R10-11b 요금 구간 미확인: A 요금 미확인(1,550원 고정 표시 안 함) · D·E 추천 제외', Az.fare === null && Az.avail === 'unknown' && L(lz).D.avail === 'unknown' && bz === null, Az.why.join(' / '));
    const f1 = w2.T.tashuFee(60), f2 = w2.T.tashuFee(72), f3 = w2.T.tashuFee(700);
    u = await setup({ api: { '/api/walk': () => ({ sec: 240, m: 300 }), '/api/bike': (x) => (x.includes('dlat=36.33') ? { sec: 4200, m: 15000 } : { sec: 600, m: 2500 }), '/api/tashu': tashuT1 } });
    ok('R10-12 타슈 1시간 초과: 60분 0원 · 72분 500원(올림 가정 → 미확인) · 최대 5,000원 · C 요금 반영', f1.fare === 0 && f1.ok && f2.fare === 500 && !f2.ok && f3.fare === 5000 && u.by.C.fare === 500 && u.by.C.avail === 'unknown', `C ${u.by.C.fare}원 · ${u.by.C.why.join(' / ')}`);

    // 6) 지하철 역별 소요시간
    const noRide = () => { const t = timetable(23), set = { from: t.days[0][0].from, ride: null }; return { mock: false, days: { 0: { 0: set, 1: set }, 1: { 0: set, 1: set } } }; };
    u = await setup({ tt: noRide });
    const subMins = [u.by.A, u.by.D, u.by.E].map((r) => r.steps.find((x) => x.type === 'sub').min);
    ok('R10-13 지하철 역별 소요: 시각표 소요가 없으면 19분 일괄 적용 대신 그 구간 값(카카오 25분) · 미확인', subMins.every((m) => m === 25) && u.by.A.why.some((x) => x.includes('시각표 없음')), subMins.join('/'));
    w2 = world({ api: { '/api/subway': noRide } }); w2.T.st.subway = null; await w2.T.loadStops();
    const lr = L(w2.T.computeRoutes().list).A;
    ok('R10-13b 월평→대전역은 확인된 19분 사용(가정 아님)', lr.steps.find((x) => x.type === 'sub').min === 19 && lr.avail === 'ok');

    // 7) null·음수 응답
    u = await setup({ steps: tr().routes[0].steps.map((s, i) => (i === 1 ? { ...s, sec: -5 } : s)) });
    ok('R10-16a 음수 구간 시간 대중교통 응답은 정상으로 쓰지 않음', u.w.T.st.plans.length === 0 && u.by.A.why.some((x) => x.includes('실패')));
    u = await setup({ api: { '/api/walk': () => ({ sec: null, m: 300 }), '/api/bike': () => ({ sec: -1, m: 10 }), '/api/drive': () => ({ durationSec: -60, distanceM: 1000, taxiFare: 5000 }),
      '/api/tashu': () => ({ mock: false, stations: [{ id: 'T0', name: '빈값', d: 50, bikes: null, lat: P.lat, lng: P.lng }, { id: 'T1', name: '출발대여소', d: 120, bikes: 5, lat: P.lat + 0.001, lng: P.lng }] }),
      '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '104', routeId: 'DJBR104', arrSec: -30, prevCnt: 1 }, { routeNo: '104', routeId: 'DJBR104', arrSec: null, prevCnt: 1 }] }) } });
    ok('R10-16b null·음수(도보·자전거·택시·타슈·버스 도착) 응답 무시', !(u.w.T.st.legs.walkStart || {}).v && !(u.w.T.st.legs.bikeHub || {}).v && u.w.T.st.drive.dest === null
      && u.w.T.st.tashu.stations.every((t) => t.id !== 'T0') && u.w.T.st.arr['DJB_X'].list.length === 0 && u.by.B.avail === 'unknown', u.by.B.why.join(' / '));
  }
  /* ===== update10 실제 API 검증으로 발견한 문제 (R10-17~) ===== */
  {
    const P = { lat: 36.3640, lng: 127.3420 }, BUS0 = { lat: 36.3632, lng: 127.3428 }, HUB = { lat: 36.3537, lng: 127.3415 };
    const subS = { type: 'SUBWAY', sec: 1390, m: 11400, stops: ['유성온천(충남대.목원대)', '갑천', '대전역'], vehicles: [{ name: '1호선', type: '일반' }], start: HUB, end: { lat: 36.3320, lng: 127.4340 } };
    // 실제 응답 형태: 첫 단계가 바로 BUS(출발지→정류장 도보 없음), 요금은 value 없이 min·max (좌석버스 포함)
    const busS = { type: 'BUS', sec: 336, m: 1120, stops: ['다솔아파트', '온천교', '유성온천역6번출구'], vehicles: [{ name: '102', type: '일반' }, { name: '48', type: '좌석' }], start: BUS0, head: { lat: BUS0.lat, lng: BUS0.lng + 0.001 }, end: HUB };
    const walkS = { type: 'WALKING', sec: 230, m: 154, stops: ['유성온천역6번출구', '유성온천(충남대.목원대)'], vehicles: [], start: HUB, end: HUB };
    const real = { at: 0, routes: [
      { type: 'BUS_AND_SUBWAY', totalSec: 2700, fare: null, fareMin: 1650, fareMax: 2900, steps: [busS, walkS, subS] },
      { type: 'BUS_AND_SUBWAY', totalSec: 2500, fare: null, fareMin: 1650, fareMax: 2900, steps: [busS, walkS, subS] }] };
    const nullTT = () => { const t = timetable(23), set = { from: [null, ...t.days[0][0].from, null], ride: 23 }; return { mock: false, days: { 0: { 0: set, 1: set }, 1: { 0: set, 1: set } } }; };
    const w = world({ cfg: { route: true }, api: { '/api/transit': () => real, '/api/stops': () => ({ stops: [{ id: 'DJB8001296', no: '42680', name: '다솔아파트', lat: BUS0.lat, lng: BUS0.lng }] }),
      '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '48', routeId: 'DJBR48', arrSec: 240, prevCnt: 1 }, { routeNo: '102', routeId: 'DJBR102', arrSec: 600, prevCnt: 3 }] }),
      '/api/walk': (x) => (x.includes('dlat=36.3632') ? { sec: 300, m: 320 } : { sec: 120, m: 100 }), '/api/subway': nullTT } });
    w.T.st.subway = null; w.T.st.origin = { key: 'yotgol', name: '욧골(시험)', lat: P.lat, lng: P.lng, verified: true }; w.T.st.originKey = 'yotgol'; w.T.st.presetPos.yotgol = { ...P };
    await w.T.loadStops();
    const { list } = w.T.computeRoutes(), A = L(list).A, p = w.T.st.plans[0];
    ok('R10-17 카카오 경로에 출발지→첫 정류장 도보가 없으면 도보 길찾기로 보충하고 버스 탑승 판단에 반영', A.steps[0].type === 'walk' && Math.round(A.steps[0].min) === 5 && /다솔아파트까지 도보/.test(A.steps[0].label) && Math.round(A.steps[1].min) === 5, A.steps[0].label + ' ' + A.steps[0].min + '분 · 대기 ' + A.steps[1].min + '분');
    ok('R10-18 요금이 min·max로만 올 때: 일반버스 기준 최저 요금(1,650원) 적용, 좌석버스(48)는 탈 노선에서 제외', A.fare === 1650 && p.fare.cityOnly && p.board.routeNos.join() === '102' && /102번 버스 대기/.test(A.steps[1].label), A.fare + ' · ' + p.board.routeNos);
    ok('R10-19 같은 경로(같은 정류장·역 순서)는 하나로 합치고 카카오 예상 소요가 짧은 쪽을 평가 (update12: 경로 하나를 고르지 않음)', p.route.totalSec === 2500);
    ok('R10-20 시각표 안의 null 시각만 걸러 내고 시각표는 계속 사용 (유성온천→대전역 시각표 23분)', !A.why.some((x) => x.includes('시각표 없음')) && A.steps.find((x) => x.type === 'sub').min === 23, A.why.join(' / '));
  }
  /* ===== update10 추천 정책: 기준 = A 실제 요금 (P10) ===== */
  {
    const P = { lat: 36.3640, lng: 127.3420 }, BUS0 = { lat: 36.3632, lng: 127.3428 }, HUB = { lat: 36.3610, lng: 127.3710 };
    const tr = (fare) => ({ at: 0, routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 2600, fare, steps: [
      { type: 'WALKING', sec: 180, m: 200, stops: [], vehicles: [], start: P, end: BUS0 },
      { type: 'BUS', sec: 600, m: 3000, stops: ['궁동네거리', '유성구청', '갑천역'], vehicles: [{ name: '104', type: '일반' }], start: BUS0, head: { lat: BUS0.lat, lng: BUS0.lng + 0.001 }, end: HUB },
      { type: 'WALKING', sec: 120, m: 100, stops: [], vehicles: [], start: HUB, end: HUB },
      { type: 'SUBWAY', sec: 1500, m: 11000, stops: ['갑천', '월평', '대전역'], vehicles: [{ name: '1호선', type: '일반' }], start: HUB, end: { lat: 36.3324, lng: 127.4343 } }] }] });
    const tashu = (x) => ({ mock: false, stations: [x.includes('lat=36.33') ? { id: 'TD', name: '대전역 대여소', d: 80, bikes: 2, lat: 36.3330, lng: 127.4340 } : { id: 'T1', name: '출발대여소', d: 120, bikes: 5, lat: P.lat + 0.001, lng: P.lng }] });
    const run2 = async (fare) => {
      const w = world({ cfg: { route: true }, api: { '/api/transit': () => tr(fare), '/api/stops': () => ({ stops: [{ id: 'DJB_X', no: '41111', name: '궁동네거리', lat: BUS0.lat, lng: BUS0.lng }] }),
        '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '104', routeId: 'DJBR104', arrSec: 900, prevCnt: 6 }] }), '/api/walk': () => ({ sec: 240, m: 300 }), '/api/bike': () => ({ sec: 600, m: 2500 }), '/api/tashu': tashu,
        '/api/subway': () => { const t = timetable(23); t.days[0][0].ride = 21; return t; } } });
      w.T.SC.bus.verifiedStops['104'] = ['DJB_X']; w.T.st.subway = null;
      w.T.st.presetPos.haksa = { ...P }; w.T.st.origin = { key: 'haksa', name: '학사마을(시험)', lat: P.lat, lng: P.lng, verified: true }; w.T.st.originKey = 'haksa';
      await w.T.loadStops();
      const { list } = w.T.computeRoutes();
      return { w, list, by: L(list), best: w.T.pickBest(list) };
    };
    let u = await run2(1650);   // 2구간 환승(유성온천·갑천 등) — 이전 정책(예산 1,550원)이면 추천이 없던 경우
    ok('P10-01 비교 기준(확인된 가장 빠른 대중교통 1,650원) 요금으로: 추가 비용 없이 더 빠른 타슈 연계(1,650원) 추천', u.by.A.avail === 'ok' && u.by.D.avail === 'ok' && u.by.D.fare === 1650 && u.best && u.best.kind === K.D && u.by.D.arrive < u.by.A.arrive,
      `A ${Math.round(u.by.A.total)}분 ${u.by.A.fare}원 · D ${Math.round(u.by.D.total)}분 ${u.by.D.fare}원`);
    ok('P10-02 추가 비용 0원: 비교 기준보다 비싼 경로(택시·택시 연계)는 더 빨라도 추천 안 함', u.by.B.avail === 'ok' && u.by.B.arrive < u.by.D.arrive && u.best.kind !== K.B && u.best.kind !== K.E);
    u = await run2(null);
    ok('P10-03 비교 기준 없음(대중교통 요금 미확인) → 추천 보류 (다른 경로가 확인돼도)', u.by.A.fare === null && u.best === null && u.by.D.avail !== 'no', u.by.A.why.join(' / '));
    // pickBest 단위 시험 (시각 기준 t0) — (update12 정책 반영) 기준은 'A'가 아니라 '비교 기준'(확인된 가장 빠른 대중교통, baseline) + 추가 비용 허용 범위
    const t0 = Date.now(), R = (id, avail, fare, min, o = {}) => ({ id, avail, fare, arrive: t0 + min * 60000, ...o });
    const pb = u.w.T.pickBest;
    ok('P10-04 시간 절감 경로가 없으면 비교 기준 추천 (비교 기준이 가장 빠름)', pb([R('A', 'ok', 1550, 40, { baseline: true }), R('D', 'ok', 1550, 45), R('B', 'ok', 13000, 30)], 0).id === 'A');
    ok('P10-05 같은 요금이라도 비교 기준보다 늦거나 같은 분이면 추천 안 함 · 비교 기준이 없으면(확인된 대중교통 없음) 추천 없음', pb([R('A', 'ok', 1550, 40, { baseline: true }), R('D', 'ok', 1550, 40.2)], 0).id === 'A' && pb([R('A', 'unknown', 1550, 40), R('D', 'ok', 1550, 35)], 0) === null);
    ok('P10-06 비교 기준보다 싼 경로도 추가 비용 없음으로 보고 추천 · 요금 미확인·가정값 경로는 제외', pb([R('A', 'ok', 1650, 50, { baseline: true }), R('D', 'ok', 1550, 44), R('E', 'unknown', 1600, 40), R('X', 'ok', null, 30)], 0).id === 'D');
    ok('P10-07 전 구간 타슈(도착 이상)는 0원이어도 추천 안 함', pb([R('A', 'ok', 1550, 50, { baseline: true }), R('C', 'ok', 0, 45, { plus: true })], 0).id === 'A');
  }
  /* ===== update10 최종 감사 잔여 결함 (F10) ===== */
  {
    const P = { lat: 36.3640, lng: 127.3420 }, BUS0 = { lat: 36.3632, lng: 127.3428 }, HUB = { lat: 36.3610, lng: 127.3710 };
    const mk = (vehicles, fare = { fare: 1550 }) => ({ at: 0, routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 2600, ...fare, steps: [
      { type: 'WALKING', sec: 180, m: 200, stops: [], vehicles: [], start: P, end: BUS0 },
      { type: 'BUS', sec: 600, m: 3000, stops: ['궁동네거리', '유성구청', '월평역'], vehicles, start: BUS0, head: { lat: BUS0.lat, lng: BUS0.lng + 0.001 }, end: HUB },
      { type: 'WALKING', sec: 120, m: 100, stops: [], vehicles: [], start: HUB, end: HUB },
      { type: 'SUBWAY', sec: 1150, m: 9100, stops: ['월평', '갈마', '대전역'], vehicles: [{ name: '1호선', type: '일반' }], start: HUB, end: { lat: 36.3324, lng: 127.4343 } }] }] });
    const go = async (tr, list) => {
      const w = world({ cfg: { route: true }, api: { '/api/transit': () => tr, '/api/stops': () => ({ stops: [{ id: 'DJB_X', no: '41111', name: '궁동네거리', lat: BUS0.lat, lng: BUS0.lng }] }),
        '/api/arrivals': (x, now) => ({ at: now.t, list }) } });
      w.T.SC.bus.verifiedStops['108'] = ['DJB_X'];            // DJB_X는 108번만 방향 확인됨
      w.T.st.subway = null; w.T.st.presetPos.haksa = { ...P }; w.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; w.T.st.originKey = 'haksa';
      await w.T.loadStops();
      const r = w.T.computeRoutes();
      return { w, A: L(r.list).A, bus: L(r.list).A.bus, busDir: L(r.list).A.busDir };
    };
    let u = await go(mk([{ name: '108', type: '일반' }, { name: '999', type: '일반' }]), [{ routeNo: '999', routeId: 'DJBR999', arrSec: 420, prevCnt: 2 }, { routeNo: '108', routeId: 'DJBR108', arrSec: 900, prevCnt: 6 }]);
    // update12: 확인된 노선(108)이 있는 경로에서는 방향 미확인 노선(999) 차량을 아예 타지 않음 (먼저 와도) → 999번이 '확인됨'으로 승격될 일이 없음
    const wait01 = (u.A.steps.find((s0) => s0.type === 'wait') || {}).note || '';
    const u01 = u;
    u = await go(mk([{ name: '108', type: '일반' }, { name: '999', type: '일반' }]), [{ routeNo: '999', routeId: 'DJBR999', arrSec: 420, prevCnt: 2 }]);
    ok('F10-01 노선별 방향: 108번만 확인된 정류장에서 미확인 999번이 먼저 와도 999번은 타지 않고 108번으로 계산 · 999번만 오면 도착정보 없음(미확인) — 승격 안 됨',
      u01.bus.routeNo === '108' && u01.busDir === 'manual' && wait01.includes('999번) 제외') && !u.bus && u.A.avail === 'unknown', `${wait01} / 999만: ${u.A.why.join(' / ')}`);
    u = await go(mk([{ name: '108', type: '일반' }, { name: '999', type: '일반' }]), [{ routeNo: '108', routeId: 'DJBR108', arrSec: 420, prevCnt: 2 }, { routeNo: '999', routeId: 'DJBR999', arrSec: 900, prevCnt: 6 }]);
    ok('F10-02 같은 정류장에서 확인된 108번을 타면 방향 확인됨 (update12: 노선 정보가 없을 때 수동 확인 목록으로 manual)', u.bus.routeNo === '108' && u.busDir === 'manual' && u.A.avail === 'ok', u.A.why.join(' / '));
    u = await go(mk([{ name: '108', type: '일반' }, { name: '48', type: '좌석' }], { fare: null, fareMin: 1550, fareMax: 2900 }), [{ routeNo: '48', routeId: 'DJBR48', arrSec: 420, prevCnt: 2 }, { routeNo: '108', routeId: 'DJBR108', arrSec: 900, prevCnt: 6 }]);
    const ride = u.A.steps.find((x) => x.type === 'ride'), wait = u.A.steps.find((x) => x.type === 'wait');
    ok('F10-03 일반·좌석 혼재: 요금(일반 기준)·대기·승차 안내·경로 요약 모두 좌석버스(48) 제외', u.A.fare === 1550 && u.bus.routeNo === '108' && /^108번 대기|108번 버스 대기/.test(wait.label) && ride.label === '108번 버스' && !/48/.test(u.A.sub) && u.w.T.st.plans[0].board.routeNos.join() === '108',
      `${wait.label} · ${ride.label} · ${u.A.sub}`);

    /* ----- update11: 버스→버스 환승 요금 (대전 버스조합 환승 규정: 높은 요금 기준 · 같은 노선 불가 · 최대 3회) ----- */
    const B1 = { lat: 36.3550, lng: 127.3600 }, B2 = { lat: 36.3500, lng: 127.3900 };
    const busStep = (vehicles, a, b) => ({ type: 'BUS', sec: 600, m: 3000, stops: ['궁동네거리', '중간', '끝'], vehicles, start: a, head: { lat: a.lat, lng: a.lng + 0.001 }, end: b });
    const walkStep = (a, b) => ({ type: 'WALKING', sec: 120, m: 100, stops: [], vehicles: [], start: a, end: b });
    const subStep = { type: 'SUBWAY', sec: 1150, m: 9100, stops: ['월평', '갈마', '대전역'], vehicles: [{ name: '1호선', type: '일반' }], start: HUB, end: { lat: 36.3324, lng: 127.4343 } };
    const mk2 = (steps, fare) => ({ at: 0, routes: [{ type: 'BUS', totalSec: 2600, fare: null, ...fare, steps: [walkStep(P, BUS0), ...steps] }] });
    const arr = [{ routeNo: '108', routeId: 'DJBR108', arrSec: 420, prevCnt: 2 }];
    const fareOf = async (tr) => (await go(tr, arr)).w.T.st.plans[0].fare;
    let f = await fareOf(mk2([busStep([{ name: '108', type: '일반' }], BUS0, B1), walkStep(B1, B1), busStep([{ name: '102', type: '일반' }], B1, B2)], { fareMin: 1500, fareMax: 2800 }));
    ok('U11-01 시내버스 → 시내버스(다른 노선), 카카오 요금 없음: 공식 규정으로 1,500원', f.fare === 1500 && f.src === '공식 환승 규정', JSON.stringify(f));
    f = await fareOf(mk2([busStep([{ name: '108', type: '일반' }], BUS0, B1), walkStep(B1, B1), busStep([{ name: '유성1', type: '마을' }], B1, B2)], {}));
    ok('U11-02 시내버스 → 마을버스: 높은 요금(시내 1,500원)', f.fare === 1500, JSON.stringify(f));
    f = await fareOf(mk2([busStep([{ name: '108', type: '일반' }], BUS0, B1), walkStep(B1, B1), busStep([{ name: '108', type: '일반' }], B1, B2)], {}));
    ok('U11-03 같은 노선끼리 연달아 타면 환승 할인 없음 → 요금 미확인', f.fare === null, JSON.stringify(f));
    f = await fareOf(mk2([busStep([{ name: '108', type: '일반' }], BUS0, B1), walkStep(B1, B1), busStep([{ name: '48', type: '좌석' }], B1, B2)], { fareMin: 1500 }));
    ok('U11-04 좌석버스가 섞이면 요금 미확인 (좌석 요금 미확인)', f.fare === null, JSON.stringify(f));
    f = await fareOf(mk2([busStep([{ name: '108', type: '일반' }], BUS0, B1), walkStep(B1, B1), busStep([{ name: '102', type: '일반' }], B1, HUB), walkStep(HUB, HUB), subStep], { fareMin: 1550, fareMax: 2900 }));
    ok('U11-05 시내버스 2회 + 지하철: 카카오 min이 공식 합계(1,550)와 같으면 인정', f.fare === 1550 && f.cityOnly === true, JSON.stringify(f));
    f = await fareOf(mk2([busStep([{ name: '108', type: '일반' }], BUS0, B1), walkStep(B1, B1), busStep([{ name: '102', type: '일반' }], B1, HUB), walkStep(HUB, HUB), subStep], { fareMin: 1500 }));
    ok('U11-06 버스 + 지하철인데 카카오 min이 공식 합계와 다르면 미확인', f.fare === null, JSON.stringify(f));
    const b4 = [1, 2, 3, 4].map((i) => [walkStep(B1, B1), busStep([{ name: String(100 + i), type: '일반' }], B1, B2)]).flat().slice(1);
    f = await fareOf(mk2([busStep([{ name: '108', type: '일반' }], BUS0, B1), walkStep(B1, B1), ...b4], {}));
    ok('U11-07 환승 4회(최대 3회 초과) → 요금 미확인', f.fare === null, JSON.stringify(f));
  }
  /* ===== update12: 동적 경로 탐색·비교 구조 (N12) ===== */
  {
    const P = { lat: 36.3640, lng: 127.3420 }, BUS0 = { lat: 36.3632, lng: 127.3428 }, HEAD = { lat: 36.3632, lng: 127.3438 };
    const ST = { 116: { lat: 36.3537, lng: 127.3415, n: '유성온천' }, 115: { lat: 36.3610, lng: 127.3710, n: '갑천' }, 114: { lat: 36.3583, lng: 127.3638, n: '월평' },
      117: { lat: 36.3565, lng: 127.3300, n: '구암' }, 118: { lat: 36.3600, lng: 127.3200, n: '현충원' }, 120: { lat: 36.3700, lng: 127.3150, n: '노은' } };
    const DJ = { lat: 36.3324, lng: 127.4343 };
    const W = (sec, a, b) => ({ type: 'WALKING', sec, m: Math.round(sec * 1.1), stops: [], vehicles: [], start: a, end: b });
    const BUS = (names, stops, sec, a = BUS0, b = null, type = '일반') => ({ type: 'BUS', sec, m: sec * 5, stops, vehicles: names.map((n) => ({ name: n, type })), start: a, head: HEAD, end: b });
    const SUB = (from, sec) => ({ type: 'SUBWAY', sec, m: sec * 8, stops: [ST[from].n, '대전역'], vehicles: [{ name: '1호선', type: '일반' }], start: ST[from], end: DJ });
    // 카카오 대중교통 응답(모의): 버스+지하철, 같은 경로의 다른 노선 목록(중복), 버스만, 지하철만
    const routesA = () => ({ at: 0, routes: [
      { type: 'BUS_AND_SUBWAY', totalSec: 2600, fare: 1650, steps: [W(180, P, BUS0), BUS(['104'], ['궁동네거리', '유성구청', '갑천역'], 600, BUS0, ST[115]), W(120, ST[115], ST[115]), SUB(115, 1260), W(60, DJ, DJ)] },
      { type: 'BUS_AND_SUBWAY', totalSec: 2700, fare: 1650, steps: [W(200, P, BUS0), BUS(['104', '106'], ['궁동네거리', '갑천역'], 640, BUS0, ST[115]), W(120, ST[115], ST[115]), SUB(115, 1260), W(60, DJ, DJ)] },   // 위와 같은 정류장·역 순서
      { type: 'BUS', totalSec: 3000, fare: 1500, steps: [W(180, P, BUS0), BUS(['601'], ['궁동네거리', '대전역'], 2100, BUS0, DJ), W(60, DJ, DJ)] },
      { type: 'SUBWAY', totalSec: 2500, fare: 1650, steps: [W(900, P, ST[116]), SUB(116, 1380), W(60, DJ, DJ)] },
    ] });
    const stationsA = () => ({ stations: [...Object.entries(ST).map(([, v]) => ({ name: `${v.n}역 대전1호선`, category: '교통,수송 > 지하철,전철 > 대전1호선', lat: v.lat, lng: v.lng, d: 0 })),
      { name: '대전역 대전1호선', lat: DJ.lat, lng: DJ.lng }, { name: '어딘가역 2호선', lat: 36.36, lng: 127.33 }] });
    const ride = { 116: 23, 115: 21, 114: 19, 117: 25, 118: 27, 120: 30 };
    const subwayA = (x) => { const from = Number(new URLSearchParams(x.split('?')[1]).get('from')); const t = timetable(23); const set = { from: t.days[0][0].from, ride: ride[from] || 20 }; return { mock: false, days: { 0: { 0: set, 1: set }, 1: { 0: set, 1: set } } }; };
    const q = (x, k) => Number(new URLSearchParams(x.split('?')[1]).get(k));
    const tashuA = (x) => ({ mock: false, stations: [{ id: 'T' + q(x, 'lat'), name: '대여소 ' + q(x, 'lat'), d: 90, bikes: 4, lat: q(x, 'lat') + 0.0005, lng: q(x, 'lng') }] });
    const driveA = (x) => (q(x, 'dlat') < 36.34 ? { durationSec: 1500, distanceM: 11000, taxiFare: 13000 } : { durationSec: 480, distanceM: 2500, taxiFare: 5000 });
    const arrA = (x, now) => ({ at: now.t, list: [{ routeNo: '601', routeId: 'DJBR601', arrSec: 420, prevCnt: 3 }, { routeNo: '104', routeId: 'DJBR104', arrSec: 540, prevCnt: 4 }] });
    const api12 = (extra = {}) => ({ '/api/transit': routesA, '/api/stations': stationsA, '/api/subway': subwayA, '/api/tashu': tashuA, '/api/drive': driveA, '/api/arrivals': arrA,
      '/api/stops': () => ({ stops: [{ id: 'DJB_X', no: '41111', name: '궁동네거리', lat: BUS0.lat, lng: BUS0.lng }] }),
      '/api/walk': () => ({ sec: 240, m: 280 }), '/api/bike': () => ({ sec: 600, m: 2600 }), ...extra });
    const go12 = async (o = {}) => {
      const w = world({ cfg: { route: true }, ...o, api: api12(o.api) });
      Object.assign(w.T.SC.bus.verifiedStops, { 104: ['DJB_X'], 601: ['DJB_X'] });
      w.T.SC.subway.zoneConfirmed = { '114-104': 1, '113-104': 1, '115-104': 2, '116-104': 2, '117-104': 2, '118-104': 2, '120-104': 2 };
      w.T.st.presetPos.haksa = { ...P }; w.T.st.origin = { key: 'haksa', name: '시험 출발지', lat: P.lat, lng: P.lng, verified: true }; w.T.st.originKey = 'haksa';
      await w.T.loadStops();
      const r = w.T.computeRoutes();
      return { w, ...r, best: w.T.pickBest(r.list) };
    };
    const sleep = (ms) => new Promise((rr) => setTimeout(rr, ms));

    let g = await go12();
    const tr12 = g.list.filter((r) => r.kind === 'transit'), order = g.list.map((r) => r.arrive);
    ok('N12-01 일반 대중교통: 카카오 후보 전체를 평가 · 같은 정류장·역 순서는 하나로 합침 (4개 → 3개, 억지로 5개 채우지 않음)', g.transitAll.length === 3 && tr12.length === 3 && new Set(tr12.map((r) => r.id)).size === 3, tr12.map((r) => r.sub).join(' / '));
    ok('N12-02 수단 조합 우선순위 없음: 버스만·지하철만·버스+지하철이 모두 후보이고 도착 순으로 정렬', ['버스', '지하철', '버스 + 지하철'].every((n) => tr12.some((r) => r.name === n)) && order.every((t, i) => i === 0 || g.list[i - 1].avail === 'no' || t >= order[i - 1]));
    ok('N12-03 화면 구성: 대중교통 + 전 구간 택시 1 + 전 구간 타슈 1 + 타슈 연계 1 + 택시 연계 1, 복합경로 표시는 연계 경로에만', g.list.length === tr12.length + 4 && ['taxi', 'tashu', 'tashuMix', 'taxiMix'].every((k) => g.list.filter((r) => r.kind === k).length === 1)
      && g.list.filter((r) => r.mix).map((r) => r.kind).sort().join() === 'tashuMix,taxiMix');
    const base12 = g.baseline;
    ok('N12-04 비교 기준 = 이용 가능·요금 확인된 가장 빠른 일반 대중교통 (하나만)', base12 && base12.kind === 'transit' && base12.avail === 'ok' && base12.fare != null && g.list.filter((r) => r.baseline).length === 1
      && tr12.filter((r) => r.avail === 'ok' && r.fare != null).every((r) => r.arrive >= base12.arrive), base12 && `${base12.sub} ${Math.round(base12.total)}분 ${base12.fare}원`);
    ok('N12-05 근처 지하철역 검색 이름 해석: \'○○역 대전1호선\' → 역번호 · 대전역(목적지)·모르는 역 제외 · 지역명 \'대전\'을 대전역으로 보지 않음', g.w.T.stationFromPlace('월평역 대전1호선').stNum === '114' && g.w.T.stationFromPlace('유성온천역(충남대.목원대) 대전1호선').stNum === '116'
      && g.w.T.stationFromPlace('대전 지하철1호선') === null && g.w.T.stationFromPlace('어딘가역 2호선') === null && g.hubs.every((hb) => hb.stNum !== '104'));
    const hubSet = g.hubs.map((hb) => hb.stNum);
    ok('N12-06 환승역 후보: 근처 지하철역 검색 + 카카오 경로의 승차역, 1차 추정 상위 6곳', hubSet.length === 6 && hubSet.includes('116') && hubSet.includes('115') && hubSet.includes('114'), hubSet.join(','));
    const mt = g.mix.tashu, okT = mt.filter((r) => r.avail === 'ok').sort((a, b) => a.arrive - b.arrive), repT = g.list.find((r) => r.kind === 'tashuMix');
    ok('N12-07 환승역마다 타슈 연계를 따로 계산하고, 이용 가능 확인된 가장 빠른 것을 대표로', mt.length === 6 && okT.length >= 1 && repT.id === okT[0].id, mt.map((r) => `${r.hub.stNum}:${r.avail}:${Math.round(r.total)}`).join(' '));
    ok('N12-08 비교 기준(대중교통)의 환승역에 묶이지 않음: 타슈 연계 대표 환승역이 비교 기준 경로와 다를 수 있음', repT.hub.stNum === '114' && !/월평/.test(base12.sub), `타슈 연계 ${repT.hub.name} · 비교 기준 ${base12.sub}`);
    const repX = g.list.find((r) => r.kind === 'taxiMix'), okX = g.mix.taxi.filter((r) => r.avail === 'ok').sort((a, b) => a.arrive - b.arrive);
    ok('N12-09 택시 연계도 환승역별 계산 후 대표 1개 · 길찾기 API를 안 부른 후보는 직선거리 추정이라 대표가 안 됨', repX.id === okX[0].id && g.mix.taxi.filter((r) => r.why.some((x) => x.includes('직선거리'))).length === 4, `${repX.hub.name}`);
    // 호출량: 위치 변경·새로고침 1회당 상한 (scenario.js search 값)
    const c0 = { ...g.w.calls };
    ok('N12-10 1회 로딩 호출량: 대중교통 1 · 지하철역 검색 1 · 택시 1+2 · 자전거 2+1 · 도보 3 (출발 대여소 1 + 반납 후 2) · 공식 역간 거리는 서로 다른 지하철 구간당 1번 이하(카카오 호출 수는 그대로)', c0['/api/transit'] === 1 && c0['/api/stations'] === 1 && c0['/api/drive'] === 3 && c0['/api/bike'] === 3 && c0['/api/walk'] === 3 && c0['/api/stdist'] >= 1 && c0['/api/stdist'] <= new Set(g.w.calls.urls.filter((u) => u.startsWith('/api/stdist'))).size,
      ['transit', 'stations', 'drive', 'bike', 'walk'].map((k) => `${k} ${c0['/api/' + k]}`).join(' · '));
    await g.w.T.loadArrivals(); await g.w.T.loadArrivals();
    ok('N12-11 30초 갱신 2번: 카카오 호출(대중교통·지하철역·택시·도보·자전거) 추가 0회', ['transit', 'stations', 'drive', 'bike', 'walk'].every((k) => g.w.calls['/api/' + k] === c0['/api/' + k]));
    await g.w.T.loadStops(true);
    ok('N12-12 새로고침: 같은 상한으로 모두 다시 조회 (재사용 캐시 없음)', ['transit', 'stations', 'drive', 'bike', 'walk'].every((k) => g.w.calls['/api/' + k] === 2 * c0['/api/' + k]));
    g.w.T.setPoint('dest', { name: '대전역 동광장', lat: 36.3330, lng: 127.4350 }); await sleep(30);
    ok('N12-13 목적지만 변경: 근처 지하철역은 출발지 기준이라 다시 검색하지 않음 · 대중교통·택시는 다시 조회', g.w.calls['/api/stations'] === 2 && g.w.calls['/api/transit'] === 3 && g.w.calls['/api/drive'] === 9);
    // 첫 도보 길찾기 상한: 첫 단계가 BUS인 경로가 서로 다른 탑승 지점 5곳 → 도보 길찾기 3회까지, 나머지는 직선거리 규칙
    const five = () => ({ routes: [0, 1, 2, 3, 4].map((i) => ({ type: 'BUS', totalSec: 2000 + i * 60, fare: 1500, steps: [BUS(['70' + i], ['정류장' + i, '대전역'], 2000, { lat: BUS0.lat + i * 0.001, lng: BUS0.lng }, DJ), W(60, DJ, DJ)] })) });
    g = await go12({ api: { '/api/transit': five } });
    const walk0Calls = g.w.calls.urls.filter((u) => u.startsWith('/api/walk') && u.includes(`olat=${P.lat.toFixed(4)}`)).length;
    ok('N12-14 첫 도보 길찾기 상한 3회 (서로 다른 탑승 지점 5곳) · 탑승 정류장 추가 조회 상한 4회', walk0Calls - 1 === 3 && g.w.calls.urls.filter((u) => u.startsWith('/api/stops')).length - 1 <= 4, `첫 도보 ${walk0Calls - 1}회`);
    // 표시 개수: 서로 다른 후보 8개 → 실시간 평가 8 · 표시 5 · 비교 기준이 6번째 이후면 5번째와 바꿔 표시
    // 86번만 일반버스(공식 환승 규정으로 요금 확인), 나머지는 좌석버스(요금 미확인 → 비교 기준 불가)
    const eight = () => ({ routes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ type: 'BUS', totalSec: 2000 + i * 60, fare: null, steps: [W(120, P, BUS0), BUS(['8' + i], ['궁동네거리', '목적' + i], 1500 + i * 60, BUS0, DJ, i === 6 ? '일반' : '좌석'), W(60, DJ, DJ)] })) });
    g = await go12({ api: { '/api/transit': eight, '/api/arrivals': (x, now) => ({ at: now.t, list: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ routeNo: '8' + i, routeId: 'DJBR8' + i, arrSec: 300, prevCnt: 2 })) }) } });
    Object.assign(g.w.T.SC.bus.verifiedStops, Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ['8' + i, ['DJB_X']])));
    let r8 = g.w.T.computeRoutes(), shown8 = r8.list.filter((r) => r.kind === 'transit');
    ok('N12-15 서로 다른 후보 8개 → 표시 5개 · 요금 확인된 경로(86번)가 7번째여도 비교 기준으로 화면에 포함', r8.transitAll.length === 8 && shown8.length === 5 && r8.baseline && /86번/.test(r8.baseline.sub) && shown8.includes(r8.baseline), shown8.map((r) => r.sub).join(' / '));
    // 추가 비용 허용 범위
    g = await go12();
    const bests = [0, 3000, 7000, null].map((a) => g.w.T.pickBest(g.list, a));
    const base = g.baseline, okAll = g.list.filter((r) => r.avail === 'ok' && r.fare != null && !r.plus);
    ok('N12-16 추가 비용 0원: 비교 기준 요금 이하에서 가장 빠른 경로', bests[0] && bests[0].fare <= base.fare && okAll.filter((r) => r.fare <= base.fare).every((r) => r.arrive >= bests[0].arrive - 60000), bests[0] && `${bests[0].name} ${bests[0].fare}원`);
    ok('N12-17 허용 범위를 넓히면(+3,000 → +7,000 → 상관없음) 예산 안에서 더 빠른 경로로 · 상관없음은 확인된 경로 중 가장 빠른 것', bests.every((b, i) => i === 0 || b.arrive <= bests[i - 1].arrive)
      && bests[2].fare <= base.fare + 7000 && bests[3].id === okAll.slice().sort((a, b) => a.arrive - b.arrive)[0].id, bests.map((b) => `${b.name}(${b.fare})`).join(' → '));
    ok('N12-18 추천 대상은 항상 화면에 표시된 경로 · 기본 허용 범위는 0원', bests.every((b) => g.list.includes(b)) && g.w.T.st.allow === 0 && g.w.T.pickBest(g.list) === bests[0]);
    // 비교 기준이 없으면: 시간·요금 비교·추천 보류 (경로는 표시)
    g = await go12({ api: { '/api/transit': () => { const r = routesA(); r.routes = r.routes.filter((x) => x.steps.some((st0) => st0.type === 'BUS')); r.routes.forEach((x) => { x.fare = null; x.steps.forEach((st0) => st0.vehicles.forEach((v) => { if (st0.type === 'BUS') v.type = '좌석'; })); }); return r; } } });   // 요금 미확인(카카오 요금 없음·좌석버스). 지하철만 경로는 update12 최종부터 공식 운임(2구간)으로 계산되므로 이 시험에서 뺌
    ok('N12-19 대중교통 요금이 모두 미확인 → 비교 기준 없음 · 추천 보류 · 경로는 계속 표시', g.baseline === null && g.best === null && g.list.length >= 5);
    // 늦은 응답: 출발지를 바꾼 뒤 도착한 이전 출발지의 지하철역 검색 결과는 버림
    const D2 = { lat: 36.3700, lng: 127.3405 };
    const w3 = world({ cfg: { route: true }, delayOf: (x) => (x.startsWith('/api/stations') && x.includes(`lat=${P.lat.toFixed(4)}`) ? 60 : 3),
      api: api12({ '/api/stations': (x) => (x.includes(`lat=${P.lat.toFixed(4)}`) ? { stations: [{ name: '노은역 대전1호선', lat: ST[120].lat, lng: ST[120].lng }] } : { stations: [{ name: '월평역 대전1호선', lat: ST[114].lat, lng: ST[114].lng }] }) }) });
    w3.T.st.presetPos.haksa = { ...P }; w3.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; w3.T.st.originKey = 'haksa';
    const h1 = w3.T.loadHubs(); await sleep(5);
    w3.T.setPoint('origin', { key: 'westgate', name: '두 번째 출발지', lat: D2.lat, lng: D2.lng, verified: true }); await h1; await sleep(120);
    ok('N12-20 출발지 변경 후 늦게 온 이전 출발지의 지하철역 검색 결과는 적용 안 함', w3.T.st.hubSearch.map((x) => x.stNum).join() === '114', w3.T.st.hubSearch.map((x) => x.name).join());
    // 화면: A~E 글자 없음, 도착 순 번호, 복합경로·비교 기준·추천 표시, 추가 비용 버튼 4개
    const dom = (() => { const byId = {}; const mk = (tag) => ({ nodeType: 1, tag, attrs: {}, children: [], className: '', textContent: '', hidden: false, value: '', classList: { toggle() {} },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, remove() {} });
      return { byId, document: { createElement: mk, createTextNode: (t) => String(t), visibilityState: 'visible', head: mk('head'), querySelector: (sel) => byId[sel] || (byId[sel] = mk(sel)) } }; })();
    const all = (n, f, out = []) => { if (n && typeof n === 'object') { if (f(n)) out.push(n); (n.children || []).forEach((c) => all(c, f, out)); } return out; };
    const txt = (n) => (typeof n === 'string' ? n : (n.children || []).map(txt).join(''));
    g = await go12({ doc: dom.document });
    g.w.T.render();
    const content = dom.byId['#content'], cards = all(content, (n) => n.tag === 'article');
    const letters = cards.map((c) => txt(all(c, (n) => n.className === 'letter')[0]));
    const mixCards = cards.filter((c) => all(c, (n) => n.className === 'tag mix').length);
    const allowBtns = ((all(content, (n) => n.className === 'allow')[0] || {}).children || []).filter((n) => n.tag === 'button');   // 고정 버튼 4개 (직접 입력의 '적용' 버튼은 별도 form 안)
    ok('N12-21 화면: A~E 글자 없이 도착 순 번호 · 복합경로 표시는 타슈·택시 연계 카드 2장에만 · 비교 기준·추천 표시 1개씩 · 추가 비용 버튼 4개(0원 선택)', letters.join() === cards.map((_, i) => String(i + 1)).join()
      && !letters.some((l) => /[A-E]/.test(l)) && mixCards.length === 2 && mixCards.every((c) => /^(tashuMix|taxiMix)$/.test(c.attrs['data-kind']))
      && cards.filter((c) => /비교 기준/.test(txt(all(c, (n) => n.className === 'rh')[0]))).length === 1 && cards.filter((c) => /추천/.test(txt(all(c, (n) => n.className === 'rh')[0]))).length === 1
      && allowBtns.length === 4 && allowBtns.filter((b) => b.attrs['aria-pressed'] === 'true').map(txt).join() === '0원', letters.join(','));
    const rhTxt = (c) => txt(all(c, (n) => n.className === 'rh')[0]);
    const nonBase = cards.filter((c) => !/비교 기준|이용 불가/.test(rhTxt(c)));
    ok('N12-22 화면 비교 문구는 모두 같은 비교 기준으로 ("비교 기준보다 N분 빠름/늦음" 또는 같은 시각)', nonBase.length >= 1 && nonBase.every((c) => /비교 기준(보다 \d+분 (빠름|늦음)|과 같은 시각)/.test(txt(c))), `${nonBase.length}장`);
    /* ===== 버스 운행 방향 자동 검증 · 추가 비용 직접 입력 · 화면 null (D12 · update12) ===== */
    {
      // 공식 노선(모의): 104번 R104 = 궁동네거리(남쪽, DJB_X) → 유성구청 → 갑천역 → [회차] → 갑천역(건너편) → 유성구청 → 궁동네거리(건너편, DJB_X2)
      const XS = { lat: BUS0.lat - 0.0001, lng: BUS0.lng }, XN = { lat: BUS0.lat + 0.0001, lng: BUS0.lng };
      const S_ = (nodeId, name, ord, pt, ud, no) => ({ nodeId, name, no: no || null, ord, lat: pt.lat, lng: pt.lng, ud });
      const MID = { lat: 36.3600, lng: 127.3560 }, MID2 = { lat: 36.3601, lng: 127.3560 };
      const stops104 = () => [S_('DJB_X', '궁동네거리', 1, XS, 0, '41111'), S_('DJB_M', '유성구청', 2, MID, 0), S_('DJB_G', '갑천역', 3, ST[115], 0),
        S_('DJB_G2', '갑천역', 4, { lat: ST[115].lat + 0.0001, lng: ST[115].lng }, 1), S_('DJB_M2', '유성구청', 5, MID2, 1), S_('DJB_X2', '궁동네거리', 6, XN, 1, '41112')];
      const R = (stops, o = {}) => ({ routeId: o.id || 'R104', routeNo: '104', complete: o.complete ?? true, hasUd: stops.some((x) => x.ud != null), stops });
      const info = (...routes) => () => ({ mock: false, routeNo: '104', routes });
      // 카카오 후보: 104번(궁동네거리 → 갑천역) + 지하철 1개 경로
      const tr104 = () => ({ routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 2600, fare: 1650, steps: [W(180, P, BUS0), BUS(['104'], ['궁동네거리', '유성구청', '갑천역'], 600, BUS0, ST[115]), W(120, ST[115], ST[115]), SUB(115, 1260), W(60, DJ, DJ)] }] });
      const stopsBoth = () => ({ stops: [{ id: 'DJB_X', no: '41111', name: '궁동네거리', lat: XS.lat, lng: XS.lng }, { id: 'DJB_X2', no: '41112', name: '궁동네거리', lat: XN.lat, lng: XN.lng }] });
      const nodeOf = (x) => new URLSearchParams(x.split('?')[1]).get('nodeId');
      // 도착정보(모의): 정류장별 목록. 기본 = DJB_X에 R104 9분 뒤, 건너편 DJB_X2에 반대 방향 차량 2분 뒤 (둘 다 TAGO)
      const arrBy = (m) => (x, now) => ({ source: 'tago', at: now.t, list: m[nodeOf(x)] || [] });
      const ARR0 = { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 4 }], DJB_X2: [{ routeNo: '104', routeId: 'R104', arrSec: 120, prevCnt: 1 }] };
      const d12 = async (o = {}) => {
        const w = world({ cfg: { route: true }, doc: o.doc, fail: o.fail, delayOf: o.delayOf, api: api12({ '/api/transit': tr104, '/api/stops': stopsBoth, '/api/arrivals': arrBy(o.arr || ARR0),
          '/api/busroute': o.route || info(R(stops104())), ...(o.api || {}) }) });
        if (o.man) Object.assign(w.T.SC.bus.verifiedStops, o.man);
        w.T.SC.subway.zoneConfirmed = { '114-104': 1, '113-104': 1, '115-104': 2, '116-104': 2, '117-104': 2, '118-104': 2, '120-104': 2 };
        if (o.zone) w.T.SC.subway.zoneConfirmed = o.zone;
        w.T.st.presetPos.haksa = { ...P }; w.T.st.origin = { key: 'haksa', name: '시험 출발지', lat: P.lat, lng: P.lng, verified: true }; w.T.st.originKey = 'haksa';
        await w.T.loadStops();
        const r = w.T.computeRoutes(), t = r.list.find((x) => x.kind === 'transit');
        return { w, ...r, t, best: w.T.pickBest(r.list) };
      };
      const waitMin = (t) => (t.steps.find((s) => s.type === 'wait') || {}).min;
      const unconfirmed = [];                   // 방향 미확인 경로 모음 → D12-13에서 비교 기준·추천 제외를 한 번에 확인
      const keep = (g) => { if (g.t && !['auto', 'manual'].includes(g.t.busDir)) unconfirmed.push(g); return g; };

      let d = await d12();
      ok('D12-01 정상 방향: 공식 노선의 같은 운행 구간에서 승차→하차 순서·정류장 수·이름이 맞으면 자동 확인 · 실시간 노선 ID 일치 차량만 · 비교 기준 가능',
        d.t.busDir === 'auto' && d.t.bus.stop.id === 'DJB_X' && d.t.bus.routeId === 'R104' && d.t.avail === 'ok' && d.baseline === d.t && /공식 노선 정보로 확인/.test(d.t.steps.find((s) => s.type === 'wait').note),
        `${d.t.busDir} · ${d.t.bus.stop.id} · 대기 ${Math.round(waitMin(d.t))}분`);
      ok('D12-02 반대 방향 차량 제외: 건너편 같은 이름 정류장(DJB_X2)의 2분 뒤 차량은 타지 않고 확인된 정류장의 9분 뒤 차량으로 계산', d.t.bus.stop.id === 'DJB_X' && Math.abs(waitMin(d.t) - (9 - 3)) < 0.01, `대기 ${waitMin(d.t)}분`);
      // 경로 좌표로는 남쪽(DJB_X)이 '진행 방향 오른쪽'이지만, 공식 노선이 북쪽(DJB_X2)에서 탄다고 하면 공식 정보를 따름
      d = await d12({ route: info(R([S_('DJB_X2', '궁동네거리', 1, XN, 0, '41112'), S_('DJB_M', '유성구청', 2, MID, 0), S_('DJB_G', '갑천역', 3, ST[115], 0), S_('DJB_G2', '갑천역', 4, { lat: ST[115].lat + 0.0001, lng: ST[115].lng }, 1), S_('DJB_X', '궁동네거리', 5, XS, 1, '41111')])),
        arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 360, prevCnt: 2 }], DJB_X2: [{ routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 4 }] } });
      ok('D12-03 같은 이름 다른 정류장: 좌표 추정(오른쪽)과 달라도 공식 노선의 승차 정류장 ID(DJB_X2)에서만 탐 (좌표 추정 쪽 6분 뒤 차량은 안 탐)', d.t.busDir === 'auto' && d.t.bus.stop.id === 'DJB_X2' && Math.abs(waitMin(d.t) - 6) < 0.01, `${d.t.bus.stop.id}`);
      // 복수 노선 ID: R104B(지선·변형)는 갑천역으로 가지 않음 → 확인된 노선 ID는 R104뿐 · R104B 차량(3분 뒤)은 타지 않음
      d = await d12({ route: info(R(stops104()), R([S_('DJB_X', '궁동네거리', 1, XS, 0, '41111'), S_('DJB_Q', '다른곳', 2, MID, 0), S_('DJB_Q2', '종점', 3, { lat: 36.40, lng: 127.30 }, 0)], { id: 'R104B' })),
        arr: { DJB_X: [{ routeNo: '104', routeId: 'R104B', arrSec: 300, prevCnt: 2 }, { routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 4 }] } });
      ok('D12-04 같은 번호 복수 노선 ID: 카카오 구간과 맞는 노선 ID(R104)만 확인 · 다른 노선 ID(R104B) 차량은 먼저 와도 타지 않음', d.t.busDir === 'auto' && d.t.bus.routeId === 'R104' && Math.abs(waitMin(d.t) - 6) < 0.01, `${d.t.bus.routeId} 대기 ${waitMin(d.t)}분`);
      // 한 경로에 자동 확인된 104번과 노선 정보 없는 999번: 999번이 먼저 와도 타지 않음
      const tr2 = () => ({ routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 2600, fare: 1650, steps: [W(180, P, BUS0), BUS(['104', '999'], ['궁동네거리', '유성구청', '갑천역'], 600, BUS0, ST[115]), W(120, ST[115], ST[115]), SUB(115, 1260), W(60, DJ, DJ)] }] });
      d = await d12({ api: { '/api/transit': tr2 }, route: (x) => (x.includes('routeNo=999') ? { mock: false, routeNo: '999', routes: [] } : info(R(stops104()))()),
        arr: { DJB_X: [{ routeNo: '999', routeId: 'R999', arrSec: 300, prevCnt: 2 }, { routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 4 }] } });
      ok('D12-04b 자동 확인 노선(104)과 미확인 노선(999)이 같이 있으면 미확인 노선 차량은 먼저 와도 타지 않음 · 안내에 제외 표시', d.t.bus.routeNo === '104' && d.t.busDir === 'auto' && d.t.avail === 'ok' && d.t.steps.find((s0) => s0.type === 'wait').note.includes('999번) 제외'), d.t.steps.find((s0) => s0.type === 'wait').note);
      // 목록의 차를 모두 놓친 경우(가정 출발): 노선 번호와 노선 ID는 같은 차량(기준이 된 마지막 차)에서 — 다른 노선 ID와 섞이면 방향 판정이 틀어짐
      d = await d12({ api: { '/api/transit': tr2 }, route: (x) => (x.includes('routeNo=999') ? { mock: false, routeNo: '999', routes: [info(R(stops104()))().routes[0]].map((r0) => ({ ...r0, routeId: 'R999', routeNo: '999' })) } : info(R(stops104()))()),
        arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 60, prevCnt: 1 }, { routeNo: '999', routeId: 'R999', arrSec: 120, prevCnt: 1 }] } });
      ok('D12-04c 목록의 차를 모두 놓쳐 다음 차를 가정할 때 노선 번호·노선 ID가 같은 차량에서 옴 (999번 ↔ R999) · 가정값이라 추천 제외', d.t.bus && !d.t.bus.catchable && d.t.bus.routeNo === '999' && d.t.bus.routeId === 'R999' && d.t.avail !== 'ok', d.t.bus && `${d.t.bus.routeNo}:${d.t.bus.routeId}`);
      const XS3 = { lat: BUS0.lat - 0.0003, lng: BUS0.lng };
      d = keep(await d12({ api: { '/api/stops': () => ({ stops: [...stopsBoth().stops, { id: 'DJB_X3', no: '41113', name: '궁동네거리', lat: XS3.lat, lng: XS3.lng }] }) },
        route: info(R(stops104()), R([S_('DJB_X3', '궁동네거리', 1, XS3, 0), S_('DJB_M', '유성구청', 2, MID, 0), S_('DJB_G', '갑천역', 3, ST[115], 0)], { id: 'R104C' })) }));
      ok('D12-05 복수 노선 ID의 승차 정류장이 서로 다름(모호): 자동 확인 안 함 → 방향 미확인 · 비교 기준 아님', d.t.busDir !== 'auto' && d.t.avail !== 'ok' && d.baseline === null, `${d.t.busDir} · ${d.t.dirWhy}`);
      // 순환·회차: 승차 정류장을 노선이 두 번 지남 (상하행 코드 없음)
      d = keep(await d12({ route: info(R([S_('DJB_X', '궁동네거리', 1, XS, null), S_('DJB_M', '유성구청', 2, MID, null), S_('DJB_G', '갑천역', 3, ST[115], null), S_('DJB_Z', '순환', 4, { lat: 36.35, lng: 127.38 }, null), S_('DJB_X', '궁동네거리', 5, XS, null)])) }));
      ok('D12-06 순환·회차(승차 정류장 중복 경유): 어느 쪽 차량인지 알 수 없어 자동 확인 안 함', d.t.busDir !== 'auto' && d.t.avail !== 'ok' && /두 번/.test(d.t.dirWhy || ''), d.t.dirWhy);
      // 구간 중간에 상하행 코드가 바뀜(회차를 넘음)
      d = keep(await d12({ route: info(R([S_('DJB_X', '궁동네거리', 1, XS, 0), S_('DJB_M', '유성구청', 2, MID, 1), S_('DJB_G', '갑천역', 3, ST[115], 1)])) }));
      ok('D12-07 승차~하차 사이 상하행 코드가 바뀜(회차 넘음): 순번이 앞서도(1<3) 자동 확인 안 함', d.t.busDir !== 'auto' && d.t.avail !== 'ok', d.t.dirWhy);
      // 상하행 코드가 일부만 빠짐 → 같은 운행 구간인지 알 수 없음
      d = keep(await d12({ route: info(R([S_('DJB_X', '궁동네거리', 1, XS, 0), S_('DJB_M', '유성구청', 2, MID, null), S_('DJB_G', '갑천역', 3, ST[115], 0)])) }));
      const partialUd = d.t.busDir !== 'auto' && d.t.avail !== 'ok';
      // 상하행 코드가 노선 전체에 없음 → 정류장 수·이름 순서 대조로만 판단(맞으면 자동 확인)
      d = await d12({ route: info(R(stops104().map((x) => ({ ...x, ud: null })))) });
      ok('D12-08 상하행 코드: 일부 누락이면 확인 안 함 · 노선 전체에 없으면 정류장 수·이름 순서 대조로만 확인', partialUd && d.t.busDir === 'auto' && d.t.bus.stop.id === 'DJB_X', `일부 누락 → 미확인 / 전체 없음 → ${d.t.busDir}`);
      // 순번만 앞선 경우: 사이 정류장이 카카오(3개)보다 훨씬 많음(8개) · 이름이 안 맞음
      const many = [S_('DJB_X', '궁동네거리', 1, XS, 0), ...[2, 3, 4, 5, 6, 7].map((k) => S_('DJB_K' + k, '경유' + k, k, MID, 0)), S_('DJB_G', '갑천역', 8, ST[115], 0)];
      d = keep(await d12({ route: info(R(many)) }));
      const tooMany = d.t.busDir !== 'auto';
      d = keep(await d12({ route: info(R([S_('DJB_X', '궁동네거리', 1, XS, 0), S_('DJB_W', '전혀다른곳', 2, MID, 0), S_('DJB_W2', '엉뚱한곳', 3, MID2, 0), S_('DJB_G', '갑천역', 4, { lat: ST[115].lat, lng: ST[115].lng + 0.003 }, 0)])) }));
      const farAlight = d.t.busDir !== 'auto' && d.t.avail !== 'ok';
      const KS = ['궁동네거리', '가', '나', '다', '라', '갑천역'];
      const tr6 = () => ({ routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 2600, fare: 1650, steps: [W(180, P, BUS0), BUS(['104'], KS, 600, BUS0, ST[115]), W(120, ST[115], ST[115]), SUB(115, 1260), W(60, DJ, DJ)] }] });
      const six = (names) => names.map((n, k) => S_(k === 0 ? 'DJB_X' : k === 5 ? 'DJB_G' : 'DJB_N' + k, n, k + 1, k === 0 ? XS : k === 5 ? ST[115] : MID, 0, k === 0 ? '41111' : null));
      d = await d12({ api: { '/api/transit': tr6 }, route: info(R(six(KS))) });
      const sixOk = d.t.busDir === 'auto';
      d = keep(await d12({ api: { '/api/transit': tr6 }, route: info(R(six(['궁동네거리', '마', '바', '사', '아', '갑천역']))) }));
      ok('D12-09 순번(승차<하차)만으로 확정하지 않음: 사이 정류장 수가 다르거나(8 vs 3), 하차 정류장 좌표가 80m 밖이거나, 사이 정류장 이름이 순서대로 60% 미만 일치(2/6)면 미확인',
        tooMany && farAlight && sixOk && d.t.busDir !== 'auto' && d.t.avail !== 'ok', `이름 일치 6/6 → 확인 · 2/6 → ${d.t.busDir}`);
      // 실시간 노선 ID 불일치: 확인된 정류장에 다른 노선 ID 차량만 있음 · 건너편엔 R104 차량
      d = keep(await d12({ arr: { DJB_X: [{ routeNo: '104', routeId: 'ZZZ', arrSec: 300, prevCnt: 2 }], DJB_X2: [{ routeNo: '104', routeId: 'R104', arrSec: 120, prevCnt: 1 }] } }));
      ok('D12-10 실시간 노선 ID 불일치: 확인된 노선 ID가 아닌 차량·건너편 차량은 쓰지 않음 → 도착정보 없음(가정값) · 비교 기준 아님', !d.t.bus && d.t.avail === 'unknown' && d.baseline === null, d.t.why.join(' / '));
      // 대전시 보조 도착정보(노선 ID 체계 다름): 차량은 쓰되 방향은 미확인
      d = keep(await d12({ arr: {}, api: { '/api/arrivals-dj': (x, now) => ({ source: 'daejeon', at: now.t, list: x.includes('arsId=41111') ? [{ routeNo: '104', routeId: '30300043', arrSec: 540, prevCnt: 4 }] : [] }) } }));
      ok('D12-11 대전시 보조 도착정보 차량: 노선 ID를 대조할 수 없어 방향 미확인 · 추천 제외', d.t.bus && d.t.bus.arrSrc === 'daejeon' && d.t.busDir === 'unknown' && /노선 ID/.test(d.t.dirWhy || '') && d.t.avail === 'unknown', d.t.dirWhy);
      // 노선 정보 조회 실패·불완전: 수동 확인 목록이 있으면 그것만(manual), 없으면 미확인
      d = await d12({ fail: ['/api/busroute'], man: { 104: ['DJB_X'] } });
      const fbMan = d.t.busDir === 'manual' && d.t.avail === 'ok';
      d = keep(await d12({ fail: ['/api/busroute'] }));
      const fbNone = !['auto', 'manual'].includes(d.t.busDir) && d.t.avail !== 'ok';
      d = keep(await d12({ route: info(R(stops104(), { complete: false })) }));
      ok('D12-12 노선 정보 조회 실패·목록 불완전: 수동 확인 목록에 있으면 manual(대체), 없으면 미확인 · 불완전 목록으로 확정 안 함', fbMan && fbNone && d.t.busDir !== 'auto' && d.t.avail !== 'ok', `${d.t.busDir} · ${d.t.dirWhy}`);
      // 수동 확인(건너편 DJB_X2)과 공식 노선(DJB_X) 충돌
      d = keep(await d12({ man: { 104: ['DJB_X2'] } }));
      ok('D12-13a 수동 확인 목록과 공식 노선 정보가 다르면 충돌 → 확인 상태를 주지 않음(manual로도 승격 안 함)', d.t.busDir === 'conflict' && d.t.avail !== 'ok' && d.baseline === null, d.t.dirWhy);
      // 다른 노선의 수동 확인으로 승격하지 않음
      d = keep(await d12({ fail: ['/api/busroute'], man: { 601: ['DJB_X'], 106: ['DJB_X'] } }));
      ok('D12-13b 다른 노선(601·106)의 수동 확인으로 104번을 승격하지 않음', !['auto', 'manual'].includes(d.t.busDir) && d.t.avail !== 'ok');
      ok('D12-13 방향 미확인 경로는 어떤 추가 비용 설정에서도 비교 기준·추천이 되지 않음', unconfirmed.length >= 10 && unconfirmed.every((g) => !g.t.baseline && g.t.avail !== 'ok' && [0, 3000, 7000, null, 12345].every((a) => g.w.T.pickBest(g.list, a) !== g.t)), `${unconfirmed.length}개 상황`);

      // 노선 정보 호출량: 서로 다른 번호만 1회 · 30초 갱신 0회 · 새로고침 때 성공한 번호는 이 세션에서 재사용(공공 데이터), 실패한 번호만 다시
      d = await d12({ api: { '/api/transit': () => ({ routes: [...tr104().routes, { type: 'BUS', totalSec: 3000, fare: 1500, steps: [W(180, P, BUS0), BUS(['601', '104'], ['궁동네거리', '대전역'], 2100, BUS0, DJ), W(60, DJ, DJ)] }] }) },
        route: (x) => (x.includes('routeNo=601') ? { mock: false, routeNo: '601', routes: [] } : info(R(stops104()))()) });
      const rc0 = d.w.calls['/api/busroute'];
      await d.w.T.loadArrivals(); await d.w.T.loadArrivals();
      const rc1 = d.w.calls['/api/busroute'];
      await d.w.T.loadStops(true);
      ok('D12-14 노선 정보 호출: 서로 다른 번호(104·601) 1회씩 · 30초 갱신 0회 · 새로고침 때 재조회 없음', rc0 === 2 && rc1 === 2 && d.w.calls['/api/busroute'] === 2, `${rc0} → ${rc1} → ${d.w.calls['/api/busroute']}`);
      d = await d12({ fail: ['/api/busroute'] });
      const rf0 = d.w.calls['/api/busroute']; await d.w.T.loadStops(true);
      ok('D12-14b 노선 정보 조회 실패는 저장하지 않고 다음 로딩 때 다시 조회', rf0 === 1 && d.w.calls['/api/busroute'] === 2);
      // 비동기 보호: 노선 정보 응답이 늦는 사이 출발지를 바꾸면 이전 출발지 경로는 적용 안 함
      const D2 = { lat: 36.3700, lng: 127.3405 };
      const wA = world({ cfg: { route: true }, delayOf: (x) => (x.startsWith('/api/busroute') ? 80 : 2),
        api: api12({ '/api/transit': (x) => (x.includes(`olat=${P.lat.toFixed(4)}`) ? tr104() : { routes: [{ type: 'SUBWAY', totalSec: 2500, fare: 1650, steps: [W(900, D2, ST[116]), SUB(116, 1380), W(60, DJ, DJ)] }] }),
          '/api/stops': stopsBoth, '/api/arrivals': arrBy(ARR0), '/api/busroute': info(R(stops104())) }) });
      wA.T.SC.subway.zoneConfirmed = { '116-104': 2, '115-104': 2 };
      wA.T.st.presetPos.haksa = { ...P }; wA.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; wA.T.st.originKey = 'haksa';
      const l1 = wA.T.loadStops(); await sleep(20);
      wA.T.setPoint('origin', { key: 'westgate', name: '두 번째 출발지', lat: D2.lat, lng: D2.lng, verified: true }); await l1; await sleep(250);
      ok('D12-15 비동기 보호: 노선 정보가 늦게 와도 바뀐 출발지에 이전 출발지의 버스 경로·방향 판정을 적용하지 않음', wA.T.st.plans.length >= 1 && wA.T.st.plans.every((p) => !p.board && !p.dirs), wA.T.st.plans.map((p) => p.key).join(' | '));

      // 추가 비용 직접 입력
      d = await d12();
      const T = d.w.T, calls0 = JSON.stringify(Object.fromEntries(Object.entries(d.w.calls).filter(([k]) => k !== 'urls')));
      const r5 = T.setAllowCustom('5,000원');
      const okValid = r5.v === 5000 && T.st.allow === 5000 && T.st.allowCustom && !T.st.allowErr;
      const bad = ['-100', '1.5', '', '   ', 'abc', '1e3', '0x10', String(T.SC.allowanceMax + 1), '99999999999999999999'].map((v) => { const r = T.setAllowCustom(v); return !!r.err && T.st.allow === 5000 && T.st.allowCustom && T.st.allowErr === r.err && T.st.allowInput === v; });
      ok('D12-16 직접 입력 검증: \'5,000원\' → 5,000 · 음수·소수·빈값·문자·지수·16진수·상한(scenario allowanceMax) 초과는 거절하고 직전 적용값(5,000) 유지 · 오류 표시', okValid && bad.every(Boolean), bad.map((b) => (b ? 'o' : 'x')).join(''));
      T.setAllowCustom('0');
      const b0c = T.pickBest(d.list); T.setAllowFixed(0); const b0f = T.pickBest(d.list);
      ok('D12-17 직접 입력 0 = 고정 0원 버튼과 같은 추천 · 고정 버튼을 누르면 직접 입력 표시와 오류가 풀림', b0c === b0f && T.st.allow === 0 && !T.st.allowCustom && !T.st.allowErr);
      // 추천이 입력값에 따라 바뀜: 비교 기준보다 비싸고 더 빠른 경로 r → 추가 비용 (r 요금 - 기준 요금)이면 r 이상으로 빠른 경로, 1원 모자라면 r은 추천 안 됨
      const base = d.baseline, cand = d.list.filter((r) => r.avail === 'ok' && r.fare != null && r.fare > base.fare && r.arrive < base.arrive && !r.plus).sort((a, b) => a.arrive - b.arrive)[0];
      let chg = false;
      if (cand) {
        T.setAllowCustom(String(cand.fare - base.fare)); const bIn = T.pickBest(d.list);
        T.setAllowCustom(String(cand.fare - base.fare - 1)); const bOut = T.pickBest(d.list);
        chg = bIn.arrive <= cand.arrive && bIn.fare <= cand.fare && bOut !== cand && bOut.fare <= cand.fare - 1;
      }
      const calls1 = JSON.stringify(Object.fromEntries(Object.entries(d.w.calls).filter(([k]) => k !== 'urls')));
      ok('D12-18 직접 입력값에 따라 추천이 바뀜(필요 금액이면 포함, 1원 모자라면 제외) · 추가 비용을 바꿔도 외부 API 호출 0회', !!cand && chg && calls0 === calls1, cand ? `${cand.name} ${cand.fare}원 (기준 ${base.fare}원)` : '후보 없음');

      // 화면 'null' 노출: 실제 브라우저처럼 append(null)이 'null' 글자가 되는 가짜 DOM으로 그려 봄
      const mkDom = () => { const byId = {}; const asNode = (c) => (c && typeof c === 'object' ? c : String(c));
        const mk = (tag) => ({ nodeType: 1, tag, attrs: {}, children: [], className: '', textContent: '', hidden: false, value: '', classList: { toggle() {} },
          setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener() {}, append(...c) { this.children.push(...c.map(asNode)); }, replaceChildren(...c) { this.children = c.map(asNode); }, remove() {} });
        return { byId, document: { createElement: mk, createTextNode: (t) => String(t), visibilityState: 'visible', head: mk('head'), querySelector: (sel) => byId[sel] || (byId[sel] = mk(sel)) } }; };
      const txtAll = (n) => (typeof n === 'string' ? n : `${n.textContent || ''} ${Object.values(n.attrs || {}).join(' ')} ${(n.children || []).map(txtAll).join('')}`);
      const BAD = /\bnull\b|undefined|NaN/;
      const shots = [];
      let dm = mkDom(); d = await d12({ doc: dm.document }); d.w.T.render(); shots.push(Object.values(dm.byId).map(txtAll).join(' '));
      d.w.T.setAllowCustom('abc'); shots.push(Object.values(dm.byId).map(txtAll).join(' '));                       // 오류 안내가 보이는 상태
      dm = mkDom(); d = await d12({ doc: dm.document, fail: ['/api/busroute', '/api/drive', '/api/tashu'] }); d.w.T.render(); shots.push(Object.values(dm.byId).map(txtAll).join(' '));   // 비교 기준 없음·조회 실패
      const errShown = /0 이상의 정수/.test(shots[1]) && /지금 적용 중/.test(shots[1]) && !/지금 적용 중/.test(shots[0]);
      ok('D12-19 화면에 null·undefined·NaN 글자 없음 (정상·입력 오류·비교 기준 없음·조회 실패) · 빈 오류 영역은 그리지 않음', shots.every((s) => !BAD.test(s)) && errShown,
        shots.map((s) => (s.match(BAD) || ['깨끗'])[0]).join(' / '));

      // 갑천역 → 대전역 요금 구간: scenario.js 실제 값(2구간, 카카오 지하철 10.1㎞·1,650원 근거)
      const real = loadApp({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), now: { t: KST(14, 0) } });
      // 카카오 경로에 갑천역 지하철 요금이 없게(버스만) 해서 scenario.js 구간 값만으로 판단되는지 봄
      d = await d12({ api: { '/api/transit': () => ({ routes: [{ type: 'BUS', totalSec: 3000, fare: 1500, steps: [W(180, P, BUS0), BUS(['601'], ['궁동네거리', '대전역'], 2100, BUS0, DJ), W(60, DJ, DJ)] }] }) } });
      d.w.T.SC.subway.zoneConfirmed = { ...real.SC.subway.zoneConfirmed };
      const rz = d.w.T.computeRoutes(), m115 = rz.mix.tashu.find((r) => r.hub.stNum === '115');
      d.w.T.SC.subway.zoneConfirmed = { ...real.SC.subway.zoneConfirmed }; delete d.w.T.SC.subway.zoneConfirmed['115-104'];
      const rz2 = d.w.T.computeRoutes(), m115b = rz2.mix.tashu.find((r) => r.hub.stNum === '115');
      ok('D12-20 갑천역→대전역 = 2구간(scenario.js) → 갑천역 연계 경로 지하철 요금 1,650원 · 구간 값이 없으면 요금 미확인', real.SC.subway.zoneConfirmed['115-104'] === 2 && m115 && m115.fare === 1650 && m115b && m115b.fare == null,
        m115 ? `${m115.fare} / 값 없으면 ${m115b && m115b.fare}` : '갑천역 후보 없음');

      /* ===== update12 독립 감사 결함 회귀 (A13) ===== */
      // [감사 2] 공식 노선 정보가 방향을 거부(하차→승차 역순)했는데 수동 확인 목록으로 승격되던 문제
      const revStops = () => [S_('DJB_G', '갑천역', 1, ST[115], 0), S_('DJB_M', '유성구청', 2, MID, 0), S_('DJB_X', '궁동네거리', 3, XS, 0, '41111')];
      d = await d12({ route: info(R(revStops())), man: { 104: ['DJB_X'] } });
      ok('A13-01 공식 경유 목록이 하차→승차 역순(불일치)이면 verifiedStops에 승차 정류장이 있어도 manual·이용 가능으로 승격 안 함 → 비교 기준·추천 제외(모든 추가 비용)',
        !['auto', 'manual'].includes(d.t.busDir) && d.t.avail !== 'ok' && d.baseline === null && [0, 3000, 7000, null, 12345].every((a) => d.w.T.pickBest(d.list, a) !== d.t) && /수동 확인 목록 미적용/.test(d.t.dirWhy || ''),
        `${d.t.busDir} · ${d.t.avail} · ${d.t.dirWhy}`);
      d = await d12({ route: info(R([S_('DJB_X', '궁동네거리', 1, XS, null), S_('DJB_M', '유성구청', 2, MID, null), S_('DJB_G', '갑천역', 3, ST[115], null), S_('DJB_Z', '순환', 4, { lat: 36.35, lng: 127.38 }, null), S_('DJB_X', '궁동네거리', 5, XS, null)])), man: { 104: ['DJB_X'] } });
      const loopRej = !['auto', 'manual'].includes(d.t.busDir) && d.t.avail !== 'ok' && d.baseline === null;
      d = await d12({ route: info(R(stops104()), R([S_('DJB_X3', '궁동네거리', 1, { lat: BUS0.lat - 0.0003, lng: BUS0.lng }, 0), S_('DJB_M', '유성구청', 2, MID, 0), S_('DJB_G', '갑천역', 3, ST[115], 0)], { id: 'R104C' })),
        api: { '/api/stops': () => ({ stops: [...stopsBoth().stops, { id: 'DJB_X3', no: '41113', name: '궁동네거리', lat: BUS0.lat - 0.0003, lng: BUS0.lng }] }) }, man: { 104: ['DJB_X'] } });
      const ambRej = !['auto', 'manual'].includes(d.t.busDir) && d.t.avail !== 'ok';
      ok('A13-02 순환·회차(모호)·승차 후보 둘 이상(모호)도 공식 정보가 거부한 것 → 수동 확인 목록으로 승격 안 함', loopRej && ambRej);
      // 정당한 수동 대체: 공식 정보를 확보하지 못한 경우만 (조회 실패 · 공식 노선 없음 · 불완전 목록)
      d = await d12({ route: () => ({ mock: false, routeNo: '104', routes: [] }), man: { 104: ['DJB_X'] } });
      const fbNone2 = d.t.busDir === 'manual' && d.t.avail === 'ok';
      d = await d12({ route: info(R(stops104(), { complete: false })), man: { 104: ['DJB_X'] } });
      const fbInc = d.t.busDir === 'manual' && d.t.avail === 'ok';
      d = await d12({ fail: ['/api/busroute'], man: { 104: ['DJB_X'] } });
      const fbFail = d.t.busDir === 'manual' && d.t.avail === 'ok';
      ok('A13-03 수동 확인 대체는 공식 정보 미확보(조회 실패·공식 노선 없음·불완전 목록)일 때만 그대로 허용', fbNone2 && fbInc && fbFail, [fbFail, fbNone2, fbInc].map((x) => (x ? 'o' : 'x')).join(''));
      // 신뢰도 전파: 한 경로에 공식 정보가 거부한 104번(수동 목록에는 있음)과 수동 대체가 정당한 999번(노선 정보 조회 실패)이 함께 있으면
      //   104번은 '확인된 노선'으로 세지 않음 → 104번 차량이 먼저 와도 타지 않고 999번(수동 확인)으로 계산
      d = await d12({ api: { '/api/transit': tr2 }, route: (x) => { if (x.includes('routeNo=999')) throw new Error('조회 실패'); return info(R(revStops()))(); }, man: { 104: ['DJB_X'], 999: ['DJB_X'] },
        arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 300, prevCnt: 2 }, { routeNo: '999', routeId: 'R999', arrSec: 540, prevCnt: 4 }] } });
      ok('A13-03b 공식 정보가 거부한 노선(104)은 수동 목록에 있어도 \'확인 노선\'으로 세지 않음 → 먼저 온 104번 차량 대신 수동 확인된 999번으로 계산 · 안내에 104번 제외 표시', d.t.bus && d.t.bus.routeNo === '999' && d.t.busDir === 'manual' && d.t.avail === 'ok' && d.t.steps.find((x) => x.type === 'wait').note.includes('104번) 제외'),
        d.t.bus ? `${d.t.bus.routeNo} · ${d.t.busDir} · ${d.t.steps.find((x) => x.type === 'wait').note}` : '버스 없음');
      // [감사 3] 순번이 비정상인 목록: 서버가 complete로 잘못 보내도 화면에서 방향 확정에 쓰지 않음
      d = await d12({ route: info(R(stops104().map((x) => ({ ...x, ord: 1 })))) });
      const ord1 = d.t.busDir !== 'auto' && d.t.avail !== 'ok';
      d = await d12({ route: () => ({ mock: false, routeNo: '104', complete: false, why: '노선 ID 7개 중 6개만 조회', routes: [R(stops104())] }) });
      const topInc = d.t.busDir !== 'auto' && d.t.avail !== 'ok' && /불완전/.test(d.t.dirWhy || '');
      ok('A13-04 승차·중간·하차 순번이 모두 1인 목록, 서버가 불완전(complete=false)이라 표시한 결과로는 자동 방향 확인 안 함', ord1 && topInc, `${ord1} · ${topInc}`);
      // [감사 4] 브라우저: 불완전한 노선 정보는 저장해 두고 재사용하지 않음 (다음 로딩 때 다시 조회) · 완전한 정보는 재사용(D12-14)
      let rmB = 'perRoute';
      d = await d12({ route: () => (rmB === 'perRoute' ? { mock: false, routeNo: '104', routes: [R(stops104(), { complete: false })] } : rmB === 'top' ? { mock: false, routeNo: '104', complete: false, why: '노선 ID 일부만 조회', routes: [R(stops104())] } : { mock: false, routeNo: '104', complete: true, routes: [R(stops104())] }) });
      const icN = [d.w.calls['/api/busroute']];
      rmB = 'top'; await d.w.T.loadStops(true); icN.push(d.w.calls['/api/busroute']);
      rmB = 'ok'; await d.w.T.loadStops(true); icN.push(d.w.calls['/api/busroute']);
      await d.w.T.loadStops(true); icN.push(d.w.calls['/api/busroute']);
      ok('A13-05 브라우저: 불완전한 노선 정보(노선별 complete=false·전체 complete=false)는 재사용하지 않고 다음 로딩 때 다시 조회 · 완전한 정보는 이 세션에서 재사용', icN.join() === '1,2,3,3', icN.join(' → '));

      // [감사 5] 예산을 적용한 뒤 복합경로 유형별 대표 선정
      //   비교 기준: 601번(약 69분 · 1,500원 — 일반버스 공식 요금, update12 최종에서 1,550 → 1,500으로 고정 응답 정정) · 택시 연계 후보 1: 월평역(114) 택시 9,000 + 지하철 1구간 1,550 = 10,550원(빠름) · 후보 2: 갑천역(115) 택시 4,800 + 2구간 1,650 = 6,450원(느림)
      const trB = () => ({ routes: [{ type: 'BUS', totalSec: 4200, fare: 1500, steps: [W(180, P, BUS0), BUS(['601'], ['궁동네거리', '대전역'], 3700, BUS0, DJ), W(60, DJ, DJ)] }] });
      const drvB = (x) => (q(x, 'dlat') < 36.34 ? { durationSec: 3600, distanceM: 15000, taxiFare: 20000 } : q(x, 'dlng') < 127.367 ? { durationSec: 600, distanceM: 4000, taxiFare: 9000 } : { durationSec: 1200, distanceM: 5000, taxiFare: 4800 });
      d = await d12({ api: { '/api/transit': trB, '/api/drive': drvB, '/api/tashu': (x) => ({ mock: false, stations: [{ id: 'T0', name: '대여소', d: 90, bikes: 0, lat: q(x, 'lat'), lng: q(x, 'lng') }] }),
        '/api/stations': () => ({ stations: [{ name: '월평역 대전1호선', lat: ST[114].lat, lng: ST[114].lng }, { name: '갑천역 대전1호선', lat: ST[115].lat, lng: ST[115].lng }] }) },
        route: () => ({ mock: false, routeNo: '601', routes: [] }), man: { 601: ['DJB_X'] }, arr: { DJB_X: [{ routeNo: '601', routeId: 'R601', arrSec: 420, prevCnt: 3 }] } });
      const TB = d.w.T, callsB0 = JSON.stringify(Object.fromEntries(Object.entries(d.w.calls).filter(([k]) => k !== 'urls')));
      const at = (a) => { const r = TB.computeRoutes(a); return { r, x: r.list.find((y) => y.kind === 'taxiMix'), best: TB.pickBest(r.list, a) }; };
      const b7 = at(7000), bN = at(null), b0 = at(0);
      TB.setAllowCustom('7,000'); const bUi = at(TB.st.allow); TB.setAllowFixed(null); const bUiN = at(TB.st.allow);
      const callsB1 = JSON.stringify(Object.fromEntries(Object.entries(d.w.calls).filter(([k]) => k !== 'urls')));
      const fares = d.mix.taxi.filter((r) => r.avail === 'ok').map((r) => `${r.hub.stNum}:${r.fare}:${Math.round(r.total)}분`).join(' ');
      ok('A13-06 예산 적용 후 대표 선정: 기준 1,500원 + 7,000원 → 택시 연계 6,450원 후보(더 느림)가 대표·추천 · 상관없음 → 10,550원(더 빠름) 대표·추천 · 외부 API 재호출 0회',
        d.baseline && d.baseline.fare === 1500 && b7.x.hub.stNum === '115' && b7.x.fare === 6450 && b7.best === b7.x && b7.r.list.includes(b7.best)
        && bN.x.hub.stNum === '114' && bN.x.fare === 10550 && bN.best === bN.x && bN.x.arrive < b7.x.arrive
        && bUi.x.hub.stNum === '115' && bUi.best === bUi.x && bUiN.x.hub.stNum === '114' && bUiN.best === bUiN.x && callsB0 === callsB1,
        `기준 ${d.baseline && Math.round(d.baseline.total)}분 · 후보 ${fares} · 7,000 → ${b7.x.hub.stNum} / 상관없음 → ${bN.x.hub.stNum}`);
      ok('A13-07 예산 안 후보가 없으면(추가 0원) 가장 빠른 후보를 대표로 표시하되 \'추가 비용 범위 초과\' 표시 · 추천 제외 · 유형별 대표 1개 유지',
        b0.x.hub.stNum === '114' && b0.x.overBudget === true && b0.best !== b0.x && b0.best === b0.r.baseline && !b7.x.overBudget && b0.r.list.filter((r) => r.kind === 'taxiMix').length === 1 && b7.r.list.filter((r) => r.kind === 'taxiMix').length === 1);
      { const dmB = mkDom(); const gB = await d12({ doc: dmB.document, api: { '/api/transit': trB, '/api/drive': drvB, '/api/tashu': (x) => ({ mock: false, stations: [{ id: 'T0', name: '대여소', d: 90, bikes: 0, lat: q(x, 'lat'), lng: q(x, 'lng') }] }),
        '/api/stations': () => ({ stations: [{ name: '월평역 대전1호선', lat: ST[114].lat, lng: ST[114].lng }, { name: '갑천역 대전1호선', lat: ST[115].lat, lng: ST[115].lng }] }) },
        route: () => ({ mock: false, routeNo: '601', routes: [] }), man: { 601: ['DJB_X'] }, arr: { DJB_X: [{ routeNo: '601', routeId: 'R601', arrSec: 420, prevCnt: 3 }] } });
        gB.w.T.setAllowCustom('7000');
        const cardsB = all(dmB.byId['#content'], (n) => n.tag === 'article'), bestCard = cardsB.find((c) => /추천/.test(txt(all(c, (n) => n.className === 'rh')[0])));
        gB.w.T.setAllowFixed(0);
        const cards0 = all(dmB.byId['#content'], (n) => n.tag === 'article'), over = cards0.find((c) => c.attrs['data-kind'] === 'taxiMix');
        ok('A13-08 화면: 직접 입력 7,000원 → 추천 카드 = 택시 연계(갑천역 · 6,450원) · 0원이면 택시 연계 카드에 \'추가 비용 범위(0원) 초과\' 표시', !!bestCard && bestCard.attrs['data-kind'] === 'taxiMix' && /갑천역/.test(txt(bestCard)) && /6,450원/.test(txt(bestCard)) && !!over && /추가 비용 범위\(0원\) 초과/.test(txt(over)),
          bestCard ? txt(all(bestCard, (n) => n.className === 'rh')[0]) : '추천 없음'); }

      // [감사 6] 뒤 버스(환승 버스)도 요금 기준과 같은 노선 목록 · 노선 후보가 겹치면 환승 요금 미확인
      const MIDB = { lat: 36.3500, lng: 127.3900 };
      const trS = (v1, v2) => () => ({ routes: [{ type: 'BUS', totalSec: 3600, fare: null, fareMin: 1500, fareMax: 1850, steps: [W(180, P, BUS0), { ...BUS([], ['궁동네거리', '중간정류장'], 900, BUS0, MIDB), vehicles: v1 }, W(60, MIDB, MIDB), { ...BUS([], ['중간정류장', '대전역'], 1200, MIDB, DJ), vehicles: v2 }, W(60, DJ, DJ)] }] });
      d = await d12({ api: { '/api/transit': trS([{ name: '601', type: '일반' }], [{ name: '701', type: '일반' }, { name: '9000', type: '좌석' }]) }, route: () => ({ mock: false, routeNo: '601', routes: [] }), man: { 601: ['DJB_X'] },
        arr: { DJB_X: [{ routeNo: '601', routeId: 'R601', arrSec: 420, prevCnt: 3 }] } });
      const txS = d.t.steps.map((x) => `${x.label} ${x.note || ''}`).join(' | ') + ' | ' + d.t.sub;
      ok('A13-09 일반·마을버스 기준 요금(1,500원)이면 뒤 버스의 환승 대기·승차 안내·경로 요약에도 제외된 좌석버스(9000번)가 나오지 않음', d.t.fare === 1500 && !/9000/.test(txS) && /701번 버스 환승 대기/.test(txS) && /601번 → 701번/.test(d.t.sub), txS);
      d = await d12({ api: { '/api/transit': trS([{ name: '601', type: '일반' }, { name: '602', type: '일반' }], [{ name: '602', type: '일반' }, { name: '701', type: '일반' }]) }, route: () => ({ mock: false, routeNo: '601', routes: [] }), man: { 601: ['DJB_X'], 602: ['DJB_X'] },
        arr: { DJB_X: [{ routeNo: '601', routeId: 'R601', arrSec: 420, prevCnt: 3 }] } });
      ok('A13-10 버스 구간들의 노선 후보가 겹치면(602번 재탑승 가능) 실제 탑승 조합을 확정할 수 없어 환승 할인 요금을 정하지 않음 → 요금 미확인 · 비교 기준 제외', d.t.fare == null && d.t.why.some((x) => /요금 미확인/.test(x)) && d.baseline === null, `요금 ${d.t.fare}`);

      // [감사 7] 같은 역 구간 시각표 요청 경쟁: 최신 요청 결과만 저장·삭제
      for (const mode of ['fail', 'old']) {
        let armed = false, k115 = 0, a115 = 0;
        const subR = (x) => { if (armed && q(x, 'from') === 115) { a115++; if (a115 === 2) { if (mode === 'fail') throw new Error('늦은 실패'); const t = subwayA(x); for (const dd of Object.values(t.days)) for (const k of Object.keys(dd)) dd[k] = { ...dd[k], ride: 99 }; return t; } } return subwayA(x); };
        const gT = await d12({ api: { '/api/subway': subR }, delayOf: (x) => (armed && x.startsWith('/api/subway') && x.includes('from=115') ? (++k115 === 1 ? 60 : 1) : 0) });
        armed = true;
        const p1 = gT.w.T.loadTimetables(true); await sleep(5); const p2 = gT.w.T.loadTimetables(true);
        await Promise.all([p1, p2]); await sleep(10);
        const tt = gT.w.T.st.tt['115-104'];
        if (mode === 'fail') ok('A13-11 시각표: 최신 요청이 먼저 정상 완료되고 이전 요청이 늦게 실패해도 최신 시각표를 지우지 않음', !!tt && tt.days[0][0].ride === 21 && a115 === 2, tt ? `ride ${tt.days[0][0].ride}` : '시각표 삭제됨');
        else ok('A13-12 시각표: 이전 요청의 정상 응답이 늦게 도착해도 최신 시각표를 덮어쓰지 않음', !!tt && tt.days[0][0].ride === 21 && a115 === 2, tt ? `ride ${tt.days[0][0].ride}` : '없음');
      }

      // [감사 8] 정거장 수(prevCnt)가 null·누락·NaN이면 'null정거장 전'을 보이지 않음
      const shots8 = [];
      for (const pc of [null, undefined, 'abc']) {
        const dm8 = mkDom(); const g8 = await d12({ doc: dm8.document, arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 540, ...(pc === undefined ? {} : { prevCnt: pc }) }] } });
        g8.w.T.render(); g8.w.T.st.tab = 'stops'; g8.w.T.render();
        shots8.push({ note: g8.t.steps.find((x) => x.type === 'wait').note, scr: Object.values(dm8.byId).map(txtAll).join(' ') });
      }
      d = await d12({ arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 0 }] } });
      const zeroOk = /0정거장 전/.test(d.t.steps.find((x) => x.type === 'wait').note);
      const wL = world({ api: { '/api/arrivals': (x, now) => ({ list: [{ routeNo: '108', routeId: 'DJBR108', arrSec: 600, prevCnt: null }], at: now.t }) } }); wL.T.st.subway = timetable(23); await wL.T.loadStops();
      const legNote = L(wL.T.computeRoutes().list).A.steps.find((x) => x.type === 'wait').note;
      ok('A13-13 정거장 수 null·누락·문자 → 경로 안내·실시간 탭에 \'null정거장 전\'·NaN 없이 생략 · 0은 \'0정거장 전\'으로 정상 표시 · 기존 고정 경로(108번)도 같음',
        shots8.every((x) => !/정거장 전/.test(x.note) && !BAD.test(x.note) && !BAD.test(x.scr)) && zeroOk && !BAD.test(legNote) && !/정거장 전/.test(legNote), shots8.map((x) => x.note).join(' / ') + ' / ' + legNote);

      // [update12 최종] 서버가 routeid 불량으로 불완전(complete=false, 노선 0개)이라 보낸 결과: '공식 노선 없음'이 아니라 불완전 → 자동 확인 안 함 · 수동 대체만 · 다음 로딩 때 재조회
      d = await d12({ route: () => ({ mock: false, routeNo: '104', complete: false, why: '노선 ID가 없거나 잘못된 행 1개', routes: [] }), man: { 104: ['DJB_X'] } });
      const b14m = d.t.busDir === 'manual' && d.t.avail === 'ok';
      d = await d12({ route: () => ({ mock: false, routeNo: '104', complete: false, why: '노선 ID가 없거나 잘못된 행 1개', routes: [R(stops104())] }) });
      const b14a = d.t.busDir !== 'auto' && d.t.avail !== 'ok' && /불완전/.test(d.t.dirWhy || '');
      const c14 = d.w.calls['/api/busroute']; await d.w.T.loadStops(true); await d.w.T.loadStops(true);
      ok('A14-01 브라우저: routeid 불량으로 불완전한 노선 정보(노선 0개여도)는 \'공식 노선 없음\'으로 보지 않고 불완전 → 정상 노선이 섞여 있어도 자동 확인 안 함 · 수동 대체만 허용 · 재사용 없이 로딩마다 재조회',
        b14m && b14a && c14 === 1 && d.w.calls['/api/busroute'] === 3, `${b14m} · ${b14a} · ${c14}→${d.w.calls['/api/busroute']}`);

      // [update12 최종] 노선 ID 문자열 'null'·'undefined': 서버 검사를 거치지 않은 값이 와도 화면 경계에서 자동 확인 금지
      const ridCase = async (rid, arrRid) => d12({ route: info(R(stops104(), { id: rid })), arr: { DJB_X: [{ routeNo: '104', routeId: arrRid, arrSec: 540, prevCnt: 4 }] } });
      const r15 = [];
      for (const v of ['null', 'undefined', 'NULL', ' Undefined ']) { const g = await ridCase(v, v); r15.push(g.t.busDir !== 'auto' && g.t.avail !== 'ok' && g.baseline === null); }
      ok('A15-01 공식 노선 ID와 도착 차량 노선 ID가 둘 다 \'null\'·\'undefined\'(대소문자·공백 변형)로 같아도 자동 방향 확인 안 함 · 비교 기준 제외', r15.every(Boolean), r15.join(','));
      d = await d12({ arr: { DJB_X: [{ routeNo: '104', routeId: 'null', arrSec: 300, prevCnt: 2 }, { routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 4 }] } });
      const skipNull = d.t.busDir === 'auto' && d.t.bus.routeId === 'R104' && Math.abs(d.t.steps.find((x) => x.type === 'wait').min - 6) < 0.01;
      d = await d12();
      ok('A15-02 정상 노선 ID(R104) 일치 차량은 기존대로 자동 확인·비교 기준 · 같은 정류장의 노선 ID \'null\' 차량은 먼저 와도 타지 않음', skipNull && d.t.busDir === 'auto' && d.t.avail === 'ok' && d.baseline === d.t);
      d = await d12({ route: info(R(stops104(), { id: 'null' })), man: { 104: ['DJB_X'] } });
      ok('A15-02b 노선 ID가 \'null\'인 공식 노선 정보는 \'자동 확인\'이 아니라 불완전(공식 정보 미확보)으로 취급 → 정상 노선 ID 차량(R104)·수동 확인 목록으로 정당한 수동 대체', d.t.busDir === 'manual' && d.t.avail === 'ok' && d.t.bus.routeId === 'R104', `${d.t.busDir} · ${d.t.dirWhy || ''}`);
      d = await d12({ route: info(R(stops104(), { id: 'undefined' })) });
      const c15 = d.w.calls['/api/busroute']; await d.w.T.loadStops(true); await d.w.T.loadStops(true);
      ok('A15-03 브라우저: 노선 ID가 \'undefined\'인 노선 정보는 complete로 와도 저장·재사용하지 않고 로딩마다 재조회 (정상 정보 재사용은 D12-14)', c15 === 1 && d.w.calls['/api/busroute'] === 3, `${c15}→${d.w.calls['/api/busroute']}`);

      /* ===== update12 최종: 실시간 차량 노선 ID 유효성 — 자동·수동 확인 공통 (A16) ===== */
      // 같은 승차 정류장(DJB_X): 불량 ID 차량 5분 · 정상 ID 차량(R104) 9분. 걸어서 3분이라 둘 다 탈 수 있음
      const BADV = [['문자열 null', { routeId: 'null' }], ['문자열 undefined', { routeId: 'undefined' }], ['빈 문자열(서버 정규화)', { routeId: '' }], ['누락', {}], ['NULL', { routeId: 'NULL' }], ['공백 변형', { routeId: ' Undefined ' }], ['공백', { routeId: '  ' }], ['객체', { routeId: { id: 'R104' } }]];
      const arrBad = (bad, good = true) => ({ DJB_X: [{ routeNo: '104', arrSec: 300, prevCnt: 2, ...bad }, ...(good ? [{ routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 4 }] : [])] });
      const MAN = { fail: ['/api/busroute'], man: { 104: ['DJB_X'] } };
      const sel = (g) => g.t.bus && g.t.bus.routeId === 'R104' && Math.abs(g.t.steps.find((x) => x.type === 'wait').min - 6) < 0.01 && g.t.bus.prevCnt === 4;
      const r16a = [], r16m = [], r16o = [];
      for (const [label, bad] of BADV) {
        const ga = await d12({ arr: arrBad(bad) }); r16a.push([label, sel(ga) && ga.t.busDir === 'auto' && ga.t.avail === 'ok']);
        const gm = await d12({ ...MAN, arr: arrBad(bad) }); r16m.push([label, sel(gm) && gm.t.busDir === 'manual' && gm.t.avail === 'ok' && gm.baseline === gm.t]);
        const go = await d12({ ...MAN, arr: arrBad(bad, false) }); r16o.push([label, !go.t.bus && go.t.avail !== 'ok' && go.baseline === null && [0, 3000, 7000, null].every((a) => go.w.T.pickBest(go.list, a) !== go.t)]);
      }
      const fl = (r) => r.filter((x) => !x[1]).map((x) => x[0]).join(', ') || '8가지 모두';
      ok('A16-01 자동 확인: 불량 ID 차량(5분, null·undefined·빈 값·누락·대소문자·공백 변형·객체)은 빼고 정상 ID 차량(9분)으로 대기 계산', r16a.every((x) => x[1]), fl(r16a));
      ok('A16-02 수동 확인(노선 정보 조회 실패 → verifiedStops): 같은 조건에서 불량 ID 차량을 빼고 정상 차량 선택 · 정상 차량의 대기·남은 정거장으로 계산', r16m.every((x) => x[1]), fl(r16m));
      ok('A16-03 수동 확인: 불량 ID 차량만 있으면 탈 차가 없음 → 이용 가능으로 확정 안 함 · 비교 기준·추천(0·3,000·7,000·상관없음) 제외 · 서버가 빈 문자열로 바꾼 경우 포함', r16o.every((x) => x[1]), fl(r16o));
      d = await d12({ ...MAN, arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 540, prevCnt: 4 }] } });
      ok('A16-04 정상 ID 차량의 수동 확인은 기존대로 manual·이용 가능·비교 기준', d.t.busDir === 'manual' && d.t.avail === 'ok' && d.baseline === d.t && d.t.bus.routeId === 'R104');
      // 다음 차 가정: 목록의 차를 모두 놓침(걸어서 3분) — 정상 R104 1분 · 불량 'null' 2분(마지막 차) → 가정 기준은 정상 차량, 불량 ID 재선택 금지
      const g7 = await d12({ ...MAN, arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 60, prevCnt: 1 }, { routeNo: '104', routeId: 'null', arrSec: 120, prevCnt: 1 }] } });
      const g7b = await d12({ ...MAN, arr: { DJB_X: [{ routeNo: '104', routeId: 'null', arrSec: 60, prevCnt: 1 }] } });
      const g7c = await d12({ arr: { DJB_X: [{ routeNo: '104', routeId: 'R104', arrSec: 60, prevCnt: 1 }, { routeNo: '104', routeId: '', arrSec: 120, prevCnt: 1 }] } });
      ok('A16-05 다음 차 가정: 불량 ID 차량을 뺀 목록의 마지막 정상 차량 기준(노선 ID R104 · 출발 1분+간격) · 불량 차량만 놓쳤으면 가정 차량도 만들지 않음 · 자동 확인 경로도 같음 · 가정값이라 추천 제외',
        g7.t.bus && !g7.t.bus.catchable && g7.t.bus.routeId === 'R104' && Math.abs(g7.t.bus.total - (1 + g7.w.T.SC.bus.headwayMin)) < 0.01 && g7.t.avail !== 'ok'
        && !g7b.t.bus && g7b.t.avail !== 'ok' && g7c.t.bus && g7c.t.bus.routeId === 'R104' && !g7c.t.bus.catchable, `${g7.t.bus && g7.t.bus.routeId} · ${g7b.t.bus ? '불량 가정' : '가정 없음'} · ${g7c.t.bus && g7c.t.bus.routeId}`);
      // 기존 고정 경로(카카오 길찾기 못 씀 · 108번): 불량 ID 차량만 → 버스 없음(가정값), 정상 차량은 그대로
      const wB = world({ api: { '/api/arrivals': (x, now) => ({ list: [{ routeNo: '108', routeId: 'null', arrSec: 600, prevCnt: 4 }], at: now.t }) } }); wB.T.st.subway = timetable(23); await wB.T.loadStops();
      const lB = L(wB.T.computeRoutes().list).A;
      const wG = world({ api: { '/api/arrivals': (x, now) => ({ list: [{ routeNo: '108', routeId: 'undefined', arrSec: 300, prevCnt: 2 }, { routeNo: '108', routeId: 'DJB30300043', arrSec: 600, prevCnt: 4 }], at: now.t }) } }); wG.T.st.subway = timetable(23); await wG.T.loadStops();
      const lG = L(wG.T.computeRoutes().list).A;
      ok('A16-06 기존 고정 경로(108번)도 같은 기준: 불량 ID 차량만 → 탈 차 없음(가정값·비교 기준 아님) · 불량 차량을 빼고 정상 차량(10분)으로 계산', !lB.bus && lB.avail !== 'ok' && !lB.baseline && lG.bus && lG.bus.routeId === 'DJB30300043' && Math.abs(lG.bus.total - 10) < 0.01, `${lB.bus ? '불량 선택' : '없음'} · ${lG.bus && lG.bus.routeId}`);

      /* ===== update12 최종: 공식 요금 우선 계산 · 비교 기준 동률 · 시각표 상태 (A17) ===== */
      const V = (name, type) => ({ name, type });
      const busV = (vs, stops = ['궁동네거리', '유성구청', '갑천역'], sec = 600, b = ST[115]) => ({ ...BUS([], stops, sec, BUS0, b), vehicles: vs });
      const subRoute = (vs, fare = {}) => () => ({ routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 2600, fare: null, ...fare, steps: [W(180, P, BUS0), busV(vs), W(120, ST[115], ST[115]), SUB(115, 1260), W(60, DJ, DJ)] }] });
      const busRoute1 = (vs, fare = {}, stops = ['궁동네거리', '대전역']) => () => ({ routes: [{ type: 'BUS', totalSec: 3000, fare: null, ...fare, steps: [W(180, P, BUS0), busV(vs, stops, 2100, DJ), W(60, DJ, DJ)] }] });
      const MANALL = { fail: ['/api/busroute'], man: { 104: ['DJB_X'], 106: ['DJB_X'], 5: ['DJB_X'], 105: ['DJB_X'], 601: ['DJB_X'], 701: ['DJB_X'] } };
      const arrOf = (...list) => ({ DJB_X: list.map(([n, sec]) => ({ routeNo: n, routeId: 'R' + n, arrSec: sec, prevCnt: 3 })) });
      // 1) 실제 응답 재현: 버스 후보 일반(104)·마을(5)·좌석(48) + 지하철 갑천→대전역(2구간 확인값), 카카오 요금 없음 / 카카오 최저 1,650·최고 2,900
      const g1 = await d12({ ...MANALL, api: { '/api/transit': subRoute([V('104', '일반'), V('5', '마을'), V('48', '좌석')]) }, arr: arrOf(['104', 540]) });
      const g1b = await d12({ ...MANALL, api: { '/api/transit': subRoute([V('104', '일반'), V('5', '마을'), V('48', '좌석')], { fareMin: 1650, fareMax: 2900 }) }, arr: arrOf(['104', 540]) });
      ok('A17-01 카카오 요금이 없어도 공식 규칙으로 계산: 일반 1,500·마을 1,350 + 지하철 2구간 → 어느 버스를 타도 1,650원 · 좌석(48)은 요금표 미확인이라 탈 노선에서 제외 · 카카오 최저값(1,650)과도 일치',
        g1.t.fare === 1650 && g1.t.plan.board.routeNos.join() === '104,5' && /공식 요금/.test(g1.t.fareNote) && g1b.t.fare === 1650 && /카카오 요금과 일치/.test(g1b.t.fareNote) && g1.t.avail === 'ok', `${g1.t.fare} · ${g1.t.fareNote} / ${g1b.t.fare} · ${g1b.t.fareNote}`);
      const g2 = await d12({ ...MANALL, api: { '/api/transit': busRoute1([V('104', '일반'), V('106', '일반')]) }, arr: arrOf(['106', 420]) });
      ok('A17-02 버스 후보가 모두 같은 요금(일반 104·106) · 카카오 요금 없음 → 1,500원 확정', g2.t.fare === 1500 && g2.t.avail === 'ok', `${g2.t.fare}`);
      // 3) 후보마다 요금이 다름(일반 1,500 · 마을 1,350, 지하철 없음): 실제로 탈 버스가 정해지면 그 요금, 못 정하면 미확인
      const g3m = await d12({ ...MANALL, api: { '/api/transit': busRoute1([V('104', '일반'), V('5', '마을')]) }, arr: arrOf(['5', 420], ['104', 600]) });
      const g3i = await d12({ ...MANALL, api: { '/api/transit': busRoute1([V('104', '일반'), V('5', '마을')]) }, arr: arrOf(['104', 420], ['5', 600]) });
      const g3n = await d12({ ...MANALL, api: { '/api/transit': busRoute1([V('104', '일반'), V('5', '마을')]) }, arr: {} });
      ok('A17-03 후보마다 요금이 다르면(1,350~1,500원) 실제로 탈 버스 기준(5번 마을 1,350 · 104번 일반 1,500) · 탈 버스를 못 정하면 요금 미확인(이유: 탈 버스에 따라 달라짐)',
        g3m.t.bus.routeNo === '5' && g3m.t.fare === 1350 && /5번 기준/.test(g3m.t.fareNote) && g3i.t.fare === 1500 && g3n.t.fare == null && g3n.t.why.some((x) => /탈 버스에 따라 요금이 달라짐\(1,350원~1,500원\)/.test(x)),
        `${g3m.t.fare} · ${g3i.t.fare} · ${g3n.t.why.find((x) => /요금/.test(x))}`);
      // 4) 요금 미확인 원인별 문구
      const two = (v1, v2, fare = {}) => () => ({ routes: [{ type: 'BUS', totalSec: 3600, fare: null, ...fare, steps: [W(180, P, BUS0), busV(v1, ['궁동네거리', '중간정류장'], 900, { lat: 36.35, lng: 127.39 }), W(60, { lat: 36.35, lng: 127.39 }, { lat: 36.35, lng: 127.39 }), busV(v2, ['중간정류장', '대전역'], 1200, DJ), W(60, DJ, DJ)] }] });
      const why = async (api) => { const g = await d12({ ...MANALL, api: { '/api/transit': api }, arr: arrOf(['104', 420], ['601', 420]) }); return { fare: g.t.fare, w: g.t.why.find((x) => /요금/.test(x)) || '', note: g.t.fareNote || '' }; };
      const wr = await why(two([V('601', '일반'), V('602', '일반')], [V('602', '일반'), V('701', '일반')]));
      const ws = await why(two([V('601', '일반')], [V('9000', '좌석')]));
      const wc = await why(busRoute1([V('104', '일반')], { fare: 1550 }));
      const wg = await why(two([V('601', '일반')], [V('B1', '광역')], { fare: 2000 }));
      const wz = await d12({ ...MANALL, api: { '/api/transit': subRoute([V('104', '일반')]) }, arr: arrOf(['104', 540]) });
      wz.w.T.SC.subway.zoneConfirmed = {}; wz.w.T.st.plans.forEach((p) => { p.fare = null; });
      const wz2 = await d12({ ...MANALL, api: { '/api/transit': subRoute([V('104', '일반')]) }, arr: arrOf(['104', 540]), zoneOff: true });
      ok('A17-04 요금 미확인 원인 구분: 같은 노선 재탑승 가능 → \'다시 탈 수 있어 환승 할인 확정 불가\' · 좌석만 있는 구간 → \'일반·마을버스가 없는 구간\' · 공식 1,500 vs 카카오 1,550 → \'달라 확인 필요\' · 광역 포함·공식 계산 불가 → 카카오 안내 요금(2,000원) 사용',
        wr.fare == null && /다시 탈 수 있어/.test(wr.w) && ws.fare == null && /일반·마을버스가 없는 구간/.test(ws.w) && wc.fare == null && /공식 계산 1,500원과 카카오 안내 1,550원이 달라/.test(wc.w) && wg.fare === 2000 && /카카오 안내 요금/.test(wg.note),
        [wr.w, ws.w, wc.w, wg.fare + ' ' + wg.note].join(' / '));
      // 5) 비교 기준 동률: 같은 분에 도착하는 두 버스 경로(일반 1,500 · 마을 1,350) → 싼 경로 · 요금도 같으면 먼저 평가된 경로
      const tie = (t1, t2) => () => ({ routes: [
        { type: 'BUS', totalSec: 3000, fare: null, steps: [W(180, P, BUS0), busV([V('104', t1)], ['궁동네거리', '대전역'], 2100, DJ), W(60, DJ, DJ)] },
        { type: 'BUS', totalSec: 3100, fare: null, steps: [W(180, P, BUS0), busV([V('105', t2)], ['궁동네거리', '대전역서광장'], 2100, DJ), W(60, DJ, DJ)] }] });
      const gt = await d12({ ...MANALL, api: { '/api/transit': tie('일반', '마을') }, arr: arrOf(['104', 420], ['105', 420]) });
      const gs = await d12({ ...MANALL, api: { '/api/transit': tie('일반', '일반') }, arr: arrOf(['104', 420], ['105', 420]) });
      const tt0 = gt.transitAll.map((r) => `${r.sub}:${r.fare}:${Math.floor(r.arrive / 60000)}`).join(' ');
      ok('A17-05 비교 기준 동률: 같은 시각 도착 → 요금이 싼 경로(105번 마을 1,350원)가 비교 기준 · 시간·요금이 같으면 먼저 평가된 경로(104번) · 추천 예산도 그 요금 기준',
        gt.transitAll.length === 2 && gt.baseline && gt.baseline.fare === 1350 && /105번/.test(gt.baseline.sub) && gs.baseline && /104번/.test(gs.baseline.sub) && gt.w.T.pickBest(gt.list, 0) === gt.baseline, tt0);
      // 추천도 같은 분이면 싼 경로: 직접 만든 목록으로 확인
      const T0 = KST(14, 0), mk = (id, fare, min, sec = 0, extra = {}) => ({ id, avail: 'ok', fare, arrive: T0 + min * 60000 + sec * 1000, ...extra });
      const lst = [mk('base', 1500, 60, 0, { baseline: true }), mk('a', 9000, 30, 10), mk('b', 5000, 30, 40), mk('c', 5000, 30, 50)];
      ok('A17-06 추천 동률: 같은 분(14:30)에 도착하면 요금이 싼 경로(5,000원) · 요금도 같으면 원래 순서(b) · 더 비싼 9,000원은 몇 초 빨라도 추천 안 함', gt.w.T.pickBest(lst, null).id === 'b', gt.w.T.pickBest(lst, null).id);
      // 6) 시각표 상태: 조회 실패 / 응답 불완전 / 지금 이후 열차 없음(운행 종료)
      const gF = await d12({ fail: ['/api/subway'] }), gB = await d12({ api: { '/api/subway': () => ({ mock: false, days: 'x' }) } });
      const gE = await d12({ api: { '/api/subway': () => timetable(13) } });
      const sub = (g) => g.list.find((r) => r.kind === 'transit' && r.plan && r.plan.subStep);
      ok('A17-07 시각표 조회 실패는 \'열차 시각표 확인 실패\'(간격 가정·가정값 포함·운행 종료 아님) · 응답 불완전은 \'열차 시각표 불완전\' · 시각표상 지금 이후 열차가 없으면 \'지하철 운행 종료\'(이용 불가)',
        sub(gF).avail === 'unknown' && sub(gF).why.some((x) => /열차 시각표 확인 실패 · 간격 가정/.test(x)) && !sub(gF).why.some((x) => /운행 종료/.test(x))
        && sub(gB).why.some((x) => /열차 시각표 불완전/.test(x)) && sub(gE).avail === 'no' && sub(gE).why.includes('지하철 운행 종료'),
        [sub(gF).why.join('/'), sub(gB).why.join('/'), sub(gE).why.join('/')].join(' | '));
      // 7) 비교 기준 없음 안내에 실제 제외 원인
      const dmE = mkDom(); const gN = await d12({ doc: dmE.document, fail: ['/api/subway', '/api/busroute'], man: { 104: ['DJB_X'], 9000: ['DJB_X'] }, arr: arrOf(['104', 540], ['9000', 420]), api: { '/api/transit': () => ({ routes: [subRoute([V('104', '일반')])().routes[0], { type: 'BUS', totalSec: 3200, fare: null, steps: [W(180, P, BUS0), busV([V('9000', '좌석')], ['궁동네거리', '대전역'], 2100, DJ), W(60, DJ, DJ)] }] }) } });
      gN.w.T.render();
      const banner = all(dmE.byId['#content'], (n) => n.className === 'banner').map(txt).join(' ');
      ok('A17-08 \'비교 기준 없음\' 안내에 실제 제외 원인(열차 시각표 확인 실패 1개 · 요금 미확인 1개 등)을 표시 · 미확인 경로는 이용 가능·추천으로 승격 안 함',
        gN.baseline === null && /제외 원인: .*열차 시각표 확인 실패 1개/.test(banner) && /요금 미확인 1개/.test(banner) && [0, 3000, 7000, null].every((a) => gN.w.T.pickBest(gN.list, a) === null), banner.slice(-80));

      /* ===== update12: 대전교통공사 공식 역간 거리로 지하철 요금 구간 판정 (A19) ===== */
      // 실제 값(2026-11-20): 114→104 9.1㎞·fee 1,400 · 115→104 10.1㎞·1,500 · 117→104 12.4㎞·1,500 · 119→104 14.3㎞·1,500 (fee는 현행 1,550·1,650보다 150원 낮은 과거 운임)
      const DIST = { 114: 9.1, 115: 10.1, 117: 12.4, 119: 14.3, 116: 11.4, 113: 8.3, 118: 13.4, 120: 16.0 };
      const distApi = (over = {}) => (x) => { const f = q(x, 'from'), km = f in over ? over[f] : DIST[f]; return km === undefined ? { mock: false, items: [], complete: false } : { mock: false, from: String(f), to: '104', items: [{ distfloat: String(km), fee: km <= 10 ? '1400' : '1500', min: '19', sec: '0' }], complete: true, at: KST(14, 0) }; };
      const subV = (from, vs, fare = {}) => () => ({ routes: [{ type: 'BUS_AND_SUBWAY', totalSec: 2600, fare: null, ...fare, steps: [W(180, P, BUS0), busV(vs, ['궁동네거리', '유성구청', ST[from].n + '역'], 600, ST[from]), W(120, ST[from], ST[from]), SUB(from, 1500), W(60, DJ, DJ)] }] });
      const MAN19 = { fail: ['/api/busroute'], man: { 104: ['DJB_X'] }, arr: arrOf(['104', 540]) };
      // 1) 확인값이 없는 구암(117): 공식 거리 12.4㎞ → 2구간 → 버스(일반 1,500)+지하철 = 1,650원(단순 합산 아님) · 타슈 연계 구암역도 1,650원
      const g19 = await d12({ ...MAN19, zone: { '114-104': 1 }, api: { '/api/transit': subV(117, [V('104', '일반')]), '/api/stdist': distApi() } });
      const m117 = g19.mix.tashu.find((r) => r.hub.stNum === '117');
      ok('A19-01 확인값이 없는 구암역(117)→대전역: 공식 역간 거리 12.4㎞ → 2구간 · 버스+지하철 환승 합계 1,650원(1,500+1,650 합산 아님) · 타슈 연계 요금도 1,650원(근거 표시)',
        g19.t.fare === 1650 && g19.t.avail === 'ok' && m117 && m117.fare === 1650 && /공식 역간 거리 12\.4㎞/.test(m117.fareNote), `${g19.t.fare} · ${m117 && m117.fare} · ${m117 && m117.fareNote}`);
      // 2) 경계: 10.0㎞ → 1구간 1,550 · 10.01㎞ → 2구간 1,650 (지하철만 경로, 카카오 요금 없음)
      const subOnly = (from) => () => ({ routes: [{ type: 'SUBWAY', totalSec: 2000, fare: null, steps: [W(600, P, ST[from]), SUB(from, 1500), W(60, DJ, DJ)] }] });
      const gb1 = await d12({ zone: {}, api: { '/api/transit': subOnly(117), '/api/stdist': distApi({ 117: 10.0 }) } });
      const gb2 = await d12({ zone: {}, api: { '/api/transit': subOnly(117), '/api/stdist': distApi({ 117: 10.01 }) } });
      ok('A19-02 10㎞ 경계: 공식 거리 10.0㎞ → 1구간 1,550원 · 10.01㎞ → 2구간 1,650원 · API 운임(fee 1,400·1,500)은 과거 금액이라 쓰지 않고 현행 운임표로 계산', gb1.t.fare === 1550 && gb2.t.fare === 1650, `${gb1.t.fare} / ${gb2.t.fare}`);
      // 3) 공식 거리 구간과 확인값이 다르면 확정하지 않음
      const gc = await d12({ ...MAN19, zone: { '115-104': 1 }, api: { '/api/transit': subV(115, [V('104', '일반')]), '/api/stdist': distApi() } });
      ok('A19-03 공식 거리(갑천 10.1㎞ = 2구간)와 확인값(1구간)이 다르면 요금 미확인(이유 표시) · 비교 기준 제외', gc.t.fare == null && gc.t.why.some((x) => /공식 역간 거리 10\.1㎞\(2구간\)와 확인값\(1구간\)이 달라/.test(x)) && gc.baseline === null, gc.t.why.find((x) => /요금/.test(x)));
      // 4) API 실패·이상 값 → 확인값으로 안전하게 · 근거가 없으면 기존 처리(카카오 대조·미확인)
      const gf = await d12({ ...MAN19, fail: ['/api/busroute', '/api/stdist'], api: { '/api/transit': subV(115, [V('104', '일반')]) } });
      const badV = [];
      for (const v of [0, -1, 'abc', 99, '']) { const gx = await d12({ ...MAN19, zone: {}, api: { '/api/transit': subV(117, [V('104', '일반')]), '/api/stdist': distApi({ 117: v }) } }); badV.push(gx.t.fare == null && gx.t.why.some((x) => /구간 요금.*확인 근거 없음/.test(x))); }
      const gk = await d12({ ...MAN19, zone: {}, fail: ['/api/busroute', '/api/stdist'], api: { '/api/transit': subV(117, [V('104', '일반')], { fare: 1650 }) } });
      ok('A19-04 역간 거리 조회 실패 → 확인값(갑천 2구간)으로 1,650원 · 거리 0·음수·문자·99㎞·빈 값은 쓰지 않음(근거 없음 → 요금 미확인) · 근거가 없을 때만 카카오 요금 대조(구간 확인 불가 시 기존 규칙)',
        gf.t.fare === 1650 && badV.every(Boolean) && gk.t.fare === 1650, `${gf.t.fare} · ${badV.join(',')} · ${gk.t.fare}(${gk.t.fareNote})`);
      // 5) 호출: 같은 구간은 세션에서 재사용(새로고침 때도 다시 안 부름) · 실패한 구간만 다시 · 추가 비용 바꿔도 0회
      const gr = await d12({ ...MAN19, api: { '/api/transit': subV(117, [V('104', '일반')]), '/api/stdist': distApi() } });
      const s0 = gr.w.calls['/api/stdist']; const pairs0 = new Set(gr.w.calls.urls.filter((u) => u.startsWith('/api/stdist'))).size;
      await gr.w.T.loadStops(true); const s1 = gr.w.calls['/api/stdist'];
      gr.w.T.setAllowFixed(null); gr.w.T.setAllowCustom('7000'); const s2 = gr.w.calls['/api/stdist'];
      const gq = await d12({ ...MAN19, fail: ['/api/busroute', '/api/stdist'], api: { '/api/transit': subV(117, [V('104', '일반')]) } });
      const f0 = gq.w.calls['/api/stdist']; await gq.w.T.loadStops(true);
      ok('A19-05 공식 역간 거리 호출: 서로 다른 지하철 구간당 1번 · 새로고침·추가 비용 변경 때 다시 안 부름 · 실패한 구간은 다음 로딩 때 다시 조회', s0 === pairs0 && s1 === s0 && s2 === s0 && gq.w.calls['/api/stdist'] === f0 * 2, `${s0}=${pairs0} → ${s1} → ${s2} · 실패 ${f0} → ${gq.w.calls['/api/stdist']}`);

      /* ----- update12: 화면도 같은 기준으로 역간 거리 검사 (A20) ----- */
      const dApi = (body) => () => ({ mock: false, at: KST(14, 0), ...body });
      const sv = (it, extra = {}) => dApi({ items: [it], complete: true, ...extra });
      const base20 = { ...MAN19, zone: {}, api: { '/api/transit': subV(117, [V('104', '일반')]) } };
      const cases20 = [['정상', sv({ distfloat: '12.4', fee: '1500', min: '25', sec: '0' }), 1650], ['서버 complete:false', dApi({ items: [{ distfloat: '12.4', min: '25', sec: '0' }], complete: false, why: 'x' }), null],
        ['0x0a', sv({ distfloat: '0x0a', min: '25', sec: '0' }), null], ['1.01e1', sv({ distfloat: '1.01e1', min: '25', sec: '0' }), null], ['숫자형', sv({ distfloat: 12.4, min: '25', sec: '0' }), null],
        ['sec 75', sv({ distfloat: '12.4', min: '25', sec: '75' }), null], ['출발역 불일치', sv({ strstnno: '119', endstnno: '104', distfloat: '14.3', min: '28', sec: '40' }), null], ['item 2개', dApi({ items: [{ distfloat: '12.4', min: '25', sec: '0' }, { distfloat: '9.1', min: '19', sec: '0' }], complete: true }), null]];
      const r20 = [];
      for (const [label, api0, want] of cases20) { const g = await d12({ ...base20, api: { ...base20.api, '/api/stdist': api0 } }); r20.push({ label, ok: want == null ? g.t.fare == null && g.baseline === null && !g.w.T.st.dist['117-104'].km : g.t.fare === want && g.w.T.st.dist['117-104'].km === 12.4, f: g.t.fare }); }
      const g20 = await d12({ ...base20, zone: { '117-104': 2 }, api: { ...base20.api, '/api/stdist': sv({ distfloat: '1.01e1', min: '25', sec: '0' }) } });
      ok('A20-01 화면도 서버와 같은 기준: 서버가 complete:false로 보낸 값·0x0a·1.01e1·숫자형·sec 75·요청과 다른 역번호·item 2개는 공식 운임 근거로 쓰지 않음(확인값이 없으면 요금 미확인·비교 기준 아님) · 정상 12.4㎞만 2구간 1,650원 · 확인값이 있으면 그것으로 안전하게 계산',
        r20.every((x) => x.ok) && g20.t.fare === 1650 && !g20.w.T.st.dist['117-104'].km, r20.map((x) => `${x.label}:${x.f}`).join(' '));

      /* ----- update12: 화면도 min/sec 안전 정수 검사 (A21) ----- */
      const r21 = [];
      for (const [label, m, sc] of [['min 309자리', '9'.repeat(309), '0'], ['sec 309자리', '25', '9'.repeat(309)], ['min 안전 정수 초과', '9007199254740993', '0'], ['min 61', '61', '0']]) {
        const g = await d12({ ...base20, api: { ...base20.api, '/api/stdist': sv({ distfloat: '12.4', min: m, sec: sc }) } });
        r21.push({ label, ok: g.t.fare == null && g.baseline === null && !g.w.T.st.dist['117-104'].km && [0, 7000, null].every((a) => g.w.T.pickBest(g.list, a) !== g.t) });
      }
      const g21 = await d12({ ...base20, api: { ...base20.api, '/api/stdist': sv({ distfloat: '14.3', min: '28', sec: '40' }) } });
      ok('A21-01 화면: 서버를 거치지 않은 309자리·안전 정수 초과 min/sec·min 61 거리 정보는 공식 운임 근거로 쓰지 않음(요금 미확인·비교 기준·추천 아님) · 정상 28분 40초는 그대로 2구간 1,650원',
        r21.every((x) => x.ok) && g21.t.fare === 1650 && g21.w.T.st.dist['117-104'].sec === 40, r21.filter((x) => !x.ok).map((x) => x.label).join(', ') || '4가지 모두 차단 · 정상 유지');
    }
  }
  {
    // 서버: 카카오맵 경로 조회 (공식 문서 예시 응답 구조)
    for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'QUOTA_TAGO_ARRIVAL']) delete process.env[k];
    Object.assign(process.env, { MOCK: '0', KAKAO_REST_KEY: 'fake', QUOTA_KAKAO_TRANSIT: '2' });
    const docTransit = { status: 'OK', properties: { total: 1 }, routes: [{ properties: { type: 'BUS', totalDistance: 5013, totalTime: 2115, transfers: 0, fare: { value: 1350 } },
      steps: [{ properties: { guidance: '마을 76 (판교역동편 > 성남시청전면)', type: 'BUS', distance: 4127, time: 1158, stops: [{ name: '판교역동편' }, { name: '봇들마을7.8단지.롯데마트판교점' }], vehicles: [{ name: '76', type: '마을' }] },
        path: { points: [[127.11316378, 37.3948816], [127.11312974, 37.39488161]] } }] }] };
    const docWalk = { route: { properties: { totalDistance: 4025, totalTime: 3914 }, legs: [] }, status: 'OK' };
    let ext2 = [], walkStatus = 'OK';
    global.fetch = async (url) => {
      const u2 = String(url); ext2.push(u2);
      const body = u2.includes('/publictraffic') ? docTransit : u2.includes('/routing/') ? (walkStatus === 'OK' ? docWalk : { status: walkStatus }) : { documents: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let core2 = fresh();
    const rq = { olat: '36.3653', olng: '127.3465', dlat: '36.3324', dlng: '127.4343' };
    const t1 = await run(core2, core2.transit, { perMin: 30 }, rq);
    const st0 = t1.body.routes && t1.body.routes[0] && t1.body.routes[0].steps[0];
    ok('S10-01 대중교통 응답 정리: 노선·정류장 이름·구간 시간·좌표(경도,위도 순서)', t1.status === 200 && st0.vehicles[0].name === '76' && st0.stops[1] === '봇들마을7.8단지.롯데마트판교점' && st0.sec === 1158 && st0.start.lat === 37.3948816 && st0.start.lng === 127.11316378 && t1.body.routes[0].fare === 1350);
    const u0 = new URL(ext2[0]);
    ok('S10-02 요청 좌표: start_x=경도 · start_y=위도 · 카카오 결과 no-store', u0.searchParams.get('start_x') === '127.3465' && u0.searchParams.get('start_y') === '36.3653' && t1.cache === 'no-store');
    await run(core2, core2.transit, { perMin: 30 }, rq); const t3 = await run(core2, core2.transit, { perMin: 30 }, rq);
    const sOk = await run(core2, core2.search, { perMin: 30 }, { q: '대전역' });
    ok('S10-03 하루 한도: 대중교통은 kakao_transit 따로 셈 (한도 2 → 3번째 429, 검색은 영향 없음)', t3.status === 429 && sOk.status === 200 && ext2.filter((x) => x.includes('publictraffic')).length === 2);
    const wk = await run(core2, core2.walk, { perMin: 30 }, rq);
    walkStatus = 'TOO_FAR_AWAY'; const bk = await run(core2, core2.bike, { perMin: 30 }, rq);
    ok('S10-04 도보·자전거: 소요시간 정리 · 실패 상태는 안내 문구로', wk.body.sec === 3914 && wk.body.m === 4025 && bk.status === 404 && /너무 멀/.test(bk.body.error), bk.body.error);
    ok('S10-05 호출량 분류: 대중교통·도보·자전거·검색 각각 따로', ['publictraffic', 'walk', 'bicycle'].map((k) => core2._test.quotaFor(`https://dapi.kakao.com/v2/routing/${k}?a=1`)).join() === 'kakao_transit,kakao_walk,kakao_bike' && core2._test.quotaFor('https://dapi.kakao.com/v2/local/search/keyword.json') === 'kakao_search');
    process.env.MOCK = '1'; ext2 = []; core2 = fresh();
    const m1 = await run(core2, core2.transit, { perMin: 30 }, rq), m2 = await run(core2, core2.walk, { perMin: 30 }, rq), m3 = await run(core2, core2.bike, { perMin: 30 }, rq);
    ok('S10-06 MOCK=1: 대중교통·도보·자전거 외부 호출 0회', ext2.length === 0 && [m1, m2, m3].every((r) => r.status === 501));
    process.env.MOCK = '0'; ext2 = []; core2 = fresh();
    const out = await run(core2, core2.transit, { perMin: 30 }, { ...rq, olat: '37.5', olng: '127.0' });
    ok('S10-07 대전 밖 좌표는 길찾기 거절 (외부 호출 없음)', out.status === 400 && ext2.length === 0);
    // 서버: null·음수·비정상 좌표 응답은 정상으로 쓰지 않음
    const bad = (mut) => { const j = JSON.parse(JSON.stringify(docTransit)); mut(j.routes[0].steps[0].properties, j.routes[0].steps[0]); return j; };
    const P1 = core2._test.parseTransit;
    const thrown = (f) => { try { f(); return false; } catch (e) { return e.status === 404 || e.status === 502; } };
    const pBad = P1(bad((p, s) => { s.path.points = [[200, 95], [127.1, 37.4]]; })).length === 1;   // 좌표만 비정상이면 경로는 남고 시작 좌표는 null
    const pBadStart = P1(bad((p, s) => { s.path.points = [[200, 95]]; }))[0].steps[0].start === null;
    ok('S10-08 대중교통: 음수·null 구간 시간은 거절, 비정상 좌표는 null 처리', thrown(() => P1(bad((p) => { p.time = -1; }))) && thrown(() => P1(bad((p) => { p.time = null; })))
      && thrown(() => P1(bad((p) => { p.distance = ''; }))) && pBad && pBadStart);
    const L1 = core2._test.parseLeg;
    ok('S10-09 도보·자전거: 소요시간·거리 null·음수 거절', thrown(() => L1({ route: { properties: { totalTime: null, totalDistance: 10 } } })) && thrown(() => L1({ route: { properties: { totalTime: 60, totalDistance: -1 } } })) && L1({ route: { properties: { totalTime: 0, totalDistance: 0 } } }).sec === 0);
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ routes: [{ result_code: 0, summary: { duration: -5, distance: 100, fare: { taxi: 3000 } } }] }) });
    core2 = fresh(); const dneg = await run(core2, core2.drive, { perMin: 30 }, rq);
    ok('S10-10 택시 길찾기: 음수 소요시간 응답은 오류로 처리', dneg.status === 502, dneg.body.error);
    const driveWith = async (summary) => { global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ routes: [{ result_code: 0, summary }] }) }); const c = fresh(); return run(c, c.drive, { perMin: 30 }, rq); };
    const dn = await driveWith({ duration: 600, distance: null, fare: { taxi: 7000 } }), de = await driveWith({ duration: 600, distance: '', fare: { taxi: 7000 } }), dm = await driveWith({ duration: 600, distance: -10, fare: { taxi: 7000 } });
    const dd = await driveWith({ duration: null, distance: 100, fare: { taxi: 7000 } }), df = await driveWith({ duration: 600, distance: 5000, fare: { taxi: null } }), dok = await driveWith({ duration: '600', distance: '5000', fare: { taxi: '7000' } });
    ok('F10-04 택시 거리 null·빈값·음수, 시간 null은 오류(0으로 바꾸지 않음) · 요금 null은 요금 미확인 · 숫자 문자열은 정상', [dn, de, dm, dd].every((r) => r.status === 502) && df.status === 200 && df.body.taxiFare === null && dok.status === 200 && dok.body.distanceM === 5000 && dok.body.durationSec === 600,
      [dn, de, dm, dd, df].map((r) => r.status).join(','));
    // 서버: 시각표 행선지 표기('48(판암)'·'58(정부청사)') — 하차역까지 가는 열차만, null 없음
    const item = (n, tm, z) => '<item><dayType>0</dayType><drctType>0</drctType><stNum>' + n + '</stNum><tmList>' + tm + '</tmList><tmZone>' + z + '</tmZone></item>';
    let body = item(114, '10 20 30 40 48(판암) 58(정부청사) 59(어딘가)', 23) + item(104, '29 39 49 59 07', 23);
    for (let i = 0; i < 8; i++) body += item(114, '00 10', 10 + i) + item(104, '19 29', 10 + i);
    const xml = '<response><header><resultCode>00</resultCode></header><body><items>' + body + '</items></body></response>';
    global.fetch = async () => ({ ok: true, status: 200, text: async () => xml });
    core2 = fresh(); const sw = await core2.subway({ from: '114', to: '104' }), fr = sw.days[0][0].from;
    ok('S10-11 시각표 행선지 표기: 판암행 23:48은 포함, 정부청사행 23:58·모르는 행선지는 제외, null 없음', fr.includes(23 * 60 + 48) && !fr.includes(23 * 60 + 58) && !fr.includes(23 * 60 + 59) && fr.every((t) => Number.isFinite(t)) && sw.days[0][0].ride === 19, JSON.stringify(sw.shortTurn));
    // 서버: 분당 호출 제한은 API별로 따로 (택시 30회를 써도 도보는 됨)
    global.fetch = async (u) => ({ ok: true, status: 200, text: async () => JSON.stringify(String(u).includes('kakaomobility') ? { routes: [{ result_code: 0, summary: { duration: 600, distance: 5000, fare: { taxi: 7000 } } }] } : { status: 'OK', route: { properties: { totalTime: 60, totalDistance: 50 } } }) });
    core2 = fresh(); for (let i = 0; i < 31; i++) await run(core2, core2.drive, { perMin: 30 }, rq, '7.7.7.7');
    const d31 = await run(core2, core2.drive, { perMin: 30 }, rq, '7.7.7.7'), wk1 = await run(core2, core2.walk, { perMin: 30 }, rq, '7.7.7.7');
    ok('S10-12 분당 호출 제한은 API별로 따로 셈 (택시 한도 초과 후에도 도보 길찾기는 정상)', d31.status === 429 && wk1.status === 200);
    // 서버: 근처 지하철역 (카카오 로컬 카테고리 SW8 · update12)
    let su = [];
    global.fetch = async (u) => { su.push(String(u)); return { ok: true, status: 200, text: async () => JSON.stringify({ documents: [{ place_name: '월평역 대전1호선', category_name: '교통,수송 > 지하철,전철 > 대전1호선', x: '127.3638', y: '36.3583', distance: '1820' }, { place_name: '좌표없음역', x: '', y: null, distance: '10' }] }) }; };
    core2 = fresh(); const sq = await run(core2, core2.stations, { perMin: 30 }, { lat: '36.3653', lng: '127.3465', r: '99999' });
    const su0 = new URL(su[0]);
    ok('S12-01 근처 지하철역: 공식 명세대로 SW8·x=경도·y=위도·거리순 · 반경 최대 5km로 제한 · 좌표 없는 항목 제외 · no-store', sq.status === 200 && sq.body.stations.length === 1 && sq.body.stations[0].d === 1820 && su0.searchParams.get('category_group_code') === 'SW8'
      && su0.searchParams.get('x') === '127.3465' && su0.searchParams.get('y') === '36.3653' && su0.searchParams.get('radius') === '5000' && su0.searchParams.get('sort') === 'distance' && sq.cache === 'no-store');
    ok('S12-02 지하철역 검색은 하루 한도에서 장소 검색(kakao_search)과 같이 셈', core2._test.quotaFor('https://dapi.kakao.com/v2/local/search/category.json?x=1') === 'kakao_search');
    su = []; process.env.MOCK = '1'; core2 = fresh();
    const sm = await run(core2, core2.stations, { perMin: 30 }, { lat: '36.3653', lng: '127.3465' }); process.env.MOCK = '0'; core2 = fresh();
    const so = await run(core2, core2.stations, { perMin: 30 }, { lat: '37.5', lng: '127.0' });
    ok('S12-03 MOCK=1이면 외부 호출 없이 501 · 대전 밖 좌표는 400', sm.status === 501 && so.status === 400 && su.length === 0);
    // 서버: TAGO 버스노선정보 (update12 · 노선번호목록 → 노선별경유정류소, 페이지 끝까지 · 불완전하면 오류·캐시 안 함)
    let rx = [], rmode = 'ok';
    const tj = (items, total, extra = {}) => JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: items.length ? { item: items } : '', numOfRows: 100, pageNo: 1, ...(total === undefined ? {} : { totalCount: total }), ...extra } } });
    const stopRow = (i) => ({ nodeid: 'DJB' + (8000000 + i), nodenm: '정류장' + i, nodeno: 40000 + i, nodeord: i, gpslati: 36.3 + i / 1000, gpslong: 127.3 + i / 1000, updowncd: i <= 80 ? 0 : 1, routeid: 'DJB30300043' });
    global.fetch = async (url) => {
      const u = new URL(String(url)), op = u.pathname.split('/').pop(), page = Number(u.searchParams.get('pageNo'));
      rx.push(`${op}:${page}`);
      await new Promise((r) => setTimeout(r, 5));
      let text;
      if (op === 'getRouteNoList') text = tj([{ routeid: 'DJB30300043', routeno: 108, routetp: '간선버스', startnodenm: '낭월공영차고지기점', endnodenm: '충대농대종점' }, { routeid: 'DJB30300999', routeno: '108-1', routetp: '지선버스' }], 2, { pageNo: page });
      else {
        const rows = Array.from({ length: 150 }, (_, k) => stopRow(k + 1));
        if (rmode === 'nogps') rows[10].gpslati = '';
        if (rmode === 'noud') rows.forEach((x) => delete x.updowncd);
        const items = page === 1 ? rows.slice(0, 100) : rmode === 'short' ? [] : rows.slice(100);
        text = tj(items, rmode === 'nototal' ? undefined : 150, { pageNo: page });   // 실제 응답처럼 요청한 쪽 번호를 돌려줌
      }
      return { ok: true, status: 200, text: async () => text };
    };
    core2 = fresh();
    const br = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    const r0 = br.body.routes && br.body.routes[0];
    ok('S12-04 버스노선: 번호가 정확히 같은 노선만(108-1 제외) · 경유 정류장 2쪽(100+50)을 끝까지 받아 150개 · 순번 정렬 · 상하행 0/1 · 필수 항목 다 있으면 complete',
      br.status === 200 && br.body.routes.length === 1 && r0.routeId === 'DJB30300043' && r0.stops.length === 150 && r0.complete && r0.hasUd && r0.stops.every((x, i) => x.ord === i + 1) && r0.stops[0].ud === 0 && r0.stops[149].ud === 1 && rx.join() === 'getRouteNoList:1,getRouteAcctoThrghSttnList:1,getRouteAcctoThrghSttnList:2',
      rx.join());
    rx = []; const br2 = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    ok('S12-05 버스노선 서버 캐시: 두 번째 요청은 외부 호출 0회 · CDN 캐시는 좌표 없는 공공 데이터라 허용', br2.status === 200 && rx.length === 0 && /s-maxage=21600/.test(br2.cache || ''), br2.cache);
    rx = []; core2 = fresh();
    const [c1, c2] = await Promise.all([run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' }, '2.2.2.2'), run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' }, '3.3.3.3')]);
    ok('S12-06 동시에 같은 노선을 요청하면 외부 호출을 합쳐 1번만 (목록 1 + 경유 2쪽)', c1.status === 200 && c2.status === 200 && rx.length === 3, `${rx.length}회`);
    rmode = 'short'; rx = []; core2 = fresh();
    const bs = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    rmode = 'ok'; rx = [];
    const bs2 = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    ok('S12-07 불완전한 페이지(전체 150 중 100건만): 오류(502)로 돌려주고 캐시하지 않음 → 다음 요청은 다시 조회', bs.status === 502 && /불완전/.test(bs.body.error) && bs2.status === 200 && rx.length === 3, bs.body.error);
    rmode = 'nototal'; core2 = fresh();
    const bt = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    rmode = 'nogps'; core2 = fresh();
    const bg = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    rmode = 'noud'; core2 = fresh();
    const bu = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    ok('S12-08 전체 건수 없음 → 오류 · 좌표 빈 정류장 → 그 노선은 complete=false(방향 확정에 안 씀) · 상하행 코드 없음 → hasUd=false, ud=null (0으로 채우지 않음)',
      bt.status === 502 && /전체 건수\(totalCount\)가 없어/.test(bt.body.error) && bg.status === 200 && bg.body.routes[0].complete === false && bg.body.routes[0].stops[10].lat === null && bu.status === 200 && bu.body.routes[0].hasUd === false && bu.body.routes[0].stops.every((x) => x.ud === null));
    rmode = 'ok'; rx = []; process.env.MOCK = '1'; core2 = fresh();
    const bm = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    process.env.MOCK = '0'; core2 = fresh();
    const bi = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108;DROP' });
    ok('S12-09 MOCK=1: 외부 호출 0회(예시 응답, 노선 없음) · 잘못된 노선 번호는 400 · 하루 한도는 tago_route로 따로 셈', bm.status === 200 && bm.body.mock === true && bm.body.routes.length === 0 && bi.status === 400 && rx.length === 0
      && core2._test.quotaFor('https://apis.data.go.kr/1613000/BusRouteInfoInqireService/getRouteNoList?a=1') === 'tago_route' && core2._test.quotaFor('https://apis.data.go.kr/1613000/ArvlInfoInqireService/x') === 'tago_arrival');
    process.env.QUOTA_TAGO_ROUTE = '1'; rx = []; core2 = fresh();
    const bq = await run(core2, core2.busRoute, { cacheSec: 21600 }, { routeNo: '108' });
    delete process.env.QUOTA_TAGO_ROUTE;
    ok('S12-10 노선 정보 하루 한도(QUOTA_TAGO_ROUTE) 초과: 외부 호출 중단(429) · 일부만 받은 결과는 캐시 안 함', bq.status === 429 && rx.length === 1, `${bq.status} · 외부 ${rx.length}회`);

    /* ===== update12 독립 감사 결함 회귀 · 서버 (A13-S) ===== */
    // 경유 정류장 응답을 쪽마다 바꿔 보내는 도우미: hook(op, page) → { items, total, pageNo } (없으면 기본 응답)
    let hook = null;
    const fetchBase = global.fetch;
    global.fetch = async (url, opt) => {
      const u = new URL(String(url)), op = u.pathname.split('/').pop(), page = Number(u.searchParams.get('pageNo'));
      const h = hook && hook(op, page, u);
      if (!h) return fetchBase(url, opt);
      rx.push(`${op}:${page}`);
      return { ok: true, status: 200, text: async () => (typeof h === 'string' ? h : tj(h.items, h.total, h.pageNo === undefined ? { pageNo: page } : h.pageNo === null ? {} : { pageNo: h.pageNo })) };
    };
    const rowsN = (n, f = (x) => x) => Array.from({ length: n }, (_, k) => f(stopRow(k + 1), k + 1));
    const busR = async (core, ip) => run(core, core.busRoute, { cacheSec: 21600 }, { routeNo: '108' }, ip);
    // 같은 100건 쪽이 두 번 (전체 200)
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(100), total: 200 } : null);
    rx = []; core2 = fresh();
    const a1 = await busR(core2); rx = []; hook = null; const a1b = await busR(core2);
    ok('A13-S1 전체 200건인데 같은 100건 쪽이 두 번 옴 → 502(반복 쪽) · 캐시 안 함(다음 요청은 다시 조회)', a1.status === 502 && /반복/.test(a1.body.error) && a1b.status === 200 && rx.length === 3, a1.body.error || a1.status);
    // 쪽마다 전체 건수가 다름
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? (page === 1 ? { items: rowsN(100), total: 150 } : { items: rowsN(150).slice(100), total: 160 }) : null);
    core2 = fresh(); const a2 = await busR(core2);
    // 응답 쪽 번호가 요청과 다름 (2쪽 요청 → 1쪽이라고 응답)
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? (page === 1 ? { items: rowsN(100), total: 150 } : { items: rowsN(150).slice(100), total: 150, pageNo: 1 }) : null);
    core2 = fresh(); const a3 = await busR(core2);
    // 마지막이 아닌 쪽이 100건을 못 채움 (60 + 90 = 150)
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? (page === 1 ? { items: rowsN(60), total: 150 } : { items: rowsN(150).slice(60), total: 150 }) : null);
    core2 = fresh(); const a4 = await busR(core2);
    ok('A13-S2 쪽마다 전체 건수가 다름(150→160)·응답 쪽 번호 불일치·중간 쪽이 덜 참(60건) → 모두 502 (건수 합계가 맞아도 완전한 목록으로 보지 않음)',
      a2.status === 502 && /전체 건수가 달라/.test(a2.body.error) && a3.status === 502 && /쪽 응답/.test(a3.body.error) && a4.status === 502 && /끝나지 않았/.test(a4.body.error), [a2, a3, a4].map((x) => x.body.error).join(' / '));
    // 승차·중간·하차 순번이 모두 1 → 노선 complete=false · 전체 complete=false · 서버·CDN 캐시 안 함
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50, (x) => ({ ...x, nodeord: 1 })), total: 50 } : null);
    rx = []; core2 = fresh(); const a5 = await busR(core2); const n5 = rx.length; const a5b = await busR(core2);
    ok('A13-S3 순번이 모두 1(중복 순번) → 200이지만 노선 complete=false·전체 complete=false · Cache-Control no-store · 서버 캐시 안 함(두 번째 요청도 외부 조회)',
      a5.status === 200 && a5.body.complete === false && a5.body.routes[0].complete === false && /같은 순번/.test(a5.body.routes[0].why) && a5.cache === 'no-store' && rx.length === n5 * 2, `${a5.body.why} · ${a5.cache} · 외부 ${n5}→${rx.length}`);
    // 순번 빈칸·상하행 코드가 여러 번 바뀜·좌표 누락 → 불완전 (캐시 안 함)
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50, (x, i) => ({ ...x, nodeord: i < 50 ? i : 60 })), total: 50 } : null);
    core2 = fresh(); const a6 = await busR(core2);
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50, (x, i) => ({ ...x, updowncd: i <= 20 ? 0 : i <= 40 ? 1 : 0 })), total: 50 } : null);
    core2 = fresh(); const a7 = await busR(core2);
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50, (x, i) => (i === 7 ? { ...x, gpslati: '' } : x)), total: 50 } : null);
    rx = []; core2 = fresh(); const a8 = await busR(core2); const n8 = rx.length; await busR(core2);
    ok('A13-S4 순번 빈칸(49→60)·상하행 코드 0→1→0·좌표 누락 → 그 노선 complete=false · 전체 complete=false · no-store · 다시 요청하면 외부 재조회',
      a6.body.complete === false && /비어 있음/.test(a6.body.routes[0].why) && a7.body.complete === false && /2번 바뀜/.test(a7.body.routes[0].why) && a8.body.complete === false && a8.cache === 'no-store' && rx.length === n8 * 2,
      [a6, a7, a8].map((x) => x.body.why).join(' / '));
    // 순환노선: 같은 정류장 ID가 다른 순번으로 다시 나옴 → 정상(complete) · 캐시함
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50, (x, i) => (i === 50 ? { ...stopRow(1), nodeord: 50, updowncd: 1 } : x.updowncd === 1 ? x : { ...x, updowncd: i <= 25 ? 0 : 1 })), total: 50 } : null);
    rx = []; core2 = fresh(); const a9 = await busR(core2); const n9 = rx.length; const a9b = await busR(core2);
    ok('A13-S5 순환노선(같은 정류장 ID가 순번 1·50으로 두 번) → 정상 목록(complete=true) · 서버 캐시·CDN 캐시 유지(기존 정책)',
      a9.status === 200 && a9.body.complete === true && a9.body.routes[0].complete === true && /s-maxage=21600/.test(a9.cache) && a9b.status === 200 && rx.length === n9, `${a9.body.why} · ${a9.cache}`);
    // 노선번호목록: 같은 노선 ID 중복 → 502 · 노선 ID가 7개(6개만 조회) → 전체 complete=false
    const listOf = (ids) => ({ items: ids.map((id) => ({ routeid: id, routeno: 108, routetp: '간선버스' })), total: ids.length });
    hook = (op, page) => (op === 'getRouteNoList' ? listOf(['DJB1', 'DJB1']) : op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: 50 } : null);
    core2 = fresh(); const a10 = await busR(core2);
    hook = (op, page) => (op === 'getRouteNoList' ? listOf(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) : op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: 50 } : null);
    rx = []; core2 = fresh(); const a11 = await busR(core2); const n11 = rx.length; await busR(core2);
    ok('A13-S6 노선번호목록에 같은 노선 ID 중복 → 502 · 노선 ID 7개 중 6개만 조회 → 전체 complete=false · no-store · 캐시 안 함',
      a10.status === 502 && /같은 노선 ID/.test(a10.body.error) && a11.status === 200 && a11.body.complete === false && /6개만/.test(a11.body.why) && a11.cache === 'no-store' && rx.length === n11 * 2, `${a10.body.error} · ${a11.body.why}`);
    // 정상 완전 목록은 기존대로 캐시 (S12-05와 같은 조건을 다시 확인)
    hook = (op, page) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: 50 } : null);
    rx = []; core2 = fresh(); const a12 = await busR(core2); const n12 = rx.length; const a12b = await busR(core2);
    ok('A13-S7 정상 완전 목록: complete=true · 서버 1일 캐시(두 번째 외부 0회) · CDN s-maxage 유지', a12.body.complete === true && a12.body.why === null && rx.length === n12 && /s-maxage=21600/.test(a12b.cache || ''));
    // 도착정보 정거장 수: 빈 값·누락은 null (0으로 보지 않음)
    hook = (op, page, u) => (op === 'getSttnAcctoArvlPrearngeInfoList' ? JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [{ routeno: 108, routeid: 'r', arrtime: 300, arrprevstationcnt: '' }, { routeno: 104, routeid: 'q', arrtime: 400 }, { routeno: 106, routeid: 'z', arrtime: 500, arrprevstationcnt: 0 }, { routeid: 'n', arrtime: 200 }] } } } })
      : u.pathname.includes('/arrive/') ? '<response><msgHeader><returnAuthMsg>NORMAL SERVICE</returnAuthMsg></msgHeader><msgBody><itemList><ROUTE_NO>108</ROUTE_NO><EXTIME_SEC>300</EXTIME_SEC><STATUS_POS></STATUS_POS></itemList><itemList><ROUTE_NO>104</ROUTE_NO><EXTIME_SEC>400</EXTIME_SEC><STATUS_POS>3</STATUS_POS></itemList></msgBody></response>' : null);
    core2 = fresh();
    const ta = await run(core2, core2.arrivals, { cacheSec: 15 }, { nodeId: 'DJB8005589' });
    const da = await run(core2, core2.arrivalsDaejeon, { cacheSec: 15 }, { arsId: '42630' });
    hook = null;
    const tl = (ta.body.list || []).map((x) => `${x.routeNo}:${x.prevCnt}`).join(','), dl = (da.body.list || []).map((x) => `${x.routeNo}:${x.prevCnt}`).join(',');
    ok('A13-S8 도착정보 정거장 수: TAGO 빈 값·누락 → null(0으로 채우지 않음)·0은 0 · 노선 번호 없는 항목 제외 · 대전시 STATUS_POS 빈 값 → null', tl === '108:null,104:null,106:0' && dl === '108:null,104:3', `${tl} / ${dl}`);

    /* ===== update12 최종: TAGO totalCount·routeid 원본 값 검사 (A14-S) ===== */
    const listRows = (rows) => rows.map((r) => ({ routeno: 108, routetp: '간선버스', ...r }));
    // totalCount가 정상 숫자가 아닌 값 → 502 · no-store · 서버 캐시 없음(같은 요청이면 외부를 다시 조회)
    const badTotals = [['null', null], ['누락', undefined], ['빈 문자열', ''], ['공백', '  '], ['음수', -1], ['소수', 1.5], ['boolean', true], ["'12abc'", '12abc'], ["'1.0'", '1.0'], ['객체', {}]];
    const tRes = [];
    for (const [label, tv] of badTotals) {
      hook = (op) => (op === 'getRouteNoList' ? { items: [], total: tv } : null);
      rx = []; core2 = fresh(); const x1 = await busR(core2); const n1 = rx.length; const x2 = await busR(core2);
      tRes.push({ label, ok: x1.status === 502 && /totalCount/.test(x1.body.error || '') && x1.cache === 'no-store' && x2.status === 502 && n1 >= 1 && rx.length === n1 * 2, st: x1.status });
    }
    ok('A14-S1 노선번호목록 totalCount가 null·누락·빈 문자열·공백·음수·소수·boolean·\'12abc\'·\'1.0\'·객체 → 정상 0건으로 보지 않고 502 · no-store · 다시 요청하면 외부 재조회',
      tRes.every((x) => x.ok), tRes.filter((x) => !x.ok).map((x) => `${x.label}:${x.st}`).join(', ') || '10가지 모두');
    hook = (op) => (op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: null } : null);
    core2 = fresh(); const tS = await busR(core2);
    ok('A14-S2 경유 정류장 목록 totalCount null → 502 (Number(null)=0 으로 정상 처리 안 함)', tS.status === 502 && /totalCount/.test(tS.body.error || ''), tS.body.error || tS.status);
    // 정상 0건 · 숫자 문자열
    const zeroRes = [];
    for (const tv of [0, '0']) {
      hook = (op) => (op === 'getRouteNoList' ? { items: [], total: tv } : null);
      rx = []; core2 = fresh(); const z1 = await busR(core2); const nz = rx.length; const z2 = await busR(core2);
      zeroRes.push(z1.status === 200 && z1.body.complete === true && z1.body.routes.length === 0 && /s-maxage=21600/.test(z1.cache) && z2.status === 200 && rx.length === nz);
    }
    hook = (op) => (op === 'getRouteNoList' ? { items: listRows([{ routeid: 'DJB1' }, { routeid: 'DJB2' }]), total: '2' } : op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: '50' } : null);
    core2 = fresh(); const zs = await busR(core2);
    ok('A14-S3 정상 totalCount 0(숫자·문자열) → 정상 0건(complete=true, 노선 없음) · 기존대로 서버·CDN 캐시 · 숫자 문자열(\'2\'·\'50\')도 정상',
      zeroRes.every(Boolean) && zs.status === 200 && zs.body.complete === true && zs.body.routes.length === 2, `${zeroRes.join(',')} · ${zs.status}/${zs.body.complete}`);
    // 조회 번호의 routeid 불량 행
    const idRes = [];
    for (const [label, row] of [['누락', {}], ['null', { routeid: null }], ['빈 문자열', { routeid: '' }], ['공백', { routeid: '  ' }], ['객체', { routeid: {} }], ['기호', { routeid: 'DJB 1;x' }]]) {
      hook = (op) => (op === 'getRouteNoList' ? { items: listRows([{ routeid: 'DJB30300043' }, row]), total: 2 } : op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: 50 } : null);
      rx = []; core2 = fresh(); const y1 = await busR(core2); const ny = rx.length; const y2 = await busR(core2);
      idRes.push({ label, ok: y1.status === 200 && y1.body.complete === false && /노선 ID가 없거나 잘못된 행 1개/.test(y1.body.why || '') && y1.cache === 'no-store' && y2.body.complete === false && rx.length === ny * 2 });
    }
    ok('A14-S4 정상 노선 + 번호가 같은데 routeid가 누락·null·빈 값·공백·객체·기호인 행 → 불량 행만 조용히 빼지 않고 전체 complete=false · no-store · 서버 캐시 없음(재조회)',
      idRes.every((x) => x.ok), idRes.filter((x) => !x.ok).map((x) => x.label).join(', ') || '6가지 모두');
    hook = (op) => (op === 'getRouteNoList' ? { items: listRows([{}]), total: 1 } : null);
    core2 = fresh(); const yOnly = await busR(core2);
    hook = (op) => (op === 'getRouteNoList' ? { items: [...listRows([{ routeid: 'DJB30300043' }]), { routeno: '108-1' }], total: 2 } : op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: 50 } : null);
    core2 = fresh(); const yOther = await busR(core2);
    hook = null;
    ok('A14-S5 번호가 같은 행이 routeid 불량뿐 → \'노선 없음(정상 0건)\'이 아니라 불완전(complete=false) · 다른 번호(108-1)의 불량 행은 정확 일치 정책대로 무시(complete=true)',
      yOnly.status === 200 && yOnly.body.complete === false && yOnly.body.routes.length === 0 && yOther.body.complete === true && yOther.body.routes.length === 1, `${yOnly.body.complete} / ${yOther.body.complete}`);

    /* ===== update12 최종: routeid 문자열 'null'·'undefined' (A15-S) ===== */
    const badRids = [["'undefined'", { routeid: 'undefined' }], ["'null'", { routeid: 'null' }], ["'NULL'", { routeid: 'NULL' }], ["' null '", { routeid: ' null ' }], ["'Undefined'", { routeid: 'Undefined' }], ["'UNDEFINED '", { routeid: 'UNDEFINED ' }], ['null', { routeid: null }], ['누락', {}], ['배열', { routeid: ['DJB1'] }], ['객체', { routeid: { id: 'DJB1' } }]];
    const ridRes = [];
    for (const [label, row] of badRids) {
      hook = (op) => (op === 'getRouteNoList' ? { items: listRows([{ routeid: 'DJB30300043' }, row]), total: 2 } : op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: 50 } : null);
      rx = []; core2 = fresh(); const r1 = await busR(core2); const n1 = rx.length; const r2 = await busR(core2);
      ridRes.push({ label, ok: r1.status === 200 && r1.body.complete === false && /노선 ID가 없거나 잘못된 행 1개/.test(r1.body.why || '') && r1.cache === 'no-store' && r1.body.routes.every((x) => x.routeId === 'DJB30300043') && r2.body.complete === false && rx.length === n1 * 2 });
    }
    ok('A15-S1 조회 번호 행의 routeid가 문자열 \'undefined\'·\'null\'(대소문자·앞뒤 공백 변형 포함)·null·누락·배열·객체 → 정상 노선 ID로 보지 않고 전체 complete=false · no-store · 서버 캐시 없음(재조회)',
      ridRes.every((x) => x.ok), ridRes.filter((x) => !x.ok).map((x) => x.label).join(', ') || '10가지 모두');
    hook = (op) => (op === 'getRouteNoList' ? { items: listRows([{ routeid: 'DJB30300043' }, { routeid: 30300044 }]), total: 2 } : op === 'getRouteAcctoThrghSttnList' ? { items: rowsN(50), total: 50 } : null);
    rx = []; core2 = fresh(); const rOk = await busR(core2); const nOk = rx.length; const rOk2 = await busR(core2);
    ok('A15-S2 정상 TAGO 노선 ID(\'DJB30300043\' 문자열·숫자형 30300044) → complete=true · 서버 1일 캐시(두 번째 외부 0회) · CDN s-maxage 유지',
      rOk.status === 200 && rOk.body.complete === true && rOk.body.routes.map((x) => x.routeId).join() === 'DJB30300043,30300044' && /s-maxage=21600/.test(rOk.cache) && rx.length === nOk && rOk2.status === 200);
    hook = (op) => (op === 'getSttnAcctoArvlPrearngeInfoList' ? JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [{ routeno: 104, routeid: 'null', arrtime: 100 }, { routeno: 105, routeid: ' Undefined ', arrtime: 200 }, { routeno: 108, routeid: 'DJB30300043', arrtime: 300 }, { routeno: 109, arrtime: 400 }] } } } }) : null);
    core2 = fresh(); const ar = await run(core2, core2.arrivals, { cacheSec: 15 }, { nodeId: 'DJB8005589' }); hook = null;
    const arl = (ar.body.list || []).map((x) => `${x.routeNo}:${x.routeId || '-'}`).join(',');
    ok('A15-S3 도착정보의 routeid \'null\'·\' Undefined \'·누락은 빈 값으로(대조 불가) · 정상 노선 ID는 그대로', arl === '104:-,105:-,108:DJB30300043,109:-', arl);

    /* ===== update12: 대전교통공사 역간 소요시간/거리/요금 서버 래퍼 (S18 · 오퍼레이션 주소는 .env DJ_STNDIST_URL, 응답 항목은 그대로 전달) ===== */
    {
      const OP = 'https://apis.data.go.kr/B554695/TimeDistSVC/testOp';
      let dx = [], dmode = 'ok';
      const okXml = (a, b) => `<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items><item><strstnno>${a}</strstnno><endstnno>${b}</endstnno><distfloat>9.1</distfloat><fee>1400</fee><min>19</min><sec>0</sec></item></items></body></response>`;
      global.fetch = async (url) => {
        const u = new URL(String(url)); dx.push(u.pathname + '?' + u.searchParams.get('strstnno') + '-' + u.searchParams.get('endstnno'));
        await new Promise((r) => setTimeout(r, 5));
        const text = dmode === 'noop' ? '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>NO_OPENAPI_SERVICE_ERROR</errMsg><returnAuthMsg>해당 오픈API 서비스가 없거나 폐기됨</returnAuthMsg><returnReasonCode>12</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>'
          : dmode === 'code' ? '<response><header><resultCode>03</resultCode><resultMsg>NODATA_ERROR</resultMsg></header><body></body></response>'
          : dmode === 'empty' ? '<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items></items></body></response>'
          : okXml(u.searchParams.get('strstnno'), u.searchParams.get('endstnno'));
        return { ok: true, status: 200, text: async () => text };
      };
      const sd = (core, q, ip) => run(core, core.stationDist, { perMin: 30 }, q, ip);
      delete process.env.DJ_STNDIST_URL; process.env.MOCK = '0'; dx = []; let c18 = fresh();
      const noUrl = await sd(c18, { from: '114', to: '104' });
      const bad = await Promise.all([{ from: '114', to: '114' }, { from: '99', to: '104' }, { from: '123', to: '104' }, { from: '월평', to: '104' }, { from: '114;x', to: '104' }].map((q) => sd(c18, q)));
      process.env.DJ_STNDIST_URL = 'https://example.com/B554695/TimeDistSVC/x'; c18 = fresh(); const badHost = await sd(c18, { from: '114', to: '104' });
      ok('S18-01 역간 거리·요금: DJ_STNDIST_URL이 없으면 운영계정 승인 화면에서 확인한 공식 주소(TimeDistSVC/getTimeDist01) 사용 · 같은 역·범위 밖(99·123)·이름·기호는 400(외부 호출 없음) · 대전교통공사 주소가 아니면 501',
        noUrl.status === 200 && dx.length === 1 && dx[0] === '/B554695/TimeDistSVC/getTimeDist01?114-104' && bad.every((r) => r.status === 400) && badHost.status === 501, `${noUrl.status} · ${bad.map((r) => r.status).join(',')} · ${badHost.status} · 외부 ${dx.length}`);
      process.env.DJ_STNDIST_URL = OP + '?serviceKey=SHOULD_NOT_BE_USED&strstnno=1'; process.env.MOCK = '1'; c18 = fresh(); const mk = await sd(c18, { from: '114', to: '104' });
      process.env.MOCK = '0'; c18 = fresh(); dx = [];
      const r1 = await sd(c18, { from: '114', to: '104' }); const n1 = dx.length; const r2 = await sd(c18, { from: '114', to: '104' });
      ok('S18-02 MOCK=1이면 외부 호출 0 · 정상 응답: item 항목을 이름 그대로 전달(fields) · 요청은 주소의 기존 쿼리를 버리고 strstnno·endstnno만 · 역 쌍별 서버 캐시(두 번째 외부 0회) · 출처·조회 시각 기록 · CDN 저장 안 함',
        mk.status === 200 && mk.body.mock === true && n1 === 1 && dx[0] === '/B554695/TimeDistSVC/testOp?114-104' && r1.status === 200 && r1.body.complete === true && r1.body.items[0].distfloat === '9.1' && r1.body.fields.join() === 'strstnno,endstnno,distfloat,fee,min,sec' && !!r1.body.dist && r1.body.dist.km === 9.1
        && r1.body.source && r1.body.at > 0 && r1.cache === 'no-store' && r2.status === 200 && dx.length === 1 && !JSON.stringify(r1.body).includes('SHOULD_NOT'), `${dx.join(' ')} · ${r1.cache}`);
      dx = []; c18 = fresh();
      const [p1, p2, p3] = await Promise.all([sd(c18, { from: '115', to: '104' }, '2.2.2.2'), sd(c18, { from: '115', to: '104' }, '3.3.3.3'), sd(c18, { from: '117', to: '104' }, '4.4.4.4')]);
      ok('S18-03 같은 역 쌍 동시 요청은 외부 1번으로 합침 · 다른 역 쌍은 따로(합계 2번)', p1.status === 200 && p2.status === 200 && p3.status === 200 && dx.length === 2 && p3.body.items[0].strstnno === '117', dx.join(' '));
      const errs = [];
      for (const m of ['noop', 'code', 'empty']) {
        dmode = m; dx = []; c18 = fresh(); const e1 = await sd(c18, { from: '114', to: '104' }); const e2 = await sd(c18, { from: '114', to: '104' });
        errs.push({ m, ok: (m === 'empty' ? e1.status === 200 && e1.body.complete === false : e1.status === 502) && e1.cache === 'no-store' && dx.length === 2, info: `${m}:${e1.status}:${e1.body.error || e1.body.complete}` });
      }
      dmode = 'ok';
      ok('S18-04 오퍼레이션 없음(NO_OPENAPI_SERVICE_ERROR)·결과 코드 오류 → 502 · item 없음 → complete=false · 모두 캐시 안 함(다음 요청은 다시 조회)', errs.every((x) => x.ok), errs.map((x) => x.info).join(' / '));
      process.env.QUOTA_DJTC_DIST = '1'; dx = []; c18 = fresh();
      const q1 = await sd(c18, { from: '114', to: '104' }), q2 = await sd(c18, { from: '115', to: '104' });
      delete process.env.QUOTA_DJTC_DIST;
      ok('S18-05 하루 한도는 djtc_dist로 따로 셈(기본 100) · 한도 초과면 외부 호출 없이 429', c18._test.quotaFor(OP + '?a=1') === 'djtc_dist' && q1.status === 200 && q2.status === 429 && dx.length === 1, `${q1.status}/${q2.status} · 외부 ${dx.length}`);

      // 2026-11-20 실제 응답 구조: <response><header><resultCode>00</resultCode>…</header><body><item><distfloat>9.1</distfloat><fee>1400</fee><min>19</min><sec>0</sec></item></body></response>
      global.fetch = async () => ({ ok: true, status: 200, text: async () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><item><distfloat>9.1</distfloat><fee>1400</fee><min>19</min><sec>0</sec></item></body></response>' });
      c18 = fresh(); const real = await sd(c18, { from: '114', to: '104' });
      ok('S18-06 실제 응답 구조(items 감싸기 없이 item · distfloat·fee·min·sec) → 항목 그대로 전달 · complete', real.status === 200 && real.body.complete === true && real.body.fields.join() === 'distfloat,fee,min,sec' && real.body.items[0].distfloat === '9.1' && real.body.items[0].fee === '1400', JSON.stringify(real.body.items));

      /* ----- update12: 역간 거리 응답 검사 (A20-S) ----- */
      let xmlNow = '', fx = 0;
      global.fetch = async () => { fx++; return { ok: true, status: 200, text: async () => xmlNow }; };
      const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
      const X = ({ code = '<resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg>', items = null, item = '<distfloat>9.1</distfloat><fee>1400</fee><min>19</min><sec>0</sec>', wrap = false } = {}) => {
        const its = items != null ? items : `<item>${item}</item>`;
        return `${HEAD}<response><header>${code}</header><body>${wrap ? '<items>' + its + '</items>' : its}</body></response>`;
      };
      const twice = async (xml, q = { from: '114', to: '104' }) => { xmlNow = xml; fx = 0; const cc = fresh(); const a1 = await sd(cc, q); const a2 = await sd(cc, q); return { a1, a2, fx }; };
      const okReal = await twice(X()), okWrap = await twice(X({ wrap: true })), okEcho = await twice(X({ item: '<strstnno>114</strstnno><endstnno>104</endstnno><distfloat>9.1</distfloat><fee>1400</fee><min>19</min><sec>0</sec>' }));
      const okInt = await twice(X({ item: '<distfloat>12</distfloat><fee>1500</fee><min>25</min><sec>59</sec>' }), { from: '117', to: '104' });
      ok('A20-S1 정상 응답 유지: 실제 구조(body 바로 아래 item 1개)·items로 감싼 구조·요청과 같은 역번호가 있는 응답·정수 거리(12) → complete · 거리 정규화(km) · 서버 1일 캐시(두 번째 외부 0회)',
        [okReal, okWrap, okEcho, okInt].every((r) => r.a1.status === 200 && r.a1.body.complete === true && r.a1.body.dist && r.fx === 1 && r.a2.body.complete === true) && okReal.a1.body.dist.km === 9.1 && okInt.a1.body.dist.km === 12 && okInt.a1.body.dist.sec === 59,
        [okReal, okWrap, okEcho, okInt].map((r) => `${r.a1.status}/${r.a1.body.complete}/${r.fx}`).join(' '));
      // XML 형식·결과 코드 오류 → 502 · 캐시 안 함
      const bad502 = [];
      for (const [label, xml] of [['</response> 누락', X().replace('</response>', '')], ['</distfloat> 누락', X().replace('</distfloat>', '')], ['태그 짝 어긋남', X().replace('</min>', '</mn>')], ['XML 아님', 'distfloat=9.1'],
        ['resultCode 없음', X({ code: '<resultMsg>NORMAL SERVICE.</resultMsg>' })], ['resultCode 03', X({ code: '<resultCode>03</resultCode><resultMsg>NODATA_ERROR</resultMsg>' })], ['resultCode 빈 값', X({ code: '<resultCode></resultCode>' })]]) {
        const r = await twice(xml); bad502.push({ label, ok: r.a1.status === 502 && r.a1.cache === 'no-store' && r.fx === 2 });
      }
      ok('A20-S2 닫는 태그 누락·태그 짝 어긋남·XML 아님·resultCode 없음·실패 코드(03)·빈 코드 → 502 · no-store · 서버 캐시 안 함(같은 요청이면 다시 조회)', bad502.every((x) => x.ok), bad502.filter((x) => !x.ok).map((x) => x.label).join(', ') || '7가지 모두');
      // 형식은 맞지만 쓸 수 없는 값 → complete:false · 캐시 안 함
      const it = (d, m = '19', sc = '0', extra = '') => `${extra}${d === undefined ? '' : '<distfloat>' + d + '</distfloat>'}<fee>1400</fee><min>${m}</min><sec>${sc}</sec>`;
      const badInc = [];
      for (const [label, xml] of [['item 0개', X({ items: '' })], ['item 2개', X({ items: '<item>' + it('9.1') + '</item><item>' + it('14.3') + '</item>' })],
        ['distfloat 없음', X({ item: it(undefined) })], ['음수', X({ item: it('-9.1') })], ['0x0a', X({ item: it('0x0a') })], ['1.01e1', X({ item: it('1.01e1') })], ['NaN', X({ item: it('NaN') })], ['Infinity', X({ item: it('Infinity') })],
        ['빈 값', X({ item: it('') })], ['0', X({ item: it('0') })], ['99㎞', X({ item: it('99') })], ['.5', X({ item: it('.5') })], ['9.', X({ item: it('9.') })], ['공백 포함', X({ item: it('9 .1') })],
        ['min 문자', X({ item: it('9.1', 'abc') })], ['min 소수', X({ item: it('9.1', '1.5') })], ['sec 60', X({ item: it('9.1', '19', '60') })], ['sec 음수', X({ item: it('9.1', '19', '-1') })], ['sec 없음', X({ item: '<distfloat>9.1</distfloat><min>19</min>' })],
        ['출발역 불일치(119)', X({ item: it('14.3', '28', '40', '<strstnno>119</strstnno><endstnno>104</endstnno>') })], ['도착역 불일치', X({ item: it('9.1', '19', '0', '<strstnno>114</strstnno><endstnno>101</endstnno>') })],
        ['항목 중복', X({ item: it('9.1') + '<distfloat>14.3</distfloat>' })], ['항목 중첩', X({ item: '<distfloat><v>9.1</v></distfloat><min>19</min><sec>0</sec>' })]]) {
        const r = await twice(xml); badInc.push({ label, ok: r.a1.status === 200 && r.a1.body.complete === false && !!r.a1.body.why && r.a1.body.dist === null && r.a1.cache === 'no-store' && r.fx === 2 && r.a2.body.complete === false });
      }
      ok('A20-S3 item 0·2개, distfloat 없음·음수·0x0a·1.01e1·NaN·Infinity·빈 값·0·99㎞·.5·9.·공백, min·sec 이상(문자·소수·60·음수·없음), 응답 역번호 불일치(119→104·114→101), 항목 중복·중첩 → complete:false(이유 표시) · 캐시 안 함',
        badInc.every((x) => x.ok), badInc.filter((x) => !x.ok).map((x) => x.label).join(', ') || `${badInc.length}가지 모두`);
      // 잘못된 응답 뒤 정상 응답 → 복구 · 그 뒤는 캐시
      fx = 0; const cr = fresh(); xmlNow = X({ item: it('0x0a') }); const rb = await sd(cr, { from: '114', to: '104' }); xmlNow = X(); const rg = await sd(cr, { from: '114', to: '104' }); const rg2 = await sd(cr, { from: '114', to: '104' });
      ok('A20-S4 잘못된 응답은 저장되지 않아 다음 요청에서 다시 조회 → 정상 응답으로 복구 · 그 뒤부터 정상 캐시', rb.body.complete === false && rg.body.complete === true && rg2.body.complete === true && fx === 2, `${rb.body.complete} → ${rg.body.complete} → ${rg2.body.complete} · 외부 ${fx}`);

      /* ----- update12: resultCode 중첩 태그 · min/sec 숫자 변환 경계 (A21-S) ----- */
      const BIG = '9'.repeat(309), UNSAFE = '9007199254740993';
      const nest = [];
      for (const [label, code] of [['00 뒤 중첩 태그', '<resultCode>00<unexpected>03</unexpected></resultCode>'], ['중첩 태그 속 00', '<resultCode><x>00</x></resultCode>'], ['0 + 중첩 0', '<resultCode>0<b>0</b></resultCode>'], ['빈 중첩', '<resultCode>00<x></x></resultCode>']]) {
        const r = await twice(X({ code: code + '<resultMsg>NORMAL SERVICE.</resultMsg>' })); nest.push({ label, ok: r.a1.status === 502 && r.a1.cache === 'no-store' && r.fx === 2 });
      }
      const n00 = await twice(X());
      ok('A21-S1 resultCode는 하위 요소 없는 텍스트 00만 성공: 00 뒤 중첩 태그(<unexpected>03)·중첩 태그 속 00·나뉜 0+0·빈 중첩 → 502 · no-store · 캐시 안 함 · 정상 00은 그대로 성공·캐시',
        nest.every((x) => x.ok) && n00.a1.body.complete === true && n00.fx === 1, nest.filter((x) => !x.ok).map((x) => x.label).join(', ') || '4가지 모두 거부 · 정상 유지');
      const mm = [];
      for (const [label, m, sc] of [['min 309자리', BIG, '0'], ['sec 309자리', '19', BIG], ['min 안전 정수 초과', UNSAFE, '0'], ['sec 안전 정수 초과', '19', UNSAFE], ['min 61', '61', '0'], ['min 400자리(Infinity)', '1'.repeat(400), '0']]) {
        const r = await twice(X({ item: `<distfloat>9.1</distfloat><fee>1400</fee><min>${m}</min><sec>${sc}</sec>` })); mm.push({ label, ok: r.a1.status === 200 && r.a1.body.complete === false && /소요시간/.test(r.a1.body.why || '') && r.a1.body.dist === null && r.a1.cache === 'no-store' && r.fx === 2 });
      }
      const goodMs = [];
      for (const [d, m, sc] of [['9.1', '19', '0'], ['10.1', '21', '0'], ['12.4', '25', '0'], ['14.3', '28', '40'], ['9.1', '0', '59'], ['9.1', '60', '0']]) {
        const r = await twice(X({ item: `<distfloat>${d}</distfloat><fee>1500</fee><min>${m}</min><sec>${sc}</sec>` })); goodMs.push(r.a1.body.complete === true && r.a1.body.dist.min === Number(m) && r.a1.body.dist.sec === Number(sc) && r.fx === 1);
      }
      ok('A21-S2 min·sec: 309자리·400자리(Infinity)·안전 정수 초과(9007199254740993)·min 61 → 응답 전체 complete:false(null로 바꿔 통과시키지 않음) · 캐시 안 함 · 정상 19·21·25·28분/0·40초·경계 0분59초·60분은 그대로 정상·캐시',
        mm.every((x) => x.ok) && goodMs.every(Boolean), (mm.filter((x) => !x.ok).map((x) => x.label).join(', ') || '6가지 모두 거부') + ' · 정상 ' + goodMs.join(','));
      fx = 0; const cr2 = fresh(); xmlNow = X({ item: `<distfloat>9.1</distfloat><fee>1400</fee><min>${BIG}</min><sec>0</sec>` }); const rb2 = await sd(cr2, { from: '114', to: '104' });
      xmlNow = X({ code: '<resultCode>00<unexpected>03</unexpected></resultCode>' }); const rb3 = await sd(cr2, { from: '114', to: '104' });
      xmlNow = X(); const rg3 = await sd(cr2, { from: '114', to: '104' }); const rg4 = await sd(cr2, { from: '114', to: '104' });
      ok('A21-S3 불량 응답(309자리 min → resultCode 중첩) 뒤 같은 역 쌍을 다시 요청하면 매번 외부 재조회 → 정상 응답으로 복구 · 그 뒤 정상 캐시', rb2.body.complete === false && rb3.status === 502 && rg3.body.complete === true && rg4.body.complete === true && fx === 3, `외부 ${fx}`);
      delete process.env.DJ_STNDIST_URL;
    }
    delete process.env.QUOTA_KAKAO_TRANSIT;
  }

  /* ===== update13: Vercel Hobby 서버 함수 12개 제한 → api/ 함수 1개로 통합 (U13) ===== */
  {
    const fs = require('fs');
    const fnFiles = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => /\.(c|m)?js$/.test(f) && !f.startsWith('_'));
    ok('U13-01 api/ 서버 함수 파일 수 ≤ 12 (Hobby 제한) — 지금 1개', fnFiles.length <= 12 && fnFiles.length === 1, fnFiles.join(','));
    for (const k of Object.keys(require.cache)) if (k.includes('cnu-route-web')) delete require.cache[k];
    process.env.MOCK = '1';
    const routes = require(path.join(ROOT, 'lib/routes.js')), disp = require(path.join(ROOT, 'api/[name].js'));
    const used = new Set();
    for (const f of ['public/app.js', 'public/health.html']) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/['"`]\/api\/([a-z-]+)/g)) used.add(m[1]);
    const missing = [...used].filter((n) => !Object.prototype.hasOwnProperty.call(routes, n));
    ok('U13-02 화면·점검 페이지가 부르는 /api/* 이름이 모두 경로 표에 있음', used.size >= 10 && missing.length === 0, `사용 ${used.size}개 · 없음 ${missing.join(',')}`);
    ok('U13-03 경로 표 15개 (기존 api 파일과 같은 이름)', ['stops', 'arrivals', 'arrivals-dj', 'busroute', 'subway', 'stdist', 'drive', 'search', 'stations', 'transit', 'walk', 'bike', 'tashu', 'config', 'health'].every((n) => typeof routes[n] === 'function') && Object.keys(routes).length === 15);
    const call = (url, query) => new Promise((r) => { const req = { url, query, headers: { 'x-forwarded-for': '8.8.8.8' } }; const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { r({ status: this.statusCode || 200, body: JSON.parse(b), req }); } }; disp(req, res); });
    let c = await call('/api/config?x=1', { name: 'config', x: '1' });
    ok('U13-04 /api/config → config 처리, Vercel이 넣은 name 파라미터는 지움', c.status === 200 && c.body.mock === true && !('name' in c.req.query) && c.req.query.x === '1', JSON.stringify(c.req.query));
    c = await call('/api/config/', {});
    ok('U13-05 끝에 / 가 붙어도 같은 API', c.status === 200 && c.body.mock === true);
    c = await call('/api/__proto__', { name: '__proto__' });
    const c2 = await call('/api/nope', { name: 'nope' });
    ok('U13-06 없는 이름·__proto__ → 404 (객체 기본 속성으로 새지 않음)', c.status === 404 && c2.status === 404);
    // 로컬 server.js도 같은 표 사용
    const { spawn } = require('child_process'), http = require('http');
    const port = 30000 + Math.floor(Math.random() * 20000);
    const sv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), MOCK: '1', DATA_GO_KR_KEY: '' }, cwd: '/' });
    await new Promise((r) => { sv.stdout.on('data', r); setTimeout(r, 3000); });
    const get = (u) => new Promise((r) => http.get(`http://127.0.0.1:${port}${u}`, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => r({ status: res.statusCode, b })); }).on('error', () => r({ status: 0 })));
    const g1 = await get('/api/config'), g2 = await get('/api/nope'), g3 = await get('/');
    sv.kill();
    ok('U13-07 로컬 server.js: /api/config 200 · 없는 API 404 · 화면 200', g1.status === 200 && JSON.parse(g1.b).mock === true && g2.status === 404 && g3.status === 200, `${g1.status}/${g2.status}/${g3.status}`);
  }

  /* ===== update14 1단계: 지도 표시용 경로 좌표 (서버 응답에 path 추가 · 화면 변경 없음) (S14) ===== */
  {
    for (const k of Object.keys(require.cache)) if (k.includes('cnu-route-web')) delete require.cache[k];
    Object.assign(process.env, { MOCK: '0', KAKAO_REST_KEY: 'fake' });
    const C = require(path.join(ROOT, 'lib/core.js')), T14 = C._test;
    // 직선 위 100점 + 꺾이는 점 → 양 끝과 꺾이는 점만 남음
    const line = []; for (let i = 0; i <= 100; i++) line.push([127.34 + i * 0.0001, 36.36]);
    for (let i = 1; i <= 50; i++) line.push([127.35, 36.36 + i * 0.0001]);
    const sp = T14.simplifyPath(line, 60);
    ok('S14-01 직선 구간은 점 생략: 151점 → 꺾이는 점 포함 3점, [위도,경도] 순서', sp.length === 3 && sp[0][0] === 36.36 && sp[0][1] === 127.34 && sp[1][0] === 36.36 && sp[1][1] === 127.35 && sp[2][0] === 36.365, JSON.stringify(sp));
    const zig = []; for (let i = 0; i < 500; i++) zig.push([127.30 + i * 0.0002, 36.30 + (i % 2) * 0.001]);
    const sz = T14.simplifyPath(zig, 60);
    ok('S14-02 점이 많으면 상한(60)까지 고르게 솎고 양 끝 유지', sz.length === 60 && sz[0][1] === 127.3 && sz[59][1] === Math.round((127.30 + 499 * 0.0002) * 1e5) / 1e5, sz.length);
    const bad = T14.simplifyPath([[127.34, 36.36], null, ['x', 1], [0, 0], [127.34, 36.36], [200, 36], [127.35, 36.37], '12'], 60);
    ok('S14-03 비정상 좌표(null·문자·0,0·범위 밖)·연속 중복은 버림', JSON.stringify(bad) === JSON.stringify([[36.36, 127.34], [36.37, 127.35]]), JSON.stringify(bad));
    ok('S14-04 점이 2개 미만·배열 아님 → null', T14.simplifyPath([[127.34, 36.36]], 60) === null && T14.simplifyPath(null, 60) === null && T14.simplifyPath('abc', 60) === null && T14.simplifyPath([[127.34, 36.36], [127.34, 36.36]], 60) === null);
    const r5 = T14.simplifyPath([[127.123456789, 36.987654321], [127.2, 36.9]], 60);
    ok('S14-05 소수 5자리 반올림 (약 1m)', r5[0][0] === 36.98765 && r5[0][1] === 127.12346, JSON.stringify(r5));
    // 택시: sections[].roads[].vertexes
    const dp = T14.drivePath({ sections: [{ roads: [{ vertexes: [127.34, 36.36, 127.345, 36.36] }, { vertexes: [127.345, 36.36, 127.35, 36.365, 'x'] }, { vertexes: null }] }, null] });
    ok('S14-06 택시 경로: vertexes(경도,위도 번갈아) → [위도,경도], 홀수·null 무시', Array.isArray(dp) && dp.length === 3 && dp[0][0] === 36.36 && dp[2][1] === 127.35, JSON.stringify(dp));
    ok('S14-07 택시 경로 없음 → null', T14.drivePath({}) === null && T14.drivePath(null) === null && T14.drivePath({ sections: [{ roads: [{}] }] }) === null);
    // 도보·자전거: route.legs[].steps[].path.points
    const lj = { status: 'OK', route: { properties: { totalTime: 300, totalDistance: 400 }, legs: [{ steps: [{ path: { points: [[127.34, 36.36], [127.341, 36.36]] } }, { path: { points: [[127.341, 36.36], [127.341, 36.362]] } }, { path: null }] }] } };
    const lg = T14.parseLeg(lj);
    ok('S14-08 도보·자전거 응답에 path 추가 (구간 이어 붙임 · 중복 제거) · sec·m 그대로', lg.sec === 300 && lg.m === 400 && Array.isArray(lg.path) && lg.path.length === 3, JSON.stringify(lg));
    const lg0 = T14.parseLeg({ route: { properties: { totalTime: 60, totalDistance: 50 } } });
    ok('S14-09 도보·자전거 좌표 없음 → path null, 시간·거리는 정상', lg0.path === null && lg0.sec === 60 && lg0.m === 50);
    // 대중교통: steps[].path
    const tj = { status: 'OK', routes: [{ properties: { type: 'BUS', totalTime: 900, totalDistance: 3000, transfers: 0, fare: { value: 1500 } }, steps: [
      { properties: { type: 'WALKING', time: 120, distance: 100, stops: [], vehicles: [] }, path: { points: [[127.346, 36.365], [127.3455, 36.3652]] } },
      { properties: { type: 'BUS', time: 600, distance: 2800, stops: [{ name: 'A' }, { name: 'B' }], vehicles: [{ name: '108', type: '일반' }] }, path: { points: line } },
      { properties: { type: 'WALKING', time: 60, distance: 50, stops: [], vehicles: [] } }] }] };
    const tr = T14.parseTransit(tj)[0];
    ok('S14-10 대중교통 구간별 path (버스 151점 → 3점), 좌표 없는 구간은 null · 기존 start/end 유지', tr.steps[0].path.length === 2 && tr.steps[1].path.length === 3 && tr.steps[2].path === null && tr.steps[1].start.lat === 36.36 && tr.steps[1].end.lng === 127.35, tr.steps.map((x) => x.path && x.path.length).join('/'));
    // 서버 함수 경유: drive 응답에 path 포함
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ routes: [{ result_code: 0, summary: { duration: 600, distance: 5000, fare: { taxi: 7000 } }, sections: [{ roads: [{ vertexes: [127.34, 36.36, 127.36, 36.35, 127.38, 36.34] }] }] }] }) });
    const dv = await C.drive({ olat: '36.36', olng: '127.34', dlat: '36.34', dlng: '127.38' });
    ok('S14-11 /api/drive 응답에 path 포함 · 시간·요금 그대로', dv.durationSec === 600 && dv.taxiFare === 7000 && Array.isArray(dv.path) && dv.path.length >= 2, JSON.stringify(dv.path));
    // 크기: 대중교통 15경로 × 3구간 × 상한 60점이어도 응답이 과하게 커지지 않음
    const many = { status: 'OK', routes: Array.from({ length: 15 }, () => ({ properties: { type: 'BUS', totalTime: 900, totalDistance: 3000, transfers: 0, fare: { value: 1500 } }, steps: [0, 1, 2].map((k) => ({ properties: { type: k === 1 ? 'BUS' : 'WALKING', time: 300, distance: 1000, stops: k === 1 ? [{ name: 'A' }, { name: 'B' }] : [], vehicles: k === 1 ? [{ name: '1', type: '일반' }] : [] }, path: { points: zig } })) })) };
    const bytes = JSON.stringify(T14.parseTransit(many)).length;
    ok('S14-12 최악의 경우(15경로·구간마다 60점) 대중교통 응답 크기 70KB 이하', bytes < 70000, `${Math.round(bytes / 1024)}KB`);
    process.env.MOCK = '1';
  }

  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
