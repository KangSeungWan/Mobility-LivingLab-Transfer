// 오프라인 검증: 실제 외부 API를 부르지 않습니다 (모의 fetch만 사용). 실행: node tests/offline.cjs
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
  src = src.replace(/\nstart\(\);\n\}\)\(\);\s*$/, '\nwindow.__T = { st, SC, computeRoutes, pickBest, loadStops, loadArrivals, loadDrives, setPoint, search };\n})();');
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
    if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
    const fail = (o.fail || []).includes(p);
    let body = {};
    if (p === '/api/stops') body = { stops: [{ id: 'DJB8005589', no: '42630', name: '충남대산학연', lat: 36.36524, lng: 127.345184 }, { id: 'DJB8002725', no: '42650', name: '충남대학교입구', lat: 36.361355, lng: 127.34603 }] };
    else if (p === '/api/arrivals') body = { list: [{ routeNo: '108', arrSec: 600, prevCnt: 4 }], at: now.t };
    else if (p === '/api/arrivals-dj') body = { list: [], at: now.t };
    else if (p === '/api/tashu') body = { mock: false, stations: [{ name: '충남대 공대', d: 120, bikes: o.bikes ?? 5, lat: 36.366, lng: 127.346 }] };
    else if (p === '/api/drive') body = { durationSec: 1500, distanceM: 11000, taxiFare: 13000 };
    else if (p === '/api/subway') body = timetable(o.lastHour || 23);
    else if (p === '/api/search') body = { places: [{ name: '대전역', address: '', lat: 36.3324, lng: 127.4343 }] };
    return { ok: !fail, status: fail ? 503 : 200, json: async () => (fail ? { error: '조회 실패' } : body) };
  };
  const T = loadApp({ fetchImpl, now });
  T.st.cfg = { mock: false, drive: true, search: true, tashu: true };
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
  ok('목적지 변경: 바뀐 구간 1회만 조회 (월평역 구간은 세션 재사용)', w.calls['/api/drive'] === 3);
  await w.T.loadStops(true);
  ok('새로고침 버튼: 길찾기 다시 조회(+2)', w.calls['/api/drive'] === 5);
  w.T.setPoint('origin', { name: '멀리', lat: 36.40, lng: 127.40 }); await new Promise((r) => setTimeout(r, 30));
  ok('비교 구간(1km) 밖: 길찾기 호출 안 함', w.calls['/api/drive'] === 5);

  w = world({ delay: 30 }); w.T.st.subway = timetable(23); await w.T.loadStops();
  const before = w.calls['/api/arrivals'];
  await Promise.all([w.T.loadArrivals(), w.T.loadArrivals(), w.T.loadArrivals()]);
  ok('H01-12 갱신 겹침 방지: 동시에 3번 불러도 1번만 실행', w.calls['/api/arrivals'] - before === 2, `정류장 2곳 × 1회`);

  w = world({}); await w.T.search('대전역'); await w.T.search('대전역'); await w.T.search('충남대');
  ok('검색: 같은 세션의 같은 검색어는 재조회 안 함', w.calls['/api/search'] === 2);

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

  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
