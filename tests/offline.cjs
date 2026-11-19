// 오프라인 검증: 실제 외부 API를 부르지 않습니다 (모의 fetch만 사용). 실행: node tests/offline.cjs
// update10: U10/S10 항목(출발지 확대·카카오 대중교통/도보/자전거 길찾기) + R10 항목(독립 감사 회귀) 추가
process.env.TZ = 'Asia/Seoul';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', 'cnu-route-web');
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✅' : '❌'} ${name}${info ? ' — ' + info : ''}`); };

/* ---------- 화면 코드(app.js)를 격리 실행 ---------- */
function loadApp({ fetchImpl, now }) {
  const el = () => ({ textContent: '', hidden: false, value: '', classList: { toggle() {} }, setAttribute() {}, replaceChildren() {}, append() {}, addEventListener() {}, remove() {} });
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [FakeDate.now()])); } static now() { return now.t; } }
  const ctx = { window: {}, document: { querySelector: el, createElement: el, createTextNode: (t) => t, visibilityState: 'visible', head: el() },
    location: { hostname: 'test' }, navigator: {}, console, URLSearchParams, setInterval() {}, setTimeout, Date: FakeDate, fetch: fetchImpl, Math, Number, Object, Promise, Set, Map, JSON, String, Array };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/scenario.js'), 'utf8'), ctx);
  let src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  src = src.replace(/\nstart\(\);\n\}\)\(\);\s*$/, '\nwindow.__T = { st, SC, computeRoutes, pickBest, loadStops, loadArrivals, loadDrives, setPoint, search, selectOrigin, stationNum, loadSubway, loadTransit, tashuFee };\n})();');
  vm.runInContext(src, ctx);
  return ctx.window.__T;
}
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
    else if (p === '/api/arrivals') body = { list: [{ routeNo: '108', arrSec: 600, prevCnt: 4 }], at: now.t };
    else if (p === '/api/arrivals-dj') body = { list: [], at: now.t };
    else if (p === '/api/tashu') body = { mock: false, stations: [{ name: '충남대 공대', d: 120, bikes: o.bikes ?? 5, lat: 36.366, lng: 127.346 }] };
    else if (p === '/api/drive') body = { durationSec: 1500, distanceM: 11000, taxiFare: 13000 };
    else if (p === '/api/subway') body = timetable(o.lastHour || 23);
    else if (p === '/api/search') body = { places: [{ name: '대전역', address: '', lat: 36.3324, lng: 127.4343 }] };
    return { ok: !fail, status: fail ? 503 : 200, json: async () => (fail ? { error: '조회 실패' } : body) };
  };
  const T = loadApp({ fetchImpl, now });
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
    const by = Object.fromEntries(list.map((r) => [r.key, r]));
    return { w, list, best, by };
  }
  let s = await scenario({});
  ok('M01-01 정상: 추천은 D, 전 경로 이용 가능 확인', s.best && s.best.key === 'D' && ['A', 'B', 'D', 'E'].every((k) => s.by[k].avail === 'ok'), `A ${Math.round(s.by.A.total)}분 / D ${Math.round(s.by.D.total)}분`);
  s = await scenario({ bikes: 0 });
  ok('M01-02 타슈 0대: D·C는 이용 불가, 추천에서 제외', s.by.D.avail === 'no' && s.by.C.avail === 'no' && s.best && s.best.key === 'A', `D: ${s.by.D.why.join(',')} / 추천 ${s.best && s.best.key}`);
  s = await scenario({ now: KST(23, 50), lastHour: 22 });
  ok('M01-03 막차 이후: 지하철 포함 A·D·E 이용 불가, 추천 없음', ['A', 'D', 'E'].every((k) => s.by[k].avail === 'no') && s.best === null, `B는 ${s.by.B.avail}(요금 초과로 추천 제외)`);
  s = await scenario({ fail: ['/api/arrivals', '/api/arrivals-dj', '/api/tashu', '/api/drive', '/api/subway'] });
  ok('M01-04 실시간 조회 전부 실패: 모두 가정값 포함, 추천 없음', s.list.every((r) => r.avail === 'unknown') && s.best === null, s.by.D.why.join(' / '));
  s = await scenario({ fail: ['/api/drive'] });
  ok('M01-10 택시 조회만 실패: B·E만 가정값 포함, D 추천 유지', s.by.B.avail === 'unknown' && s.by.E.avail === 'unknown' && s.best.key === 'D');
  s = await scenario({ fail: ['/api/tashu'] });
  ok('타슈 조회 실패(0대와 구별): D는 미확인 → 추천 안 함', s.by.D.avail === 'unknown' && s.by.D.why[0].includes('미확인') && s.best.key === 'A');

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
  const stopsHandler = require(path.join(ROOT, 'api/stops.js')), tashuHandler = require(path.join(ROOT, 'api/tashu.js'));
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
    const arrivals = (u, now) => ({ at: now.t, list: u.includes('DJB_X') ? [{ routeNo: '104', arrSec: 600, prevCnt: 3 }] : [{ routeNo: '104', arrSec: 300, prevCnt: 1 }] });   // 반대편(DJB_Y)이 더 빨리 와도 쓰면 안 됨
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
      return { w, by: Object.fromEntries(list.map((r) => [r.key, r])), best: w.T.pickBest(list) };
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    ok('U10-01 1호선 역번호: 괄호·"역" 표기 차이를 맞춤', w.T.stationNum('월평(한국과학기술원)') === '114' && w.T.stationNum('대전역') === '104' && w.T.stationNum('갑천역') === '115');

    let u = await setup();
    const A = u.by.A, aw = A.steps.find((x) => x.type === 'wait');
    ok('U10-02 대중교통 길찾기로 A 구성: 104번 → 갑천역 (108번·월평역 강제 안 함)', A.avail === 'ok' && /104번/.test(A.sub) && /갑천역/.test(A.sub) && !/108/.test(A.sub), A.sub);
    ok('U10-03 같은 이름 반대편 정류장 제외: 경로 좌표에 가까운 정류장의 실시간만 사용', u.w.T.st.plan.stop.id === 'DJB_X' && Math.round(aw.min) === 7, `대기 ${aw.min}분 (도착 10분 - 도보 3분)`);
    ok('U10-04 대기 중복 없음: 카카오 전체 소요(totalTime) 미사용 · 구간 시간 + 자체 대기만', Math.round(A.total) === 52, `A ${Math.round(A.total)}분 = 도보3+대기7+버스10+도보2+역내3+열차대기5+지하철21(시각표)+도보1`);
    ok('U10-05 환승역 따라 시각표·택시·D/E 변경', u.w.calls.urls.some((x) => x.includes('/api/subway?from=115&to=104')) && /갑천역/.test(u.by.D.sub) && /갑천역/.test(u.by.E.sub)
      && u.w.calls.urls.some((x) => x.includes('/api/drive') && x.includes('dlat=36.361')));
    // 감사-6: 지하철 하차 후 이동 구간 (D·E도 카카오 경로의 하차 후 도보 1분 포함)
    const lastD = u.by.D.steps[u.by.D.steps.length - 1], lastE = u.by.E.steps[u.by.E.steps.length - 1];
    ok('R10-06 지하철 하차 후 목적지까지 이동 구간: A·D·E 모두 포함', [lastD, lastE, A.steps[A.steps.length - 1]].every((x) => x.type === 'walk' && Math.round(x.min) === 1 && /대전역까지 도보/.test(x.label)), `${lastD.label} ${lastD.min}분`);
    ok('R10-13a 같은 역 구간은 A·D·E에 같은 지하철 승차시간', [A, u.by.D, u.by.E].every((r) => r.steps.find((x) => x.type === 'sub').min === 21));

    u = await setup({ stopName: '궁동 사거리' });
    ok('U10-06 정류장 이름 불일치: 연결하지 않고 A는 가정값 포함', u.w.T.st.plan.stop === null && u.by.A.avail === 'unknown' && u.by.A.why.some((x) => x.includes('연결')) && u.w.calls['/api/stops'] === 2, u.by.A.why.join(' / '));

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
    let r2 = w2.T.computeRoutes().list.find((r) => r.key === 'A');
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
    const bn = w2.T.st.plan && w2.T.st.plan.route.steps.find((x) => x.type === 'BUS').vehicles[0].name;
    ok('R10-02 목적지 변경 후 이전 경로 응답 도착: 버리고 새 목적지 경로만 적용', bn === '105', `적용된 노선 ${bn}`);

    w2 = world({ cfg: { route: true }, delayOf: (x) => (x.includes('/api/subway?from=114') ? 60 : 3),
      api: { '/api/subway': (x) => { const t = timetable(23); t.days[0][0] = { ...t.days[0][0], ride: x.includes('from=114') ? 19 : 21 }; return t; }, '/api/transit': () => tr(), '/api/stops': () => stops, '/api/arrivals': arrivals } });
    w2.T.st.presetPos.haksa = { ...P }; w2.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; w2.T.st.originKey = 'haksa';
    const old = w2.T.loadSubway();                     // 환승역 미정(기본 월평 114) 상태에서 요청 → 늦게 도착
    await w2.T.loadTransit(); await w2.T.loadSubway(); await old; await sleep(20);
    ok('R10-03 이전 환승역 시각표 응답 도착: 현재 환승역(갑천 115) 시각표만 적용', w2.T.st.subwayKey === '115-104' && w2.T.st.subway.days[0][0].ride === 21, `${w2.T.st.subwayKey}`);

    // 환승역이 바뀌었는데 새 시각표가 아직 없을 때: 이전 환승역(월평) 시각표를 갑천역에 적용하지 않음
    w2 = world({ cfg: { route: true }, api: { '/api/transit': () => tr(), '/api/stops': () => stops, '/api/arrivals': arrivals } });
    w2.T.st.presetPos.haksa = { ...P }; w2.T.st.origin = { key: 'haksa', name: 'x', lat: P.lat, lng: P.lng, verified: true }; w2.T.st.originKey = 'haksa';
    w2.T.SC.bus.verifiedStops['104'] = ['DJB_X'];
    await w2.T.loadSubway(); const k114 = w2.T.st.subwayKey; await w2.T.loadTransit();
    const rr = w2.T.computeRoutes().list.find((r) => r.key === 'A');
    ok('R10-03b 새 환승역 시각표가 없으면 이전 역 시각표를 쓰지 않음(간격 가정 · 미확인)', k114 === '114-104' && rr.why.some((x) => x.includes('시각표 없음')), rr.why.join(' / '));

    // 2) 정류장·방향
    w2 = world({}); w2.T.st.subway = timetable(23); await w2.T.loadStops();
    w2.T.st.stops.push({ id: 'ars49999', arsId: '49999', no: '49999', name: '지정 안 된 정류장', lat: 36.3653, lng: 127.3466, fixed: true, d: 30 });
    w2.T.st.arr['ars49999'] = { at: w2.now.t, list: [{ routeNo: '108', arrSec: 240, prevCnt: 1 }] };
    let rA = w2.T.computeRoutes();
    ok('R10-04 명시적 정류장 제한 우회 방지: fixed 정류장도 지정 목록 밖이면 사용 안 함', rA.bus && rA.bus.stop.id !== 'ars49999', rA.bus && rA.bus.stop.id);

    const stopsLR = { stops: [{ id: 'DJB_R', no: '1', name: '궁동네거리', lat: BUS0.lat - 0.00008, lng: BUS0.lng + 0.0002 },     // 진행(동쪽) 오른쪽 = 남쪽
      { id: 'DJB_L', no: '2', name: '궁동네거리', lat: BUS0.lat + 0.00005, lng: BUS0.lng }] };                                  // 왼쪽(북쪽)이지만 더 가까움
    u = await setup({ noVerified: true, stops: stopsLR, arrivals: (x, now) => ({ at: now.t, list: [{ routeNo: '104', arrSec: 600, prevCnt: 3 }] }) });
    ok('R10-05 동일 이름 반대 방향 정류장: 진행 방향 오른쪽 정류장 선택 · 방향 미확인이라 추천 제외', u.w.T.st.plan.stop.id === 'DJB_R' && u.w.T.st.plan.stop.dir === 'geometry' && u.by.A.avail === 'unknown' && u.by.A.why.some((x) => x.includes('방향')), u.by.A.why.join(' / '));

    // 3) 경로별 시간 계산
    u = await setup({ steps: [
      { type: 'WALKING', sec: 300, m: 350, stops: [], vehicles: [], start: P, end: HUB }, sub({}),
      { type: 'WALKING', sec: 120, m: 100, stops: [], vehicles: [], start: null, end: null },
      { type: 'BUS', sec: 420, m: 2000, stops: ['대전역', '대동'], vehicles: [{ name: '601', type: '간선' }], start: { lat: 36.3324, lng: 127.4343 }, end: null },
      { type: 'WALKING', sec: 60, m: 50, stops: [], vehicles: [], start: null, end: null }] });
    const sA = u.by.A.steps, iSub = sA.findIndex((x) => x.type === 'sub'), iBw = sA.findIndex((x, i) => i > iSub && x.type === 'wait');
    ok('R10-07 지하철 이후 버스: 앞선 이동·대기 뒤에 이어서 계산 · 실시간 대신 환승 대기 가정(미확인)', u.w.T.st.plan.board === null && iBw > iSub && sA[iBw].start >= sA[iSub].end && u.by.A.avail === 'unknown' && u.by.A.why.some((x) => x.includes('환승 버스')), u.by.A.why.join(' / '));

    // 4) 버스 대기시간
    u = await setup({ walk0: 1800, arrivals: (x, now) => ({ at: now.t, list: [{ routeNo: '104', arrSec: 120, prevCnt: 1 }] }) });
    const bw = u.by.A.steps.find((x) => x.type === 'wait');
    ok('R10-08 음수 버스 대기 방지: 놓친 뒤 가정 차는 정류장 도착(+여유) 이후 · 0으로 자르지 않음', bw.min >= 1 && Math.round(bw.min) === 2 && u.w.T.st.plan && u.by.A.why.some((x) => x.includes('가정')), `대기 ${bw.min}분 (기존식이면 2+15-30=-13분)`);
    w2 = world({ api: { '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '108', arrSec: 60, prevCnt: 1 }, { routeNo: '108', arrSec: 1200, prevCnt: 9 }] }) } });
    w2.T.st.subway = timetable(23); await w2.T.loadStops(); rA = w2.T.computeRoutes();
    const rAA = rA.list.find((r) => r.key === 'A');
    ok('R10-09 복수 버스 도착정보: 놓치는 첫 차 대신 실제로 탈 수 있는 뒤차(실시간) 사용', rA.bus.source === 'live' && rA.bus.later && Math.round(rA.bus.wait) === 17 && rAA.avail === 'ok', `대기 ${rA.bus.wait}분`);

    // 5) 신뢰도·요금
    u = await setup({ unverified: true });
    ok('R10-10a 미확인 출발지 좌표: 모든 경로 가정값 포함 · 추천 없음', Object.values(u.by).every((r) => r.avail !== 'ok') && u.best === null && u.by.A.why.includes('출발지 좌표 미확인'));
    u = await setup({ fare: 1650 });
    // (정책 변경 반영) 이전: '예산 1,550원 고정 → 2구간 D 추천 제외' → 지금: 기준은 A 실제 요금(1,650원), 고정 예산 없음
    ok('R10-11 실제 경로 요금 표시: A 1,650원(카카오) · 2구간 D 1,650원 · 고정 예산 없음 · 추천은 A 요금 이하만', u.by.A.fare === 1650 && u.w.T.SC.fare.budget === undefined && u.by.D.fare === 1650 && (!u.best || u.best.fare <= u.by.A.fare), `A ${u.by.A.fare} · D ${u.by.D.fare} · 추천 ${u.best && u.best.key}`);
    w2 = world({ zone: false }); w2.T.st.subway = timetable(23); await w2.T.loadStops();
    let lz = w2.T.computeRoutes().list, bz = w2.T.pickBest(lz), Az = lz.find((r) => r.key === 'A');
    ok('R10-11b 요금 구간 미확인: A 요금 미확인(1,550원 고정 표시 안 함) · D·E 추천 제외', Az.fare === null && Az.avail === 'unknown' && lz.find((r) => r.key === 'D').avail === 'unknown' && bz === null, Az.why.join(' / '));
    const f1 = w2.T.tashuFee(60), f2 = w2.T.tashuFee(72), f3 = w2.T.tashuFee(700);
    u = await setup({ api: { '/api/walk': () => ({ sec: 240, m: 300 }), '/api/bike': (x) => (x.includes('dlat=36.33') ? { sec: 4200, m: 15000 } : { sec: 600, m: 2500 }), '/api/tashu': tashuT1 } });
    ok('R10-12 타슈 1시간 초과: 60분 0원 · 72분 500원(올림 가정 → 미확인) · 최대 5,000원 · C 요금 반영', f1.fare === 0 && f1.ok && f2.fare === 500 && !f2.ok && f3.fare === 5000 && u.by.C.fare === 500 && u.by.C.avail === 'unknown', `C ${u.by.C.fare}원 · ${u.by.C.why.join(' / ')}`);

    // 6) 지하철 역별 소요시간
    const noRide = () => { const t = timetable(23), set = { from: t.days[0][0].from, ride: null }; return { mock: false, days: { 0: { 0: set, 1: set }, 1: { 0: set, 1: set } } }; };
    u = await setup({ tt: noRide });
    const subMins = [u.by.A, u.by.D, u.by.E].map((r) => r.steps.find((x) => x.type === 'sub').min);
    ok('R10-13 지하철 역별 소요: 시각표 소요가 없으면 19분 일괄 적용 대신 그 구간 값(카카오 25분) · 미확인', subMins.every((m) => m === 25) && u.by.A.why.some((x) => x.includes('시각표 없음')), subMins.join('/'));
    w2 = world({ api: { '/api/subway': noRide } }); w2.T.st.subway = null; await w2.T.loadStops();
    const lr = w2.T.computeRoutes().list.find((r) => r.key === 'A');
    ok('R10-13b 월평→대전역은 확인된 19분 사용(가정 아님)', lr.steps.find((x) => x.type === 'sub').min === 19 && lr.avail === 'ok');

    // 7) null·음수 응답
    u = await setup({ steps: tr().routes[0].steps.map((s, i) => (i === 1 ? { ...s, sec: -5 } : s)) });
    ok('R10-16a 음수 구간 시간 대중교통 응답은 정상으로 쓰지 않음', u.w.T.st.plan === null && u.by.A.why.some((x) => x.includes('실패')));
    u = await setup({ api: { '/api/walk': () => ({ sec: null, m: 300 }), '/api/bike': () => ({ sec: -1, m: 10 }), '/api/drive': () => ({ durationSec: -60, distanceM: 1000, taxiFare: 5000 }),
      '/api/tashu': () => ({ mock: false, stations: [{ id: 'T0', name: '빈값', d: 50, bikes: null, lat: P.lat, lng: P.lng }, { id: 'T1', name: '출발대여소', d: 120, bikes: 5, lat: P.lat + 0.001, lng: P.lng }] }),
      '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '104', arrSec: -30, prevCnt: 1 }, { routeNo: '104', arrSec: null, prevCnt: 1 }] }) } });
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
      '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '48', arrSec: 240, prevCnt: 1 }, { routeNo: '102', arrSec: 600, prevCnt: 3 }] }),
      '/api/walk': (x) => (x.includes('dlat=36.3632') ? { sec: 300, m: 320 } : { sec: 120, m: 100 }), '/api/subway': nullTT } });
    w.T.st.subway = null; w.T.st.origin = { key: 'yotgol', name: '욧골(시험)', lat: P.lat, lng: P.lng, verified: true }; w.T.st.originKey = 'yotgol'; w.T.st.presetPos.yotgol = { ...P };
    await w.T.loadStops();
    const { list } = w.T.computeRoutes(), A = list.find((r) => r.key === 'A'), p = w.T.st.plan;
    ok('R10-17 카카오 경로에 출발지→첫 정류장 도보가 없으면 도보 길찾기로 보충하고 버스 탑승 판단에 반영', A.steps[0].type === 'walk' && Math.round(A.steps[0].min) === 5 && /다솔아파트까지 도보/.test(A.steps[0].label) && Math.round(A.steps[1].min) === 5, A.steps[0].label + ' ' + A.steps[0].min + '분 · 대기 ' + A.steps[1].min + '분');
    ok('R10-18 요금이 min·max로만 올 때: 일반버스 기준 최저 요금(1,650원) 적용, 좌석버스(48)는 탈 노선에서 제외', A.fare === 1650 && p.fare.cityOnly && p.board.routeNos.join() === '102' && /102번 버스 대기/.test(A.steps[1].label), A.fare + ' · ' + p.board.routeNos);
    ok('R10-19 경로 고르기: 카카오 순서가 아니라 카카오 전체 소요(대기 포함 추정)가 짧은 경로', p.route.totalSec === 2500);
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
        '/api/arrivals': (x, now) => ({ at: now.t, list: [{ routeNo: '104', arrSec: 900, prevCnt: 6 }] }), '/api/walk': () => ({ sec: 240, m: 300 }), '/api/bike': () => ({ sec: 600, m: 2500 }), '/api/tashu': tashu,
        '/api/subway': () => { const t = timetable(23); t.days[0][0].ride = 21; return t; } } });
      w.T.SC.bus.verifiedStops['104'] = ['DJB_X']; w.T.st.subway = null;
      w.T.st.presetPos.haksa = { ...P }; w.T.st.origin = { key: 'haksa', name: '학사마을(시험)', lat: P.lat, lng: P.lng, verified: true }; w.T.st.originKey = 'haksa';
      await w.T.loadStops();
      const { list } = w.T.computeRoutes();
      return { w, list, by: Object.fromEntries(list.map((r) => [r.key, r])), best: w.T.pickBest(list) };
    };
    let u = await run2(1650);   // 2구간 환승(유성온천·갑천 등) — 이전 정책(예산 1,550원)이면 추천이 없던 경우
    ok('P10-01 A 실제 요금(1,650원)을 기준으로: 추가 비용 없이 더 빠른 D(1,650원) 추천', u.by.A.avail === 'ok' && u.by.D.avail === 'ok' && u.by.D.fare === 1650 && u.best && u.best.key === 'D' && u.by.D.arrive < u.by.A.arrive,
      `A ${Math.round(u.by.A.total)}분 ${u.by.A.fare}원 · D ${Math.round(u.by.D.total)}분 ${u.by.D.fare}원`);
    ok('P10-02 A보다 비싼 경로(택시·택시+지하철)는 더 빨라도 추천 안 함', u.by.B.avail === 'ok' && u.by.B.arrive < u.by.D.arrive && u.best.key !== 'B' && u.best.key !== 'E');
    u = await run2(null);
    ok('P10-03 A 요금 미확인이면 추천 보류 (다른 경로가 확인돼도)', u.by.A.fare === null && u.best === null && u.by.D.avail !== 'no', u.by.A.why.join(' / '));
    // pickBest 단위 시험 (시각 기준 t0)
    const t0 = Date.now(), R = (key, avail, fare, min, o = {}) => ({ key, avail, fare, arrive: t0 + min * 60000, ...o });
    const pb = u.w.T.pickBest;
    ok('P10-04 시간 절감 경로가 없으면 A 추천 (A가 가장 빠름)', pb([R('A', 'ok', 1550, 40, { base: true }), R('D', 'ok', 1550, 45), R('B', 'ok', 13000, 30)]).key === 'A');
    ok('P10-05 같은 요금이라도 A보다 늦거나 같은 분이면 추천 안 함 · A가 미확인이면 추천 없음', pb([R('A', 'unknown', 1550, 40, { base: true }), R('D', 'ok', 1550, 45)]) === null && pb([R('A', 'unknown', 1550, 40, { base: true }), R('D', 'ok', 1550, 40.2)]) === null);
    ok('P10-06 A보다 싼 경로도 추가 비용 없음으로 보고 추천 · 요금 미확인·가정값 경로는 제외', pb([R('A', 'unknown', 1650, 50, { base: true }), R('D', 'ok', 1550, 44), R('E', 'unknown', 1600, 40), R('X', 'ok', null, 30)]).key === 'D');
    ok('P10-07 전 구간 타슈(도착 이상)는 0원이어도 추천 안 함', pb([R('A', 'ok', 1550, 50, { base: true }), R('C', 'ok', 0, 45, { plus: true })]).key === 'A');
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
      return { w, A: r.list.find((x) => x.key === 'A'), bus: r.bus, busDir: r.busDir };
    };
    let u = await go(mk([{ name: '108', type: '일반' }, { name: '999', type: '일반' }]), [{ routeNo: '999', arrSec: 420, prevCnt: 2 }, { routeNo: '108', arrSec: 900, prevCnt: 6 }]);
    ok('F10-01 노선별 방향: 108번만 확인된 정류장에서 미확인 999번이 먼저 오면 999번으로 판정 → 미확인(승격 안 됨)', u.bus.routeNo === '999' && u.busDir !== 'verified' && u.A.avail === 'unknown' && u.A.why.some((x) => x.includes('999번 운행 방향')), u.A.why.join(' / '));
    u = await go(mk([{ name: '108', type: '일반' }, { name: '999', type: '일반' }]), [{ routeNo: '108', arrSec: 420, prevCnt: 2 }, { routeNo: '999', arrSec: 900, prevCnt: 6 }]);
    ok('F10-02 같은 정류장에서 확인된 108번을 타면 방향 확인됨', u.bus.routeNo === '108' && u.busDir === 'verified' && u.A.avail === 'ok', u.A.why.join(' / '));
    u = await go(mk([{ name: '108', type: '일반' }, { name: '48', type: '좌석' }], { fare: null, fareMin: 1550, fareMax: 2900 }), [{ routeNo: '48', arrSec: 420, prevCnt: 2 }, { routeNo: '108', arrSec: 900, prevCnt: 6 }]);
    const ride = u.A.steps.find((x) => x.type === 'ride'), wait = u.A.steps.find((x) => x.type === 'wait');
    ok('F10-03 일반·좌석 혼재: 요금(일반 기준)·대기·승차 안내·경로 요약 모두 좌석버스(48) 제외', u.A.fare === 1550 && u.bus.routeNo === '108' && /^108번 대기|108번 버스 대기/.test(wait.label) && ride.label === '108번 버스' && !/48/.test(u.A.sub) && u.w.T.st.plan.board.routeNos.join() === '108',
      `${wait.label} · ${ride.label} · ${u.A.sub}`);

    /* ----- update11: 버스→버스 환승 요금 (대전 버스조합 환승 규정: 높은 요금 기준 · 같은 노선 불가 · 최대 3회) ----- */
    const B1 = { lat: 36.3550, lng: 127.3600 }, B2 = { lat: 36.3500, lng: 127.3900 };
    const busStep = (vehicles, a, b) => ({ type: 'BUS', sec: 600, m: 3000, stops: ['궁동네거리', '중간', '끝'], vehicles, start: a, head: { lat: a.lat, lng: a.lng + 0.001 }, end: b });
    const walkStep = (a, b) => ({ type: 'WALKING', sec: 120, m: 100, stops: [], vehicles: [], start: a, end: b });
    const subStep = { type: 'SUBWAY', sec: 1150, m: 9100, stops: ['월평', '갈마', '대전역'], vehicles: [{ name: '1호선', type: '일반' }], start: HUB, end: { lat: 36.3324, lng: 127.4343 } };
    const mk2 = (steps, fare) => ({ at: 0, routes: [{ type: 'BUS', totalSec: 2600, fare: null, ...fare, steps: [walkStep(P, BUS0), ...steps] }] });
    const arr = [{ routeNo: '108', arrSec: 420, prevCnt: 2 }];
    const fareOf = async (tr) => (await go(tr, arr)).w.T.st.plan.fare;
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
    delete process.env.QUOTA_KAKAO_TRANSIT;
  }

  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
