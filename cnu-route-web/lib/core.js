// 공공데이터·카카오 API 호출을 서버에서 대신 처리합니다 (키는 브라우저로 나가지 않음)
const CACHE = new Map();
const DAEJEON_CITY_CODE = '25';
const ORIGIN = { lat: 36.36525, lng: 127.34648 }; // 공대 3호관 (카카오 장소 검색 좌표)

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const env = (k) => (process.env[k] || '').trim();
const isMock = () => env('MOCK') === '1' || !env('DATA_GO_KR_KEY');

// 공공 원천 데이터(정류소·도착정보·시각표·타슈 전체 목록)만 서버 메모리에 잠깐 둡니다.
// 카카오 검색·길찾기 결과는 사용자 간 공유가 허용되지 않아 여기에 넣지 않습니다.
const INFLIGHT = new Map();
// keep(v): 결과를 캐시에 둘지 (false면 이번 요청에만 쓰고 저장하지 않음 — 불완전한 결과 등 · update12 감사)
async function cached(key, ttlMs, fn, keep) {
  const now = Date.now(), hit = CACHE.get(key);
  if (hit && now < hit.exp) return hit.v;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);           // 같은 요청이 진행 중이면 합쳐서 외부 호출 1번만
  const p = (async () => {
    try {
      const v = await fn();
      if (!keep || keep(v)) {
        CACHE.set(key, { exp: Date.now() + ttlMs, v });
        for (const [k, c] of CACHE) if (Date.now() >= c.exp) CACHE.delete(k);   // 만료된 항목은 바로 지움
        if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value);
      }
      return v;
    } finally { INFLIGHT.delete(key); }
  })();
  INFLIGHT.set(key, p);
  return p;
}

/* ---------- 제공기관별 하루 호출량 제한 ---------- */
// 외부 API를 부르기 직전에 1회씩 예약합니다(재시도·점검 호출 포함). 한도를 넘으면 외부 호출 없이 멈춥니다.
// 기본값은 공개된 개발계정 트래픽보다 낮게 잡은 임시값입니다. 실제 승인량에 맞춰 환경변수 QUOTA_이름 으로 조정하세요.
// kakao_transit·walk·bike(카카오맵 경로 조회): 하루 무료 1,000건(초과분 유료) → 기존 원칙(승인량의 1/10)대로 100건.
// tago_route(TAGO 버스노선정보, update12): 운영계정 승인량을 문서로 확인하지 못해 임시값. 노선 정보는 서버가 1일 캐시하므로 실제 외부 호출은 적음
// djtc_dist(대전교통공사 역간 소요시간/거리/요금, update12): 포털 안내 개발계정 하루 1,000건 → 기존 원칙(1/10)대로 100. 역 쌍별 서버 1일 캐시
const QUOTA_DEFAULT = { tago_stops: 8000, tago_arrival: 8000, tago_route: 3000, dj_arrival: 8000, subway: 800, djtc_dist: 100, kakao_drive: 3000, kakao_search: 3000, kakao_transit: 100, kakao_walk: 100, kakao_bike: 100, tashu: 3000, other: 100 };
const QUOTA_LOCAL = new Map();
function quotaFor(url) {
  const u = String(url);
  if (u.includes('BusSttnInfoInqireService')) return 'tago_stops';
  if (u.includes('ArvlInfoInqireService')) return 'tago_arrival';
  if (u.includes('BusRouteInfoInqireService')) return 'tago_route';
  if (u.includes('/6300000/arrive') || (env('DJ_ARRIVAL_URL') && u.startsWith(env('DJ_ARRIVAL_URL')))) return 'dj_arrival';
  if (u.includes('TimeTableSVC') || (env('DJ_SUBWAY_URL') && u.startsWith(env('DJ_SUBWAY_URL')))) return 'subway';
  if (u.includes('/B554695/TimeDistSVC')) return 'djtc_dist';
  if (u.includes('apis-navi.kakaomobility.com')) return 'kakao_drive';
  if (u.includes('dapi.kakao.com/v2/routing/publictraffic')) return 'kakao_transit';
  if (u.includes('dapi.kakao.com/v2/routing/walk')) return 'kakao_walk';
  if (u.includes('dapi.kakao.com/v2/routing/bicycle')) return 'kakao_bike';
  if (u.includes('dapi.kakao.com')) return 'kakao_search';
  if (u.includes('tashu.or.kr')) return 'tashu';
  return 'other';
}
const quotaLimit = (name) => { const raw = env('QUOTA_' + name.toUpperCase()), v = Number(raw); return raw !== '' && Number.isFinite(v) && v >= 0 ? v : QUOTA_DEFAULT[name]; };
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const quotaStore = () => {
  const url = env('UPSTASH_REDIS_REST_URL') || env('KV_REST_API_URL'), token = env('UPSTASH_REDIS_REST_TOKEN') || env('KV_REST_API_TOKEN');
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
};
async function storeCmd(store, cmds) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const r = await fetch(store.url + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds), signal: ctl.signal });
    const j = await r.json();
    if (!r.ok || !Array.isArray(j)) throw new Error('저장소 응답 오류');
    return j.map((x) => x && x.result);
  } finally { clearTimeout(timer); }
}
async function reserve(name) {
  // 예시 데이터 모드(MOCK=1)에서는 어떤 외부 API도 부르지 않습니다 (개발·테스트 중 실제 호출 방지)
  if (env('MOCK') === '1') throw new ApiError(503, '예시 데이터 모드(MOCK=1)에서는 외부 API를 호출하지 않아요');
  const limit = quotaLimit(name), day = kstDay(), key = `caw:quota:${day}:${name}`;
  const over = new ApiError(429, '오늘 이 정보의 조회 한도에 도달해 외부 조회를 멈췄어요. 내일 다시 시도해 주세요');
  for (const k of QUOTA_LOCAL.keys()) if (!k.includes(day)) QUOTA_LOCAL.delete(k);
  const local = (QUOTA_LOCAL.get(key) || 0) + 1;              // 1차: 이 서버 인스턴스 안에서의 합계
  if (local > limit) throw over;
  QUOTA_LOCAL.set(key, local);
  const store = quotaStore();
  if (!store) return;                                         // 공유 저장소 미설정: 인스턴스별 제한만 적용됨
  let total;
  try { total = Number((await storeCmd(store, [['INCR', key], ['EXPIRE', key, 172800]]))[0]); if (!Number.isFinite(total)) throw new Error('bad'); }
  catch {                                                     // 2차: 모든 인스턴스 합계(원자적 INCR). 저장소 장애 시 기본은 호출 중단
    if (env('QUOTA_FAIL_OPEN') === '1') return;
    throw new ApiError(503, '호출량 확인 저장소에 연결하지 못해 외부 조회를 잠시 멈췄어요');
  }
  if (total > limit) throw over;
}

async function fetchText(url, headers = {}) {
  await reserve(quotaFor(url));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new ApiError(502, `외부 API 응답 오류 (${r.status}): ${text.slice(0, 160)}`);
    return text;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(504, e.name === 'AbortError' ? '외부 API 응답 시간 초과' : `외부 API 연결 실패: ${e.message}`);
  } finally { clearTimeout(timer); }
}

// TAGO가 '가용한 세션이 존재하지 않습니다(99)'나 HTTP 500을 줄 때가 있어 잠깐 쉬고 최대 2번 더 시도
async function fetchTago(url) {
  for (let i = 0; ; i++) {
    let t;
    try { t = await fetchText(url); }
    catch (e) { if (i >= 2 || e.status === 429 || e.status === 503 || !/\(5\d\d\)|시간 초과/.test(e.message)) throw e; } // 포털 일시 오류(500 APPLICATION_ERROR 등)만 재시도. 한도 초과는 재시도 안 함
    // 일시 오류는 잠깐 쉬고 다시: resultCode 99(세션 부족), 포털 공통 오류 HTTP_ERROR(코드 04, update15 배포 점검에서 확인)
    if (t !== undefined && (i >= 2 || !(/"resultCode"\s*:\s*"?99\b/.test(t) || /HTTP_ERROR|"returnReasonCode"\s*:\s*"?04\b/.test(t)))) return t;
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
}

function dataGoUrl(base, params) {
  const u = new URL(base);
  u.searchParams.set('serviceKey', env('DATA_GO_KR_KEY')); // 공공데이터포털 '일반 인증키(Decoding)' 값
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

// TAGO(JSON) 응답에서 item 배열 꺼내기. 키 오류는 _type=json이어도 XML로 오는 경우가 있어 함께 처리
function tagoItems(text) {
  const t = text.trim();
  if (t.startsWith('<')) {
    throw new ApiError(502, '공공데이터 API 오류: ' + explainXmlError(t));
  }
  let j;
  try { j = JSON.parse(t); } catch { throw new ApiError(502, '공공데이터 API 응답을 읽을 수 없습니다'); }
  // 포털 공통 오류(JSON 형식): {"OpenAPI_ServiceResponse":{"cmmMsgHeader":{"errMsg":"HTTP_ERROR","returnReasonCode":"04"}}} (update15)
  //   이전에는 response가 없어 '0건'으로 처리 → 근처 정류장 빈 목록이 하루 캐시되는 문제가 있었음. 이제 오류로 처리(캐시 안 함)
  const env0 = j && (j.OpenAPI_ServiceResponse || (j.cmmMsgHeader ? j : null));
  if (env0) { const m = env0.cmmMsgHeader || {}; const code = String(m.returnReasonCode || '').trim(), msg = String(m.returnAuthMsg || m.errMsg || '포털 오류');
    throw new ApiError(502, `공공데이터 포털 오류: ${ERR_HELP[m.errMsg] || msg}${code ? ` (코드 ${code})` : ''}`); }
  if (!j || !j.response || !j.response.header) throw new ApiError(502, '공공데이터 API 응답 형식이 올바르지 않습니다');
  const h = j.response && j.response.header;
  if (h && String(h.resultCode) !== '00') throw new ApiError(502, `공공데이터 API 오류 ${h.resultCode}: ${h.resultMsg}`);
  const items = j.response && j.response.body && j.response.body.items;
  if (!items || !items.item) return [];
  return Array.isArray(items.item) ? items.item : [items.item];
}

// 공공데이터포털 공통 오류 코드를 우리말로
const ERR_HELP = {
  SERVICE_KEY_IS_NOT_REGISTERED_ERROR: '이 키로 활용신청이 안 된 API예요 (승인 직후면 1~2시간 뒤 다시 시도)',
  LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR: '오늘 호출 한도를 넘었어요 (내일 다시 시도)',
  SERVICE_ACCESS_DENIED_ERROR: '접근이 거부됐어요 (활용신청 상태 확인)',
  LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR: '오늘 호출 한도를 넘었어요',
  DEADLINE_HAS_EXPIRED_ERROR: '활용기간이 끝났어요',
  NO_OPENAPI_SERVICE_ERROR: '요청 주소가 잘못됐어요',
  UNREGISTERED_IP_ERROR: '등록되지 않은 IP예요',
};
function explainXmlError(t) {
  const auth = (t.match(/<returnAuthMsg>([^<]*)</) || [])[1];
  const msg = auth || (t.match(/<(resultMsg|errMsg)>([^<]*)</) || [])[2] || t.slice(0, 120);
  return ERR_HELP[msg] ? `${ERR_HELP[msg]} [${msg}]` : msg;
}

// 대전 주변만 허용 (배포 시 남의 위치·경로 조회에 키가 쓰이지 않게)
const DJ_BOX = { s: 36.10, n: 36.60, w: 127.15, e: 127.65 };
function inDaejeon(lat, lng, what = '위치') {
  if (lat < DJ_BOX.s || lat > DJ_BOX.n || lng < DJ_BOX.w || lng > DJ_BOX.e) throw new ApiError(400, `${what}가 대전 지역 밖이에요`);
}
function num(v, name) {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) throw new ApiError(400, `${name} 값이 필요합니다`);
  return n;
}

/* ---------- 1. 좌표 근처 정류장 (TAGO 버스정류소정보 · 반경 약 500m) ---------- */
async function nearbyStops(q) {
  const lat = num(q.lat, 'lat'), lng = num(q.lng, 'lng');
  inDaejeon(lat, lng);
  if (isMock()) return { mock: true, stops: mockStops(lat, lng) };
  const key = `stops:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const stops = await cached(key, 24 * 3600e3, async () => {
    const text = await fetchTago(dataGoUrl('https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList',
      { gpsLati: lat, gpsLong: lng, numOfRows: 40, pageNo: 1, _type: 'json' }));
    return tagoItems(text).map((it) => ({
      id: String(it.nodeid), name: String(it.nodenm), lat: Number(it.gpslati), lng: Number(it.gpslong),
      no: it.nodeno != null ? String(it.nodeno) : null, city: it.citycode != null ? String(it.citycode) : null,
    })).filter((s) => (!s.city || s.city === DAEJEON_CITY_CODE) && it0(s.id) && it0(s.name));
  });
  return { mock: false, stops };
}

/* ---------- 2. 정류장 실시간 도착 (TAGO 버스도착정보) ---------- */
async function arrivals(q) {
  const nodeId = String(q.nodeId || '').trim();
  if (!/^[A-Za-z0-9_-]{3,30}$/.test(nodeId)) throw new ApiError(400, 'nodeId 값이 올바르지 않습니다');
  if (isMock()) return { mock: true, source: 'mock', nodeId, at: Date.now(), list: mockArrivals(nodeId) };
  return cached(`arr:${nodeId}`, 20e3, async () => {
    const text = await fetchTago(dataGoUrl('https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList',
      { cityCode: DAEJEON_CITY_CODE, nodeId, numOfRows: 60, pageNo: 1, _type: 'json' }));
    const list = tagoItems(text).map((it) => ({
      routeNo: String(it.routeno), routeId: validRouteId(it.routeid) ? String(it.routeid) : '', routeType: it.routetp || '',
      arrSec: it.arrtime == null || it.arrtime === '' ? NaN : Number(it.arrtime), prevCnt: cnt(it.arrprevstationcnt), vehicleType: it.vehicletp || '',
    })).filter((a) => Number.isFinite(a.arrSec) && a.arrSec >= 0 && it0(a.routeNo)).sort((a, b) => a.arrSec - b.arrSec);
    return { mock: false, source: 'tago', nodeId, at: Date.now(), list };
  });
}

/* ---------- 2-0. 버스 노선·경유 정류장 (TAGO 버스노선정보 · update12) ---------- */
// 공식 명세(data.go.kr 15098529): 1613000/BusRouteInfoInqireService — 노선번호목록 조회(cityCode·routeNo → routeid·routeno·routetp·startnodenm·endnodenm),
//   노선별경유정류소목록 조회(cityCode·routeId → nodeid·nodenm·nodeno·nodeord·gpslati·gpslong·updowncd[0 상행·1 하행], routeid·nodeno·updowncd는 선택 항목).
//   이용허락범위 제한 없음. 운행 방향 자동 검증에 씀. 노선 정보는 자주 바뀌지 않아 서버 메모리 1일 캐시(도착정보 캐시와 분리),
//   목록이 불완전(받은 건수 ≠ totalCount, 필수 항목 누락)하면 오류로 처리해 캐시하지 않음
const ROUTE_BASE = 'https://apis.data.go.kr/1613000/BusRouteInfoInqireService';
const ROUTE_OPS = { list: 'getRouteNoList', stops: 'getRouteAcctoThrghSttnList' };   // 기능별 경로 (2026-11-19 실제 응답으로 확인 — DEV_LOG)
// 건수·쪽 번호 원본 값 검사 (update12 최종): 0 이상 정수(숫자) 또는 숫자로만 된 문자열만 인정.
//   null·누락·빈 문자열·공백·음수·소수·boolean·'12abc' 같은 값은 NaN → 불완전 응답 (Number(null) = 0 으로 '정상 0건'이 되지 않게)
function countOf(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : NaN;
  if (typeof v === 'string' && /^\d+$/.test(v)) { const n = Number(v); return Number.isSafeInteger(n) ? n : NaN; }
  return NaN;
}
// 노선 ID 원본 값 검사: 문자열·숫자이고 영문·숫자·_·- 로만 된 값 (누락·null·빈 문자열·공백·객체·배열은 불량)
//   문자열 'null'·'undefined'(대소문자·앞뒤 공백 무관)도 불량 — 값이 없던 것을 문자열로 바꾼 흔적이라 정상 노선 ID로 보지 않음 (update12 최종)
const validRouteId = (v) => (typeof v === 'string' || typeof v === 'number') && /^[A-Za-z0-9_-]{1,40}$/.test(String(v)) && !/^(null|undefined)$/i.test(String(v).trim());
function tagoBody(text) {
  const items = tagoItems(text);                 // 오류 코드·XML 오류 처리 포함
  const j = JSON.parse(text.trim()), b = j.response && j.response.body;
  const total = b ? countOf(b.totalCount) : NaN;
  const pageNo = b && b.pageNo !== undefined && b.pageNo !== null ? countOf(b.pageNo) : null;   // 쪽 번호가 있는데 숫자가 아니면 NaN → 요청 쪽과 달라 오류
  return { items, total, pageNo };
}
// 페이지를 끝까지 받아 '완전한 목록'일 때만 돌려줌 (update12 감사: 받은 건수가 totalCount와 같다는 것만으로 완전하다고 보지 않음)
//   · 쪽마다 전체 건수(totalCount)가 있고 첫 쪽과 같아야 함 · 응답에 쪽 번호(pageNo)가 있으면 요청한 쪽과 같아야 함
//   · 앞서 받은 쪽과 내용이 같은 쪽이 다시 오면 오류 · 마지막 쪽이 아니면 요청한 건수(100)를 꽉 채워야 함
//   · 합계 건수 = 전체 건수. 하나라도 어긋나면 502 (캐시 안 함)
async function tagoAll(op, params, label) {
  const rows = 100, all = [], seen = new Set();
  let total = NaN;
  for (let page = 1; page <= 20; page++) {
    const r = tagoBody(await fetchTago(dataGoUrl(`${ROUTE_BASE}/${op}`, { ...params, numOfRows: rows, pageNo: page, _type: 'json' })));
    if (!Number.isFinite(r.total) || r.total < 0) throw new ApiError(502, `${label}: 전체 건수(totalCount)가 없어 목록이 완전한지 확인할 수 없어요`);
    if (page === 1) total = r.total;
    else if (r.total !== total) throw new ApiError(502, `${label}: 쪽마다 전체 건수가 달라요(${total} → ${r.total}) · 불완전한 목록`);
    if (r.pageNo != null && r.pageNo !== page) throw new ApiError(502, `${label}: ${page}쪽을 요청했는데 ${r.pageNo}쪽 응답이 왔어요 · 불완전한 목록`);
    const sig = JSON.stringify(r.items);
    if (r.items.length && seen.has(sig)) throw new ApiError(502, `${label}: 같은 내용의 쪽이 반복해서 왔어요 · 불완전한 목록`);
    seen.add(sig);
    all.push(...r.items);
    if (all.length >= total || !r.items.length) break;
    if (r.items.length !== rows) throw new ApiError(502, `${label}: ${page}쪽이 ${r.items.length}건뿐인데 목록이 끝나지 않았어요 · 불완전한 목록`);
  }
  if (all.length !== total) throw new ApiError(502, `${label}: 받은 ${all.length}건과 전체 ${total}건이 달라 불완전한 목록이에요`);
  return all;
}
const fnn = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
// 정거장 수: 0 이상 정수만 (빈 값·누락은 null — 0으로 보지 않음. 화면에 'null정거장 전'이 나오지 않게 · update12 감사)
function cnt(v) { const n = fnn(v); return n != null && Number.isInteger(n) && n >= 0 ? n : null; }
const it0 = (v) => !!v && v !== 'undefined' && v !== 'null';
// 경유 정류장 목록 검사 (update12 감사): 필수 항목 · 순번(1 이상 정수, 중복·빈 번호 없음) · 상하행 코드 구간
//   순환노선은 같은 정류장 ID가 다른 순번으로 다시 나올 수 있어 정상. 같은 순번이 두 번이면(같은 행 반복 등) 비정상
function checkStops(stops) {
  const why = [];
  if (!stops.length) why.push('경유 정류장 없음');
  if (stops.some((x) => !x.nodeId || !x.name || x.ord == null || !pt([x.lng, x.lat]))) why.push('필수 항목(정류장 ID·이름·순번·좌표) 누락');
  const ords = stops.map((x) => x.ord).filter((o) => o != null);
  if (ords.some((o) => !Number.isInteger(o) || o < 1)) why.push('순번이 1 이상 정수가 아님');
  else if (new Set(ords).size !== ords.length) why.push('같은 순번이 두 번 이상 나옴');
  else if (ords.length && Math.max(...ords) - Math.min(...ords) + 1 !== ords.length) why.push('순번 중간이 비어 있음');
  const ud = stops.map((x) => x.ud);
  if (ud.length && ud.every((u) => u != null)) {
    let turns = 0;
    for (let i = 1; i < ud.length; i++) if (ud[i] !== ud[i - 1]) turns++;
    if (turns > 1) why.push(`상하행 코드가 ${turns}번 바뀜(운행 구간 비정상)`);
  }
  return why;
}
async function busRoute(q) {
  const routeNo = String(q.routeNo || '').trim();
  if (!/^[0-9A-Za-z가-힣-]{1,12}$/.test(routeNo)) throw new ApiError(400, 'routeNo(노선 번호) 값이 올바르지 않습니다');
  if (isMock()) return { mock: true, routeNo, routes: [] };
  // 완전한 결과만 서버 1일 캐시 (complete=false면 저장하지 않고, handler도 CDN 저장을 막음 · update12 감사)
  return cached(`route:${routeNo}`, 24 * 3600e3, async () => {
    // 노선번호 조회는 비슷한 번호도 함께 줄 수 있어 번호가 정확히 같은 노선만 사용
    //   번호가 같은데 노선 ID가 불량(누락·null·빈 값 등)인 행이 있으면 조용히 빼지 않고 전체를 불완전으로 처리 (update12 최종)
    const same = (await tagoAll(ROUTE_OPS.list, { cityCode: DAEJEON_CITY_CODE, routeNo }, '노선번호목록')).filter((it) => it && String(it.routeno) === routeNo);
    const badIds = same.filter((it) => !validRouteId(it.routeid)).length;
    const list = same.filter((it) => validRouteId(it.routeid));
    if (new Set(list.map((it) => String(it.routeid))).size !== list.length) throw new ApiError(502, '노선번호목록: 같은 노선 ID가 두 번 이상 나와 목록을 믿을 수 없어요');
    const routes = [];
    for (const it of list.slice(0, 6)) {
      const raw = await tagoAll(ROUTE_OPS.stops, { cityCode: DAEJEON_CITY_CODE, routeId: it.routeid }, '노선별경유정류소');
      const stops = raw.map((x) => ({ nodeId: x.nodeid ? String(x.nodeid) : null, name: String(x.nodenm || ''), no: x.nodeno != null && x.nodeno !== '' ? String(x.nodeno) : null,
        ord: fnn(x.nodeord), lat: fnn(x.gpslati), lng: fnn(x.gpslong), ud: x.updowncd === 0 || x.updowncd === 1 || x.updowncd === '0' || x.updowncd === '1' ? Number(x.updowncd) : null }));
      stops.sort((a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9));
      // 필수 항목 누락·순번 이상·상하행 구간 이상이면 이 노선은 '불완전' — 화면에서 방향 확정에 쓰지 않음
      const bad = checkStops(stops);
      routes.push({ routeId: String(it.routeid), routeNo, routeType: String(it.routetp || ''), start: String(it.startnodenm || ''), end: String(it.endnodenm || ''),
        complete: !bad.length, why: bad.length ? bad.join(' · ') : null, hasUd: stops.some((x) => x.ud != null), stops });
    }
    // 전체 완전성: 노선 ID를 모두 받았고(최대 6개) 모든 노선이 완전할 때만 complete=true
    const more = list.length > 6;
    const why = [...(badIds ? [`노선 ID가 없거나 잘못된 행 ${badIds}개`] : []), ...(more ? [`노선 ID ${list.length}개 중 6개만 조회`] : []), ...routes.filter((r) => !r.complete).map((r) => `${r.routeId}: ${r.why}`)];
    return { mock: false, routeNo, at: Date.now(), routes, more, complete: !why.length, why: why.length ? why.join(' / ') : null };
  }, (v) => v.complete === true);
}

/* ---------- 2-0b. 대전교통공사 역간 소요시간/거리/요금 (update12 · 공식 명세 data.go.kr 15158794) ---------- */
// 포털 공개 명세: 기본 주소 https://apis.data.go.kr/B554695/TimeDistSVC · 요청변수 serviceKey · strstnno(조회 시작역, 예 111) · endstnno(조회 끝역, 예 120) · XML.
//   오퍼레이션 getTimeDist01(운영계정 승인 화면, 2026-11-20). 실제 응답: <response><header><resultCode>00</resultCode>…</header><body><item>
//   <distfloat>9.1</distfloat>(㎞)<fee>1400</fee>(과거 운임 — 현행 1,550·1,650보다 150원 낮음)<min>19</min><sec>0</sec></item></body>.
//   item의 하위 항목을 이름 그대로(문자열) 돌려줌 — 화면은 distfloat(거리)만 요금 구간 판정에 쓰고 fee는 금액으로 쓰지 않음
//   캐시: 역 쌍별 서버 메모리 1일 · 정상 응답(항목 1개 이상)만 저장 · 동시 요청 병합 · 오류·빈 응답은 저장 안 함 · CDN 저장 안 함
const STNDIST_PREFIX = 'https://apis.data.go.kr/B554695/TimeDistSVC/';
// 오퍼레이션 주소: 2026-11-20 운영계정 승인 화면에서 확인(getTimeDist01, 운영계정 하루 100,000건, 활용 2026-11-20~2028-11-20). .env DJ_STNDIST_URL이 있으면 그것을 우선
const STNDIST_URL = () => env('DJ_STNDIST_URL') || STNDIST_PREFIX + 'getTimeDist01';
const stnNo = (v) => (/^1(0[1-9]|1[0-9]|2[0-2])$/.test(String(v || '').trim()) ? String(v).trim() : null);   // 1호선 역번호 101~122
function xmlItems(xml) {
  return xmlBlocks(xml).map((b) => Object.fromEntries([...b.matchAll(/<([A-Za-z][\w]*)>([^<]*)<\/\1>/g)].map((m) => [m[1], m[2].trim()])));
}
// 작은 XML 해석기(update12): 태그가 모두 짝이 맞고 닫혀 있을 때만 트리를 돌려줌, 아니면 null. 속성·CDATA·주석·자기 닫힘 태그는 이 API에 없어 거부
function xmlTree(xml) {
  const t = String(xml || '').replace(/^\uFEFF?\s*<\?xml[^>]*\?>/, '').trim();
  if (!t.startsWith('<') || /<!|<\?/.test(t)) return null;
  const root = { name: '#root', kids: [], text: '' }, stack = [root];
  const re = /<(\/?)([A-Za-z_][\w.-]*)\s*>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[4]) return null;                                     // 해석할 수 없는 '<'
    if (m[3] !== undefined) { if (stack.length === 1) { if (m[3].trim()) return null; } else stack[stack.length - 1].text += m[3]; continue; }
    if (m[1]) { const top = stack.pop(); if (!top || top.name !== m[2] || stack.length === 0) return null; continue; }
    const el = { name: m[2], kids: [], text: '' }; stack[stack.length - 1].kids.push(el); stack.push(el);
  }
  return stack.length === 1 && root.kids.length === 1 ? root.kids[0] : null;
}
const kid = (el, name) => (el ? el.kids.filter((k) => k.name === name) : []);
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
// 역간 거리 응답 검사: 닫힌 XML · response>header>resultCode = 00 · response>body>item(또는 body>items>item) 정확히 1개 · item 하위 항목은 값만 있는 단일 항목 · checkDistItem 통과
function parseStnDist(xml, from, to) {
  const root = xmlTree(xml);
  if (!root || root.name !== 'response') return { err: 'XML 형식 오류(태그가 닫히지 않았거나 해석할 수 없음)' };
  const header = kid(root, 'header'), body = kid(root, 'body');
  if (header.length !== 1 || body.length !== 1) return { err: 'header·body 구조 오류' };
  const code = kid(header[0], 'resultCode');
  // resultCode는 하위 요소가 없는 단일 텍스트 '00'만 성공 (예: <resultCode>00<x>03</x></resultCode>는 거부 — 중첩 내용을 합친 텍스트로 판단하지 않음)
  if (code.length !== 1 || code[0].kids.length || code[0].text.trim() !== '00') return { err: code.length ? `결과 코드 ${code[0].text.trim() || '(빈 값)'}${kid(header[0], 'resultMsg')[0] ? ' · ' + kid(header[0], 'resultMsg')[0].text.trim() : ''}` : '결과 코드(resultCode) 없음' };
  const wrap = kid(body[0], 'items'), items = [...kid(body[0], 'item'), ...wrap.flatMap((w) => kid(w, 'item'))];
  if (wrap.length > 1 || items.length !== 1) return { incomplete: `item ${items.length}개(정확히 1개여야 함)` };
  const it = items[0];
  if (it.kids.some((k) => k.kids.length) || new Set(it.kids.map((k) => k.name)).size !== it.kids.length) return { incomplete: 'item 하위 항목 구조 오류(중첩·중복)' };
  const obj = Object.fromEntries(it.kids.map((k) => [k.name, k.text.trim()]));
  const c = checkDistItem(obj, from, to);
  return c.why ? { incomplete: c.why, item: obj } : { item: obj, dist: c };
}
async function stationDist(q) {
  const from = stnNo(q.from), to = stnNo(q.to);
  if (!from || !to || from === to) throw new ApiError(400, 'from·to(1호선 역번호 101~122, 서로 다른 역) 값이 올바르지 않습니다');
  if (isMock()) return { mock: true, from, to, items: [], complete: false };
  const base = STNDIST_URL();
  if (!base.startsWith(STNDIST_PREFIX)) throw new ApiError(501, 'DJ_STNDIST_URL은 대전교통공사 역간 소요시간/거리/요금 주소(B554695/TimeDistSVC/…)여야 해요');
  return cached(`stdist:${from}-${to}`, 24 * 3600e3, async () => {
    const u = new URL(base); u.search = '';
    const xml = await fetchText(dataGoUrl(u.toString(), { strstnno: from, endstnno: to }));
    if (/<returnAuthMsg>|<errMsg>/.test(xml) && !/<returnAuthMsg>\s*NORMAL/i.test(xml)) throw new ApiError(502, '역간 거리·요금 API 오류: ' + explainXmlError(xml));
    // 응답 검사(update12): XML 형식·결과 코드 오류는 502, 형식은 맞지만 쓸 수 없는 값(item 0·복수, 거리·시간 이상, 역 불일치)은 complete:false — 둘 다 캐시 안 함
    const p = parseStnDist(xml, from, to);
    if (p.err) throw new ApiError(502, '역간 거리·요금 API 응답 오류: ' + p.err);
    const items = p.item ? [p.item] : [];
    return { mock: false, from, to, at: Date.now(), source: '대전교통공사 역간 소요시간/거리/요금', items, fields: items.length ? Object.keys(items[0]) : [],
      dist: p.dist || null, complete: !p.incomplete, why: p.incomplete || null };
  }, (v) => v.complete === true);
}

/* ---------- 2-1. 대전시 정류소별 도착정보 (보조 · 정류장 번호 arsId 기준, XML) ---------- */
function xmlBlocks(xml) {
  for (const tag of ['itemList', 'item']) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    const out = [...xml.matchAll(re)].map((m) => m[1]);
    if (out.length) return out;
  }
  return [];
}
const xmlField = (block, name) => { const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1].trim() : ''; };

async function arrivalsDaejeon(q) {
  const arsId = String(q.arsId || '').trim();
  if (!/^\d{3,8}$/.test(arsId)) throw new ApiError(400, 'arsId(정류장 번호) 값이 올바르지 않습니다');
  if (isMock()) return { mock: true, source: 'mock', arsId, at: Date.now(), list: mockArrivals(arsId) };
  const base = env('DJ_ARRIVAL_URL') || 'https://apis.data.go.kr/6300000/arrive/getArrInfoByUid';
  return cached(`dj:${arsId}`, 20e3, async () => {
    const xml = await fetchText(dataGoUrl(base, { arsId }));
    if (/<returnAuthMsg>|<errMsg>/.test(xml) && !/<returnAuthMsg>\s*NORMAL/i.test(xml)) throw new ApiError(502, '대전시 API 오류: ' + explainXmlError(xml));
    const list = xmlBlocks(xml).map((b) => {
      const rs = xmlField(b, 'EXTIME_SEC'), rm = xmlField(b, 'EXTIME_MIN'), sec = rs === '' ? NaN : Number(rs), min = rm === '' ? NaN : Number(rm);   // 빈 값은 0분으로 보지 않음
      return {
        routeNo: xmlField(b, 'ROUTE_NO'), routeId: validRouteId(xmlField(b, 'ROUTE_CD')) ? xmlField(b, 'ROUTE_CD') : '', destination: xmlField(b, 'DESTINATION'),
        arrSec: Number.isFinite(sec) && sec > 0 ? sec : min * 60, prevCnt: cnt(xmlField(b, 'STATUS_POS')),
        message: xmlField(b, 'MSG_TP'),
      };
    }).filter((a) => a.routeNo && Number.isFinite(a.arrSec) && a.arrSec >= 0).sort((a, b) => a.arrSec - b.arrSec);
    return { mock: false, source: 'daejeon', arsId, at: Date.now(), list };
  });
}

/* ---------- 3-1. 대전도시철도 열차시각표 (대전교통공사 TimeTableSVC · 전체 역을 한 번에 받아 12시간 캐시) ---------- */
// dayType 0=평일 1=휴일 · drctType 0=판암 방면 1=반석 방면 · stNum 101(판암)~122(반석), 월평 114, 대전역 104
const SUBWAY_URL = () => env('DJ_SUBWAY_URL') || 'https://apis.data.go.kr/B554695/TimeTableSVC/getAllTimeTable';
function parseTimetable(xml) {
  if (/<returnAuthMsg>|<errMsg>/.test(xml) && !/<returnAuthMsg>\s*NORMAL/i.test(xml)) throw new ApiError(502, '열차시각표 API 오류: ' + explainXmlError(xml));
  const map = {}, term = {}, skipped = [];
  for (const b of xmlBlocks(xml)) {
    const k = `${xmlField(b, 'dayType')}|${xmlField(b, 'drctType')}|${xmlField(b, 'stNum')}`;
    let hr = Number(xmlField(b, 'tmZone')); if (hr < 4) hr += 24;  // 자정 넘은 막차
    // 분 값: 보통 '48'. 막차 등은 '48(판암)'·'58(정부청사)'처럼 행선지가 붙어 옴(2026-11-17 실제 응답) → 행선지 역을 기록해
    //   하차역까지 가는 열차만 쓰도록 함(subway()). 이전에는 NaN(JSON null)으로 들어갔음. 그 밖의 형식은 버림
    for (const m of xmlField(b, 'tmList').split(/\s+/).filter(Boolean)) {
      const x = m.match(/^(\d{1,2})(?:\(([^)]+)\))?$/);
      if (x && Number.isFinite(hr)) {
        const t = hr * 60 + Number(x[1]);
        (map[k] = map[k] || []).push(t);
        if (x[2]) term[`${k}|${t}`] = x[2].trim();
      } else if (skipped.length < 20) skipped.push(`${k}|${xmlField(b, 'tmZone')}시:${m}`);
    }
  }
  for (const k in map) map[k].sort((a, b) => a - b);
  if (!Object.keys(map).length) throw new ApiError(502, '열차시각표 응답에 시각이 없습니다');
  Object.defineProperty(map, '_term', { value: term, enumerable: false });
  Object.defineProperty(map, '_skipped', { value: skipped, enumerable: false });
  return map;
}
// 1호선 역 이름 → 역번호 (대전교통공사 시설/운행현황 djtc.kr menuIdx=460 확인). 시각표 행선지 판단용 — public/scenario.js의 표와 같은 값
const STATION_NO = { '판암': 101, '신흥': 102, '대동': 103, '대전': 104, '중앙로': 105, '중구청': 106, '서대전네거리': 107, '오룡': 108, '용문': 109, '탄방': 110,
  '시청': 111, '정부청사': 112, '갈마': 113, '월평': 114, '갑천': 115, '유성온천': 116, '유성': 116, '구암': 117, '현충원': 118, '월드컵경기장': 119, '노은': 120, '지족': 121, '반석': 122 };
// 두 역 시각표에서 가장 많이 맞아떨어지는 시간 차(분) = 같은 열차의 역간 소요시간. 양수면 from → to 방향
function bestOffset(a, b) {
  const set = new Set(b); let best = { min: null, hits: 0 };
  for (let k = -45; k <= 45; k++) { if (!k) continue; let n = 0; for (const x of a) if (set.has(x + k)) n++; if (n > best.hits) best = { min: k, hits: n }; }
  return best;
}
async function subway(q) {
  const from = String(q.from || '114'), to = String(q.to || '104');
  if (!/^\d{3}$/.test(from) || !/^\d{3}$/.test(to)) throw new ApiError(400, '역번호 값이 올바르지 않습니다');
  if (isMock()) return { mock: true };
  const all = await cached('subway:all', 12 * 3600e3, async () => parseTimetable(await fetchText(dataGoUrl(SUBWAY_URL(), { numOfRows: 3000, pageNo: 1 }))));
  const days = {}, term = all._term || {}, short = [];
  for (const d of ['0', '1']) { days[d] = {}; for (const dir of ['0', '1']) {
    const a = all[`${d}|${dir}|${from}`] || [], b = all[`${d}|${dir}|${to}`] || [], o = bestOffset(a, b);
    // 행선지가 붙은 열차: 행선지가 하차역(to)까지 가는지 확인. 0=판암 방면(역번호 감소), 1=반석 방면(역번호 증가). 모르는 행선지는 쓰지 않음
    const reaches = (t) => { const nm = term[`${d}|${dir}|${from}|${t}`]; if (!nm) return true; const n = STATION_NO[nm.replace(/역$/, '')];
      const ok = n != null && (dir === '0' ? n <= Number(to) : n >= Number(to)); if (!ok && short.length < 5) short.push(`${d}|${dir}|${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}(${nm})`); return ok; };
    days[d][dir] = { from: a.filter(reaches), ride: o.min > 0 && o.hits >= 5 ? o.min : null };
  } }
  return { mock: false, from, to, days, shortTurn: short, skipped: (all._skipped || []).slice(0, 5) };   // 하차역 전에 끝나는 열차·버린 값 예시(확인용)
}

/* ---------- 3. 자동차(택시) 이동시간·요금 (카카오모빌리티 길찾기, 선택) ---------- */
let driveBlockedUntil = 0;
async function drive(q) {
  const o = [num(q.olat, 'olat'), num(q.olng, 'olng')], d = [num(q.dlat, 'dlat'), num(q.dlng, 'dlng')];
  inDaejeon(o[0], o[1], '출발지'); inDaejeon(d[0], d[1], '도착지');
  if (!env('KAKAO_REST_KEY') || env('MOCK') === '1') throw new ApiError(501, '카카오 길찾기 키가 없어 고정값을 사용합니다');
  if (Date.now() < driveBlockedUntil) throw new ApiError(503, '카카오 길찾기를 쓸 수 없어 고정값을 사용합니다 (권한 확인)');
  // 카카오 길찾기 결과는 서버에 저장하지 않습니다(사용자 간 공유 캐시 금지). 요청마다 조회해 바로 돌려줍니다.
  const u = new URL('https://apis-navi.kakaomobility.com/v1/directions');
  u.searchParams.set('origin', `${o[1]},${o[0]}`);
  u.searchParams.set('destination', `${d[1]},${d[0]}`);
  u.searchParams.set('priority', 'RECOMMEND');
  let j;
  try { j = JSON.parse(await fetchText(u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` })); }
  catch (e) { if (e.status !== 429) driveBlockedUntil = Date.now() + 10 * 60e3; throw e; }
  const r = j.routes && j.routes[0];
  if (!r || r.result_code !== 0) throw new ApiError(502, '카카오 길찾기 결과 없음: ' + (r ? r.result_msg : ''));
  // 숫자로 바꾸기 전에 null·빈값을 걸러 냄 (Number(null)=0 방지) — fin/nn은 아래 경로 조회 부분에 정의
  const sm = r.summary || {}, dur = fin(sm.duration), dis = nn(sm.distance), fare = fin(sm.fare && sm.fare.taxi);
  if (!(dur != null && dur > 0) || dis == null) throw new ApiError(502, '카카오 길찾기 응답의 시간·거리가 올바르지 않아요');   // null·음수는 정상 응답으로 쓰지 않음
  return { durationSec: dur, distanceM: dis, taxiFare: fare != null && fare > 0 ? fare : null, path: drivePath(r), at: Date.now() };   // path: 지도 표시용 (update14)
}

/* ---------- 4. 브라우저에 줄 설정 (카카오 JavaScript 키는 원래 공개용) ---------- */
async function config() {
  const rest = !!env('KAKAO_REST_KEY') && env('MOCK') !== '1';
  return { kakaoJsKey: env('KAKAO_JS_KEY') || null, mock: isMock(), drive: rest, search: rest, route: rest,
    tashu: !!env('TASHU_KEY') && env('MOCK') !== '1' };
}

/* ---------- 5. 장소 검색 (카카오 로컬 키워드 검색 · REST 키) ---------- */
async function search(q) {
  const query = String(q.q || '').trim().slice(0, 60);
  if (!query) throw new ApiError(400, '검색어가 필요합니다');
  if (!env('KAKAO_REST_KEY') || env('MOCK') === '1') throw new ApiError(501, '카카오 REST 키가 없거나 예시 데이터 모드라 검색할 수 없어요');
  // 카카오 검색 결과는 서버에도 브라우저에도 저장·재사용하지 않습니다 (update11 팀 결정, 카카오 devtalk 151980).
  const u = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  u.searchParams.set('query', query); u.searchParams.set('x', '127.385'); u.searchParams.set('y', '36.350');
  u.searchParams.set('radius', '20000'); u.searchParams.set('size', '10');
  const j = JSON.parse(await fetchText(u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` }));
  return { places: (j.documents || []).map((d) => ({ name: d.place_name, address: d.road_address_name || d.address_name, lat: Number(d.y), lng: Number(d.x) })) };
}

/* ---------- 5-0. 출발지 근처 지하철역 (카카오 로컬 '카테고리로 장소 검색' SW8 · update12) ---------- */
// 공식 명세(developers.kakao.com/docs/ko/local/dev-guide): GET dapi.kakao.com/v2/local/search/category.json,
//   category_group_code=SW8(지하철역), x=경도·y=위도, radius 0~20000m, size 1~15, sort=distance(x·y 필요), documents[].distance는 미터(문자열)
// 복합경로의 환승역 후보를 찾는 데 씀. 카카오 결과는 저장·재사용하지 않음(no-store, 서버 캐시 없음). 하루 한도는 kakao_search와 같이 셈
async function stations(q) {
  const lat = num(q.lat, 'lat'), lng = num(q.lng, 'lng');
  inDaejeon(lat, lng);
  const radius = Math.round(Math.min(Math.max(Number(q.r) || 4000, 500), 5000));
  if (!env('KAKAO_REST_KEY') || env('MOCK') === '1') throw new ApiError(501, '카카오 REST 키가 없거나 예시 데이터 모드라 지하철역을 찾을 수 없어요');
  const u = new URL('https://dapi.kakao.com/v2/local/search/category.json');
  u.searchParams.set('category_group_code', 'SW8'); u.searchParams.set('x', String(lng)); u.searchParams.set('y', String(lat));
  u.searchParams.set('radius', String(radius)); u.searchParams.set('sort', 'distance'); u.searchParams.set('size', '15');
  let j;
  try { j = JSON.parse(await fetchText(u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` })); } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(502, '카카오 장소 검색 응답을 읽을 수 없어요'); }
  return { radius, stations: (j.documents || []).map((d) => ({ name: String((d && d.place_name) || ''), category: String((d && d.category_name) || ''), lat: fin(d && d.y), lng: fin(d && d.x), d: nn(d && d.distance) }))
    .filter((x) => x.name && pt([x.lng, x.lat])) };
}

/* ---------- 5-1. 카카오맵 경로 조회: 대중교통 · 도보 · 자전거 (REST 키 · update10) ---------- */
// 공식 명세: developers.kakao.com/docs/ko/kakaomap/rest-api (경로 조회). GET, Authorization: KakaoAK {REST 키}
//   start_x/end_x = 경도, start_y/end_y = 위도(WGS84 기본). 출발 시각 파라미터 없음.
// 대중교통 응답에는 정류장·역 ID가 없고 이름(stops[].name)과 경로 좌표(path.points)만 있습니다.
//   → TAGO 정류장 연결은 화면(app.js)에서 '이름 + 좌표 거리'로 확인하고, 안 맞으면 연결하지 않습니다.
// 카카오 결과는 서버에 저장하지 않습니다(카카오 정책: 실시간 호출만, 사용자 간 공유 캐시 금지).
const ROUTE_URL = {
  transit: 'https://dapi.kakao.com/v2/routing/publictraffic',
  walk: 'https://dapi.kakao.com/v2/routing/walk',
  bike: 'https://dapi.kakao.com/v2/routing/bicycle',
};
const ROUTE_STATUS = {
  STARTNODES_NULL: '출발지 근처에서 대중교통 정류장을 찾지 못했어요', ENDNODES_NULL: '도착지 근처에서 대중교통 정류장을 찾지 못했어요',
  EQUAL_POINTS: '출발지와 도착지가 같아요', SAME_POINT: '출발지와 도착지가 같아요', INVALID_REQUEST: '잘못된 요청이에요',
  NO_RESULTS: '경로 결과가 없어요', ROUTE_RESULT_NOT_FOUND: '경로 결과가 없어요', START_LINK_NOT_FOUND: '출발지 주변 길을 찾지 못했어요',
  END_LINK_NOT_FOUND: '도착지 주변 길을 찾지 못했어요', TOO_MANY_SEARCH_LINK: '경로 탐색 범위를 넘었어요', TOO_FAR_AWAY: '출발지와 도착지가 너무 멀어요',
};
const routeBlockedUntil = { transit: 0, walk: 0, bike: 0 };
function routePair(q) {
  const o = { lat: num(q.olat, 'olat'), lng: num(q.olng, 'olng') }, d = { lat: num(q.dlat, 'dlat'), lng: num(q.dlng, 'dlng') };
  inDaejeon(o.lat, o.lng, '출발지'); inDaejeon(d.lat, d.lng, '도착지');
  return { o, d };
}
function routeUrl(kind, o, d) {
  const u = new URL(ROUTE_URL[kind]);
  u.searchParams.set('start_x', String(o.lng)); u.searchParams.set('start_y', String(o.lat));
  u.searchParams.set('end_x', String(d.lng)); u.searchParams.set('end_y', String(d.lat));
  return u;
}
async function kakaoRoute(kind, q) {
  const { o, d } = routePair(q);
  if (!env('KAKAO_REST_KEY') || env('MOCK') === '1') throw new ApiError(501, '카카오 REST 키가 없거나 예시 데이터 모드라 길찾기를 쓸 수 없어요');
  if (Date.now() < routeBlockedUntil[kind]) throw new ApiError(503, '카카오 길찾기를 잠시 쓸 수 없어요 (권한·한도 확인)');
  let j;
  try {
    const text = await fetchText(routeUrl(kind, o, d), { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` });
    try { j = JSON.parse(text); } catch { throw new ApiError(502, '카카오 길찾기 응답을 읽을 수 없어요'); }
  } catch (e) { if (e.status !== 429 && e.status !== 503) routeBlockedUntil[kind] = Date.now() + 10 * 60e3; throw e; } // 권한 없음 등은 10분간 다시 부르지 않음
  if (j.status !== 'OK') throw new ApiError(404, `카카오 길찾기: ${ROUTE_STATUS[j.status] || j.status || '결과 없음'}`);
  return j;
}
// null·빈값·음수·비정상 좌표는 정상 값으로 쓰지 않음 (Number(null)=0 이 되는 것 방지)
const fin = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const nn = (v) => { const x = fin(v); return x != null && x >= 0 ? x : null; };
const pt = (p) => { if (!Array.isArray(p) || p.length < 2) return null; const lng = fin(p[0]), lat = fin(p[1]);
  return lat != null && lng != null && lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132 ? { lat, lng } : null; };   // 한국 범위 밖은 비정상
// 진행 방향 확인용: 경로 시작점에서 15m 이상 떨어진 첫 좌표 (정류장이 도로 어느 쪽인지 판단)
// 진행 방향(a → head) 기준으로 p가 도로 오른쪽/왼쪽인지 (app.js sideOf와 같은 계산). 2m 미만이면 판단하지 않음
function sideOf(a, head, p) {
  const kx = Math.cos(a.lat * Math.PI / 180) * 111320, ky = 110540;
  const hx = (head.lng - a.lng) * kx, hy = (head.lat - a.lat) * ky, vx = (p.lng - a.lng) * kx, vy = (p.lat - a.lat) * ky, hl = Math.hypot(hx, hy);
  if (hl < 5) return null;
  const lateral = (hx * vy - hy * vx) / hl;
  return Math.abs(lateral) < 2 ? null : lateral < 0 ? 'right' : 'left';
}
function headPt(pts) { const a = pt(pts[0]); if (!a) return null; for (const q of pts.slice(1, 60)) { const b = pt(q); if (b && meters(a, b) >= 15) return b; } return null; }
// 지도 표시용 경로 좌표 (update14): 카카오 경로 좌표([경도,위도] 목록)를 화면에 그릴 만큼만 줄여서 [[위도,경도], …]로 돌려줌
//   비정상 좌표(한국 범위 밖·숫자 아님)는 버리고, 연속 중복 제거 → 직선에 가까운 점 생략(허용 오차 PATH_TOL_M) → 그래도 많으면 고르게 솎기(양 끝 유지)
//   소수 5자리(약 1m)로 반올림. 점이 2개 미만이면 null (경로 표시만 생략, 시간·요금 계산에는 영향 없음)
const PATH_TOL_M = 5, PATH_MAX = { step: 60, leg: 150, drive: 150 };
function simplifyPath(raw, max) {
  if (!Array.isArray(raw)) return null;
  const a = [];
  for (const q of raw) { const p = pt(q); if (p && !(a.length && a[a.length - 1].lat === p.lat && a[a.length - 1].lng === p.lng)) a.push(p); }
  if (a.length < 2) return null;
  // 더글러스-포이커 (반복문, 평면 근사 미터 단위)
  const kx = Math.cos(a[0].lat * Math.PI / 180) * 111320, ky = 110540;
  const xy = a.map((p) => [p.lng * kx, p.lat * ky]), keep = new Uint8Array(a.length);
  keep[0] = keep[a.length - 1] = 1;
  const stack = [[0, a.length - 1]];
  while (stack.length) {
    const [s0, e0] = stack.pop();
    const [x1, y1] = xy[s0], [x2, y2] = xy[e0], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let k = s0 + 1; k < e0; k++) {
      const [x, y] = xy[k];
      const d = L < 1e-9 ? Math.hypot(x - x1, y - y1) : Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / L;
      if (d > best) { best = d; bi = k; }
    }
    if (bi > 0 && best > PATH_TOL_M) { keep[bi] = 1; stack.push([s0, bi], [bi, e0]); }
  }
  let out = a.filter((_, k) => keep[k]);
  if (out.length > max) { const n = out.length, pick = []; for (let k = 0; k < max; k++) pick.push(out[Math.round(k * (n - 1) / (max - 1))]); out = pick; }
  return out.map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
}
// 카카오모빌리티(택시) 응답: sections[].roads[].vertexes = [x1, y1, x2, y2, …] (경도·위도 번갈아)
function drivePath(route) {
  const raw = [];
  for (const sec of (route && route.sections) || []) for (const rd of (sec && sec.roads) || []) {
    const v = rd && rd.vertexes; if (!Array.isArray(v)) continue;
    for (let k = 0; k + 1 < v.length; k += 2) raw.push([v[k], v[k + 1]]);
  }
  return simplifyPath(raw, PATH_MAX.drive);
}
// 카카오맵 도보·자전거 응답: route.legs[].steps[].path.points
function legPath(j) {
  const raw = [];
  for (const lg of (j && j.route && j.route.legs) || []) for (const st of (lg && lg.steps) || []) { const pts = st && st.path && st.path.points; if (Array.isArray(pts)) raw.push(...pts); }
  return simplifyPath(raw, PATH_MAX.leg);
}
// 대중교통 응답 → 필요한 항목만. 시간은 초. totalSec은 참고용(대기 포함 여부가 명세에 없음) — 화면은 구간 시간만 씁니다.
function parseTransit(j) {
  const routes = (j.routes || []).map((r) => {
    const p = r.properties || {};
    return {
      type: String(p.type || ''), totalSec: nn(p.totalTime), distanceM: nn(p.totalDistance), transfers: nn(p.transfers),
      fare: p.fare && fin(p.fare.value) > 0 ? fin(p.fare.value) : null,
      // 노선별 요금이 다른 버스가 섞이면 value 없이 min·max만 옴 (2026-11-17 실제 응답 확인)
      fareMin: p.fare && fin(p.fare.min) > 0 ? fin(p.fare.min) : null, fareMax: p.fare && fin(p.fare.max) > 0 ? fin(p.fare.max) : null,
      steps: (r.steps || []).map((s) => {
        const sp = s.properties || {}, pts = (s.path && s.path.points) || [];
        return {
          type: String(sp.type || ''), sec: nn(sp.time), m: nn(sp.distance), guidance: String(sp.guidance || ''),
          stops: (sp.stops || []).map((x) => String((x && x.name) || '')),
          vehicles: (sp.vehicles || []).map((v) => ({ name: String((v && v.name) || ''), type: String((v && v.type) || '') })),
          start: pt(pts[0]), head: headPt(pts), end: pt(pts[pts.length - 1]),
          path: simplifyPath(pts, PATH_MAX.step),   // 지도 표시용 (update14)
        };
      }),
    };
  }).filter((r) => r.steps.length && r.steps.every((s) => s.sec != null && s.m != null && ['WALKING', 'BUS', 'SUBWAY'].includes(s.type) && (s.type === 'WALKING' || s.stops.filter(Boolean).length >= 2)));
  if (!routes.length) throw new ApiError(404, '카카오 길찾기: 쓸 수 있는 대중교통 경로가 없어요');
  return routes;
}
async function transit(q) {
  const j = await kakaoRoute('transit', q);
  return { at: Date.now(), routes: parseTransit(j) };
}
function parseLeg(j) {
  const p = (j.route && j.route.properties) || {};
  const sec = nn(p.totalTime), m = nn(p.totalDistance);
  if (sec == null || m == null) throw new ApiError(502, '카카오 길찾기 응답의 소요시간·거리가 올바르지 않아요');
  return { sec, m, path: legPath(j) };   // path: 지도 표시용 (update14), 없으면 null
}
async function walk(q) { return { at: Date.now(), ...parseLeg(await kakaoRoute('walk', q)) }; }
async function bike(q) { return { at: Date.now(), ...parseLeg(await kakaoRoute('bike', q)) }; }

/* ---------- 6. 타슈 대여소 실시간 자전거 수 (타슈 Open API · api-token 헤더) ---------- */
async function tashuStations() {
  return cached('tashu:all', 60e3, async () => {
    const text = await fetchText('https://bikeapp.tashu.or.kr:50041/v1/openapi/station', { 'api-token': env('TASHU_KEY') });
    let j; try { j = JSON.parse(text); } catch { throw new ApiError(502, '타슈 API 응답을 읽을 수 없어요'); }
    const list = Array.isArray(j) ? j : (j.results || j.result || j.data || []);
    return list.map((r) => {
      let a = Number(r.x_pos), b = Number(r.y_pos);
      if (a > 100 && b < 100) [a, b] = [b, a]; // 문서상 x_pos=위도지만, 반대로 오면 바로잡기
      return { id: String(r.id), name: String(r.name || ''), lat: a, lng: b, bikes: r.parking_count == null || r.parking_count === '' ? NaN : Number(r.parking_count), address: r.address || '' };
    }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && Number.isFinite(r.bikes) && r.bikes >= 0);   // 자전거 수가 비거나 음수면 제외
  });
}
function meters(a, b) {
  const R = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function tashu(q) {
  const p = { lat: num(q.lat, 'lat'), lng: num(q.lng, 'lng') };
  inDaejeon(p.lat, p.lng);
  const radius = Math.min(Number(q.radius) || 800, 2000);
  let all, mock = false;
  if (!env('TASHU_KEY') || env('MOCK') === '1') {
    mock = true;
    all = [0, 1, 2].map((i) => ({ id: `M${i}`, name: `(예시) 타슈 대여소 ${i + 1}`, lat: p.lat + 0.0015 * (i + 1), lng: p.lng - 0.001 * i, bikes: [4, 0, 7][i], address: '' }));
  } else all = await tashuStations();
  const stations = all.map((s) => ({ ...s, d: Math.round(meters(p, s)) })).filter((s) => s.d <= radius).sort((a, b) => a.d - b.d).slice(0, 8);
  return { mock, at: Date.now(), stations };
}

/* ---------- 키 없을 때 쓰는 예시 데이터 ---------- */
function mockStops(lat, lng) {
  const names = ['(예시) 충남대학교', '(예시) 충남대공과대학', '(예시) 궁동네거리', '(예시) 유성온천역'];
  return names.map((name, i) => ({ id: `MOCK${i + 1}`, name, no: String(41000 + i), city: '25',
    lat: lat + [0.0012, -0.0008, 0.0021, -0.0026][i], lng: lng + [0.0009, -0.0015, -0.0006, 0.0019][i] }));
}
function mockArrivals(seed) {
  const s = [...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const tick = Math.floor(Date.now() / 1000);
  const routes = ['108', '102', '104', '급행2', '706', '113'];
  return routes.slice(0, 3 + (s % 3)).map((routeNo, i) => {
    const cycle = 600 + i * 180, arrSec = (cycle - ((tick + s * 37 + i * 211) % cycle)) + 30;
    return { routeNo, routeId: `MOCKR${i}`, arrSec, prevCnt: Math.max(1, Math.round(arrSec / 110)), vehicleType: '일반차량' };
  }).sort((a, b) => a.arrSec - b.arrSec);
}

/* ---------- 5. API 점검 (/health.html) — 키별 정상 여부와 원본 응답 앞부분(키는 가림) ---------- */
function maskKeys(s) {
  let out = String(s);
  for (const k of ['DATA_GO_KR_KEY', 'KAKAO_REST_KEY', 'KAKAO_JS_KEY', 'TASHU_KEY']) {
    const v = env(k);
    if (v) for (const form of [v, encodeURIComponent(v)]) out = out.split(form).join('***');
  }
  return out;
}
async function rawFetch(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const t0 = Date.now();
  try {
    await reserve(quotaFor(url));
    const r = await fetch(url, { headers, signal: ctl.signal });
    return { http: r.status, text: await r.text(), ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof ApiError) return { http: 0, text: `(${e.message})`, ms: Date.now() - t0 };
    return { http: 0, text: e.name === 'AbortError' ? '(응답 시간 초과)' : `(연결 실패: ${e.message})`, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}
async function check(name, url, headers, judge) {
  const r = await rawFetch(url, headers);
  let ok = false, message = '';
  try { ({ ok, message } = judge(r)); } catch (e) { ok = false; message = e.message; }
  const out = { name, ok, message, http: r.http, ms: r.ms, url: maskKeys(url), raw: maskKeys(r.text.slice(0, 700)) };
  Object.defineProperty(out, 'full', { value: r.text, enumerable: false }); // JSON 응답에는 안 나감
  return out;
}
function tagoJudge(label) {
  return (r) => {
    if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — 키가 틀렸거나 이 API 활용신청이 안 됐을 수 있어요` };
    const items = tagoItems(r.text);
    return { ok: true, message: `정상 · ${label} ${items.length}건` };
  };
}

async function health(q) {
  if (process.env.VERCEL && (!env('HEALTH_TOKEN') || String(q.token || '') !== env('HEALTH_TOKEN')))
    throw new ApiError(404, '배포 환경에서는 API 점검이 꺼져 있어요 (HEALTH_TOKEN 필요)');
  const keys = { DATA_GO_KR_KEY: !!env('DATA_GO_KR_KEY'), KAKAO_JS_KEY: !!env('KAKAO_JS_KEY'), KAKAO_REST_KEY: !!env('KAKAO_REST_KEY'), TASHU_KEY: !!env('TASHU_KEY'),
    DJ_SUBWAY_TEST_URL: !!env('DJ_SUBWAY_TEST_URL'), DJ_STNDIST_URL: !!env('DJ_STNDIST_URL'), MOCK: env('MOCK') === '1' };
  const checks = [];
  if (keys.MOCK) return { keys, checks, note: '예시 데이터 모드(MOCK=1)라 외부 API 점검을 하지 않았어요. .env에서 MOCK=0으로 바꾸고 다시 실행하세요.' };
  if (!keys.DATA_GO_KR_KEY) return { keys, checks, note: '.env에 DATA_GO_KR_KEY가 없어 공공데이터 점검을 건너뛰었어요.' };
  const lat = Number(q.lat) || ORIGIN.lat, lng = Number(q.lng) || ORIGIN.lng;
  inDaejeon(lat, lng, '점검 위치');

  // 1) 근처 정류장 (TAGO 버스정류소정보 — 별도 활용신청 필요)
  const near = await check('TAGO 버스정류소정보 (근처 정류장 찾기)',
    dataGoUrl('https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList', { gpsLati: lat, gpsLong: lng, numOfRows: 10, pageNo: 1, _type: 'json' }),
    {}, tagoJudge('정류장'));
  let firstNode = null;
  try {
    const it = tagoItems(near.full);
    const dj = it.filter((x) => String(x.citycode) === DAEJEON_CITY_CODE); // 같은 정류장이 계룡(GRB)·대전(DJB) 코드로 중복 → 대전만
    firstNode = dj[0] ? String(dj[0].nodeid) : null;
    if (dj.length) near.message += ` · 대전 정류장 ${dj.length}곳 · 예: ` + dj.slice(0, 3).map((x) => `${x.nodenm}(${x.nodeid}, 번호 ${x.nodeno})`).join(', ');
  } catch { /* 위에서 실패로 판정됨 */ }
  checks.push(near);

  // 2) 실시간 도착 (TAGO 버스도착정보)
  const nodeId = String(q.nodeId || firstNode || 'DJB8001793');
  checks.push(await check(`TAGO 버스도착정보 (정류장 ${nodeId})`,
    dataGoUrl('https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList', { cityCode: DAEJEON_CITY_CODE, nodeId, numOfRows: 20, pageNo: 1, _type: 'json' }),
    {}, tagoJudge('도착 예정 버스')));

  // 3) 대전시 정류소별 도착정보 (정류장 번호 arsId)
  const arsId = String(q.arsId || '').replace(/\D/g, '') || '40720';
  checks.push(await check(`대전시 정류소별 도착정보 (정류장 번호 ${arsId})`,
    dataGoUrl(env('DJ_ARRIVAL_URL') || 'https://apis.data.go.kr/6300000/arrive/getArrInfoByUid', { arsId }), {},
    (r) => {
      if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — 주소나 키를 확인하세요` };
      if (/<returnAuthMsg>|<errMsg>/.test(r.text) && !/<returnAuthMsg>\s*NORMAL/i.test(r.text)) return { ok: false, message: explainXmlError(r.text) };
      const n = xmlBlocks(r.text).length;
      return { ok: true, message: n ? `정상 · 도착 예정 ${n}건` : '응답은 왔지만 도착 항목을 못 찾았어요 (정류장 번호 또는 항목 이름 확인 필요 — 아래 원본을 보내 주세요)' };
    }));

  // 3-0) TAGO 버스노선정보 (update12): 108번 노선 목록 → 첫 노선의 경유 정류장 (원본 형식·건수·updowncd 확인)
  {
    const lr = await check('TAGO 버스노선정보 — 노선번호목록 (108번)', dataGoUrl(`${ROUTE_BASE}/${ROUTE_OPS.list}`, { cityCode: DAEJEON_CITY_CODE, routeNo: '108', numOfRows: 20, pageNo: 1, _type: 'json' }), {}, (r) => {
      if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — 버스노선정보 활용신청·주소를 확인하세요` };
      const b = tagoBody(r.text);
      return { ok: true, message: `정상 · 전체 ${b.total}건 · ` + b.items.map((x) => `${x.routeno}(${x.routeid}, ${x.startnodenm}↔${x.endnodenm})`).join(', ') };
    });
    checks.push(lr);
    try {
      const first = tagoBody(lr.full).items.find((x) => String(x.routeno) === '108');
      if (first) checks.push(await check(`TAGO 버스노선정보 — 노선별경유정류소 (${first.routeid})`, dataGoUrl(`${ROUTE_BASE}/${ROUTE_OPS.stops}`, { cityCode: DAEJEON_CITY_CODE, routeId: first.routeid, numOfRows: 100, pageNo: 1, _type: 'json' }), {}, (r) => {
        if (r.http !== 200) return { ok: false, message: `HTTP ${r.http}` };
        const b = tagoBody(r.text), ud = b.items.filter((x) => x.updowncd !== undefined && x.updowncd !== '').length;
        return { ok: true, message: `정상 · 전체 ${b.total}건 · 이번 쪽 ${b.items.length}건 · updowncd 있는 행 ${ud} · 예: ` + b.items.slice(0, 3).map((x) => `${x.nodeord}.${x.nodenm}(${x.nodeid}, 번호 ${x.nodeno}, 상하행 ${x.updowncd})`).join(' / ') };
      }));
    } catch { /* 위에서 실패로 판정됨 */ }
  }

  // 3-1) 108번 타는 정류장 찾기 — 근처 대전 정류장마다 도착정보를 조회해 노선·행선지를 모읍니다
  try {
    const route = String(q.route || '108');
    const t = await fetchTago(dataGoUrl('https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList', { gpsLati: lat, gpsLong: lng, numOfRows: 40, pageNo: 1, _type: 'json' }));
    const seen = new Set();
    const stops = tagoItems(t).filter((x) => String(x.citycode) === DAEJEON_CITY_CODE && !seen.has(x.nodeid) && seen.add(x.nodeid))
      .map((x) => ({ nodeId: String(x.nodeid), arsId: String(x.nodeno || ''), name: String(x.nodenm), lat: Number(x.gpslati), lng: Number(x.gpslong), m: Math.round(meters({ lat, lng }, { lat: Number(x.gpslati), lng: Number(x.gpslong) })) }))
      .filter((x) => x.m <= 700).sort((a, b) => a.m - b.m).slice(0, 10);
    const found = await Promise.all(stops.map(async (sp) => {
      const r = { ...sp, routes: [], hit: [] };
      try {
        const xml = sp.arsId ? await fetchText(dataGoUrl(env('DJ_ARRIVAL_URL') || 'https://apis.data.go.kr/6300000/arrive/getArrInfoByUid', { arsId: sp.arsId })) : '';
        for (const b of xmlBlocks(xml)) {
          // EXTIME_MIN은 차고지 대기 등에서 틀린 값이 와서(1분 vs SEC 2010초) 초 단위를 우선 사용
          const no = xmlField(b, 'ROUTE_NO'), dest = xmlField(b, 'DESTINATION'), sec = Number(xmlField(b, 'EXTIME_SEC'));
          const min = Number.isFinite(sec) && sec > 0 ? Math.round(sec / 60) : xmlField(b, 'EXTIME_MIN');
          r.routes.push(no);
          if (no === route) r.hit.push(`${dest} 방면 ${min}분 후`);
        }
      } catch (e) { r.err = e.message; }
      try {
        const tt = await fetchTago(dataGoUrl('https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList', { cityCode: DAEJEON_CITY_CODE, nodeId: sp.nodeId, numOfRows: 60, pageNo: 1, _type: 'json' }));
        const items = tagoItems(tt); r.tagoCnt = items.length;
        for (const it of items) { const no = String(it.routeno); if (!r.routes.includes(no)) r.routes.push(no); if (no === route) r.hit.push(`TAGO ${Math.round(Number(it.arrtime) / 60)}분 후`); }
      } catch (e) { r.err = (r.err ? r.err + ' / ' : '') + e.message; }
      return r;
    }));
    const hits = found.filter((x) => x.hit.length);
    checks.push({ name: `${route}번 타는 정류장 찾기 (반경 700m 대전 정류장 ${found.length}곳)`, ok: found.length > 0,
      message: hits.length ? `${route}번 도착정보가 있는 정류장: ` + hits.map((x) => `${x.name}(번호 ${x.arsId}, ${x.nodeId}, ${x.m}m) → ${x.hit.join(', ')}`).join(' / ')
        : `지금은 ${route}번이 다가오는 정류장이 없어요. 운행 시간대(낮)에 다시 점검해 주세요.`,
      http: 200, ms: 0, url: '(여러 API 조합)',
      raw: found.map((x) => `${x.name} | 번호 ${x.arsId} | ${x.nodeId} | ${x.m}m | (${x.lat}, ${x.lng}) | 노선: ${x.routes.join(',') || '없음'}${x.hit.length ? ' | ★ ' + x.hit.join(', ') : ''}${x.err ? ' | 오류: ' + x.err : ''}`).join('\n') });
  } catch (e) {
    checks.push({ name: '108번 타는 정류장 찾기', ok: false, message: e.message, http: 0, ms: 0, url: '', raw: '' });
  }

  // 4) 카카오 길찾기 (선택)
  if (keys.KAKAO_REST_KEY) {
    const u = `https://apis-navi.kakaomobility.com/v1/directions?origin=${ORIGIN.lng},${ORIGIN.lat}&destination=127.4343,36.3324&priority=RECOMMEND`;
    checks.push(await check('카카오모빌리티 길찾기 (택시)', u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` }, (r) => {
      if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — REST 키 또는 길찾기 사용 권한을 확인하세요` };
      const j = JSON.parse(r.text); const s = j.routes && j.routes[0] && j.routes[0].summary;
      const dp = s ? drivePath(j.routes[0]) : null;
      return s ? { ok: true, message: `정상 · 공대→대전역 ${Math.round(s.duration / 60)}분, 택시 ${s.fare && s.fare.taxi}원 · 지도용 경로 좌표 ${dp ? dp.length : 0}점` } : { ok: false, message: '경로 없음' };
    }));
  }

  // 4-0) 근처 지하철역 (update12 · 카카오 카테고리 SW8 1회) — 복합경로 환승역 후보의 원본 이름·좌표·거리 확인용
  if (keys.KAKAO_REST_KEY) {
    const u = `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=SW8&x=${lng}&y=${lat}&radius=4000&sort=distance&size=15`;
    checks.push(await check('카카오 근처 지하철역 (카테고리 SW8, 반경 4km)', u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` }, (r) => {
      if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — REST 키 또는 앱의 카카오맵 사용 설정을 확인하세요` };
      const d = JSON.parse(r.text).documents || [];
      const mapped = d.map((x) => { const tok = String(x.place_name || '').split(/\s+/).map((t) => t.replace(/\(.*?\)/g, '')).find((t) => /역$/.test(t)); const no = tok ? STATION_NO[tok.replace(/역$/, '')] : null; return `${x.place_name}(${x.distance}m${no ? ' → ' + no : ' → 역번호 없음'})`; });
      return { ok: true, message: `정상 · ${d.length}곳 · ` + mapped.join(', ') };
    }));
  }
  // 4-1) 카카오 장소 검색
  if (keys.KAKAO_REST_KEY) {
    const u = 'https://dapi.kakao.com/v2/local/search/keyword.json?query=' + encodeURIComponent('충남대학교 공과대학3호관') + '&size=3';
    checks.push(await check('카카오 로컬 장소 검색', u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` }, (r) => {
      if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — REST 키 또는 앱의 '카카오맵' 사용 설정을 확인하세요` };
      const d = JSON.parse(r.text).documents || [];
      return { ok: true, message: `정상 · ${d.length}건${d[0] ? ' · 예: ' + d[0].place_name + ` (${d[0].y}, ${d[0].x})` : ''}` };
    }));
  }
  // 4-3) 카카오맵 경로 조회 (update10) — 응답 구조, 대기시간 포함 여부(구간 합 vs 전체), 정류장·역 이름, TAGO 정류장 연결 확인
  if (keys.KAKAO_REST_KEY) {
    const auth = { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` };
    const o = { lat, lng }, dst = { lat: 36.3324, lng: 127.4343 }, hub = { lat: 36.3583, lng: 127.3638 };
    const tc = await check('카카오 대중교통 경로 조회 (출발점 → 대전역)', routeUrl('transit', o, dst).toString(), auth, (r) => {
      if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — REST 키, 앱의 [카카오맵] 사용 설정(ON), 하루 무료량(1,000건)을 확인하세요` };
      const j = JSON.parse(r.text);
      if (j.status !== 'OK') return { ok: false, message: `status ${j.status} — ${ROUTE_STATUS[j.status] || ''}` };
      const pr = parseTransit(j), pc = pr.map((rt) => rt.steps.reduce((a, st) => a + (st.path ? st.path.length : 0), 0)), noPath = pr.reduce((a, rt) => a + rt.steps.filter((st) => !st.path).length, 0);
      return { ok: true, message: `정상 · 경로 ${pr.length}개 · 지도용 경로 좌표(경로별) ${pc.join('/')}점 · 좌표 없는 구간 ${noPath}개 · properties ${JSON.stringify(j.properties || {}).slice(0, 200)}` };
    });
    checks.push(tc);
    let routes = [];
    try { routes = parseTransit(JSON.parse(tc.full)); } catch { /* 위에서 실패로 판정됨 */ }
    if (routes.length) {
      const fmtStep = (s) => `${s.type} ${s.sec}초 ${s.m}m${s.vehicles.length ? ' [' + s.vehicles.map((v) => `${v.name}(${v.type})`).join(', ') + ']' : ''}${s.stops.length ? ` ${s.stops[0]}→${s.stops[s.stops.length - 1]} (${s.stops.length}곳)` : ''}${s.start ? ` 시작(${s.start.lat.toFixed(5)},${s.start.lng.toFixed(5)})` : ''}${s.guidance ? ' «' + s.guidance + '»' : ''}`;
      tc.raw = routes.slice(0, 5).map((rt, i) => {
        const sum = rt.steps.reduce((a, s) => a + s.sec, 0);
        return `#${i + 1} ${rt.type} · totalTime ${rt.totalSec}초 · 구간 합 ${sum}초 · 차이 ${rt.totalSec - sum}초 · 요금 ${rt.fare} · 환승 ${rt.transfers}\n   ` + rt.steps.map(fmtStep).join('\n   ');
      }).join('\n') + '\n--- 원본 앞부분 ---\n' + tc.raw;
      // 탑승 정류장 이름·좌표 ↔ TAGO 정류장 연결 확인 (경로 2개까지, TAGO 정류소 조회 최대 2회)
      const norm = (t) => String(t || '').replace(/\(.*?\)/g, '').replace(/[\s.·ㆍ-]/g, '');
      const lines = [];
      for (const rt of routes.slice(0, 2)) {
        const b = rt.steps.find((s) => s.type === 'BUS');
        if (!b || !b.start) { lines.push(`${rt.type}: 버스 구간 없음`); continue; }
        try {
          const it = tagoItems(await fetchTago(dataGoUrl('https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList', { gpsLati: b.start.lat.toFixed(4), gpsLong: b.start.lng.toFixed(4), numOfRows: 20, pageNo: 1, _type: 'json' })))
            .filter((x) => String(x.citycode) === DAEJEON_CITY_CODE)
            .map((x) => { const q = { lat: Number(x.gpslati), lng: Number(x.gpslong) }; return { name: String(x.nodenm), id: String(x.nodeid), no: String(x.nodeno || ''), m: Math.round(meters(b.start, q)), side: b.head ? sideOf(b.start, b.head, q) : null }; })
            .sort((x, y) => x.m - y.m).slice(0, 6);
          lines.push(`카카오 탑승 '${b.stops[0]}' [${b.vehicles.map((v) => v.name).join(',')}] → TAGO 후보: ` + it.map((x) => `${norm(x.name) === norm(b.stops[0]) ? '★' : ''}${x.name}(${x.id}, 번호 ${x.no}, ${x.m}m, 진행방향 ${x.side === 'right' ? '오른쪽' : x.side === 'left' ? '왼쪽' : '판단 불가'})`).join(' / '));
        } catch (e) { lines.push(`'${b.stops[0]}' TAGO 조회 실패: ${e.message}`); }
      }
      lines.push('※ ★=이름 일치. 우측통행이라 맞는 방향 정류장은 보통 진행방향 오른쪽. 방향을 확인한 정류장 ID는 scenario.js bus.verifiedStops에 노선별로 넣어 주세요');
      checks.push({ name: '카카오 탑승 정류장 ↔ TAGO 정류장 연결 (이름+좌표+방향)', ok: lines.some((x) => x.includes('★')), message: lines.some((x) => x.includes('★')) ? '이름이 같은 TAGO 정류장을 찾았어요(★). 거리·방향이 맞는지 확인해 주세요' : '이름이 같은 TAGO 정류장을 찾지 못했어요 — 아래 결과를 보내 주세요', http: 200, ms: 0, url: '(여러 API 조합)', raw: lines.join('\n') });
    }
    for (const [kind, label] of [['walk', '도보'], ['bike', '자전거']]) {
      checks.push(await check(`카카오 ${label} 경로 조회 (출발점 → 월평역)`, routeUrl(kind, o, hub).toString(), auth, (r) => {
        if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — REST 키, [카카오맵] 사용 설정, 하루 무료량을 확인하세요` };
        const j = JSON.parse(r.text);
        if (j.status !== 'OK') return { ok: false, message: `status ${j.status} — ${ROUTE_STATUS[j.status] || ''}` };
        const g = parseLeg(j);
        return { ok: true, message: `정상 · ${Math.round(g.sec / 60)}분 (${g.sec}초) · ${g.m}m · 지도용 경로 좌표 ${g.path ? g.path.length : 0}점` };
      }));
    }
    // 출발지 좌표 확인: 카카오 장소 검색 상위 3건 (scenario.js origins에 넣을 좌표)
    const lines = [];
    for (const qy of ['욧골공원', '학사마을 유성구', '충남대학교 서문']) {
      const u = 'https://dapi.kakao.com/v2/local/search/keyword.json?query=' + encodeURIComponent(qy) + '&x=127.345&y=36.366&radius=5000&size=3';
      const r = await rawFetch(u, auth);
      try { lines.push(`'${qy}': ` + (JSON.parse(r.text).documents || []).map((d) => `${d.place_name} | ${d.road_address_name || d.address_name} | ${d.category_name} | (${d.y}, ${d.x})`).join(' / ') || '결과 없음'); }
      catch { lines.push(`'${qy}': HTTP ${r.http} ${maskKeys(r.text.slice(0, 120))}`); }
    }
    checks.push({ name: '출발지 좌표 확인 (카카오 장소 검색)', ok: lines.every((x) => !x.includes('HTTP')), message: '각 출발지 후보 상위 3건 — 맞는 장소의 좌표를 scenario.js origins에 넣어 주세요', http: 200, ms: 0, url: '(카카오 로컬 3회)', raw: lines.join('\n') });
  }
  // 4-2) 타슈
  if (keys.TASHU_KEY) {
    checks.push(await check('타슈 대여소 실시간', 'https://bikeapp.tashu.or.kr:50041/v1/openapi/station', { 'api-token': env('TASHU_KEY') }, (r) => {
      if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — 타슈 키를 확인하세요` };
      const j = JSON.parse(r.text); const list = Array.isArray(j) ? j : (j.results || j.result || j.data || []);
      const f = list[0];
      return { ok: list.length > 0, message: list.length ? `정상 · 대여소 ${list.length}곳 · 예: ${f.name} 자전거 ${f.parking_count}대 (x_pos ${f.x_pos}, y_pos ${f.y_pos})` : '대여소 목록이 비어 있어요' };
    }));
  }

  // 5-0) 대전교통공사 열차시각표 — 방향 검증: 월평(114) 14시대 첫 열차가 대전역(104)에 몇 분 뒤 도착하는지
  checks.push(await check('대전교통공사 열차시각표', dataGoUrl(SUBWAY_URL(), { numOfRows: 3000, pageNo: 1 }), {}, (r) => {
    if (r.http !== 200) return { ok: false, message: `HTTP ${r.http} — 열차시각표 활용신청 여부와 주소를 확인하세요` };
    const map = parseTimetable(r.text);
    const parts = [];
    for (const [d, dn] of [['0', '평일'], ['1', '휴일']]) for (const [dir, nm] of [['0', '판암 방면'], ['1', '반석 방면']]) {
      const o = bestOffset(map[`${d}|${dir}|114`] || [], map[`${d}|${dir}|104`] || []);
      parts.push(`${dn} ${nm}(${dir}): 월평→대전역 ${o.min == null ? '-' : (o.min > 0 ? '+' : '') + o.min + '분'} (일치 ${o.hits}편)`);
    }
    // 1호선 역번호 확인 (update10): 평일 판암 방면에서 각 역 → 대전역(104) 소요시간. 역번호가 클수록 길어야 순서가 맞음
    const seq = [];
    for (let n = 105; n <= 122; n++) { const o = bestOffset(map[`0|0|${n}`] || [], map['0|0|104'] || []); seq.push(`${n}:${o.min == null ? '-' : o.min}`); }
    parts.push('각 역→대전역(분) ' + seq.join(' '));
    return { ok: true, message: `정상 · ${Object.keys(map).length}개 (요일·방향·역) · ` + parts.join(' / ') };
  }));

  // 5) 지하철 시각표 — 공공데이터포털 '미리보기'의 요청 주소를 그대로 넣어 응답 형식 확인
  if (keys.DJ_SUBWAY_TEST_URL) {
    const u = new URL(env('DJ_SUBWAY_TEST_URL'));
    u.searchParams.set('serviceKey', env('DATA_GO_KR_KEY'));
    checks.push(await check('대전교통공사 열차시각표 (테스트 주소)', u.toString(), {}, (r) => ({ ok: r.http === 200, message: r.http === 200 ? '응답 받음 · 아래 원본을 보내 주시면 시각표 계산에 연결할게요' : `HTTP ${r.http}` })));
  }
  // 대전교통공사 역간 소요시간/거리/요금 (update12): 요청 주소(DJ_STNDIST_URL)가 있을 때만 — 월평(114)→대전역(104) 원본 항목 이름·값 확인
  {
    const u = new URL(STNDIST_URL()); u.search = '';
    checks.push(await check('대전교통공사 역간 소요시간/거리/요금 (월평 114 → 대전역 104)', dataGoUrl(u.toString(), { strstnno: 114, endstnno: 104 }), {}, (r) => {
      if (r.http !== 200 || /<errMsg>/.test(r.text)) return { ok: false, message: `HTTP ${r.http} · ${/<errMsg>/.test(r.text) ? explainXmlError(r.text) : '응답 오류'} — 요청 주소·활용신청 확인` };
      const it = xmlItems(r.text), pv = parseStnDist(r.text, '114', '104');
      if (pv.err || pv.incomplete) return { ok: false, message: `응답 검사 실패: ${pv.err || pv.incomplete} (아래 원본 확인)` };
      return { ok: it.length > 0, message: it.length ? `응답 항목 ${it.length}건 · 항목 이름: ${Object.keys(it[0]).join(', ')} · 첫 항목: ${JSON.stringify(it[0]).slice(0, 300)} — 이 원본을 보내 주시면 거리·요금 항목을 확인해 요금 계산에 연결할게요` : '응답은 왔지만 item 항목이 없어요 (아래 원본 확인)' };
    }));
  }
  // 하루 호출량 제한 상태 (공유 저장소가 있으면 전체 인스턴스 합계, 없으면 이 인스턴스 합계)
  {
    const names = Object.keys(QUOTA_DEFAULT), day = kstDay(), store = quotaStore();
    const fmt = (vals) => names.map((n, k) => `${n} ${vals[k] || 0}/${quotaLimit(n)}`).join(', ');
    let ok = true, message;
    if (store) {
      try { message = '공유 저장소 연결됨 · 오늘 전체 호출: ' + fmt(await storeCmd(store, names.map((n) => ['GET', `caw:quota:${day}:${n}`]))); }
      catch (e) { ok = false; message = `공유 저장소 연결 실패 (${e.message}) — ${env('QUOTA_FAIL_OPEN') === '1' ? '제한 없이 통과 중' : '외부 조회가 멈춰 있어요'}`; }
    } else message = '공유 저장소 미설정 → 서버 인스턴스별 합계만 제한됩니다 · 이 인스턴스: ' + fmt(names.map((n) => QUOTA_LOCAL.get(`caw:quota:${day}:${n}`)));
    checks.push({ name: '하루 호출량 제한', ok, message, http: 0, ms: 0, url: '', raw: '' });
  }
  return { keys, checks, at: new Date().toISOString() };
}

/* ---------- Vercel·로컬 서버 공용 래퍼 ---------- */
const HITS = new Map(); // IP별 1분 호출 수 (서버 인스턴스마다 따로 셈 · 과다 호출 방지용)
function rateLimited(req, perMin, name) {
  // 한도가 다른 API(점검 3·길찾기/검색 30·나머지 120)는 서로 따로 셈
  // API마다 따로 셈 (이전에는 한도 값이 같은 택시·검색·대중교통·도보·자전거가 한 묶음 → 화면 1회 로딩 8회라 출발지 몇 번 바꾸면 429, 2026-11-17 실제 확인)
  const ip = `${name || perMin}|` + (String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || '?');
  const now = Date.now(), h = HITS.get(ip);
  if (!h || now - h.t > 60e3) {
    if (HITS.size > 500) for (const [k, v] of HITS) if (now - v.t > 60e3) HITS.delete(k);   // 1분 지난 기록은 지움
    if (HITS.size > 5000) HITS.clear();
    HITS.set(ip, { t: now, n: 1 }); return false;
  }
  return ++h.n > perMin;
}
// cacheSec: 성공 응답을 Vercel CDN에 그 시간만큼 저장 (같은 요청은 외부 API를 다시 부르지 않음)
function handler(fn, { cacheSec = 0, perMin = 120 } = {}) {
  return async (req, res) => {
    const q = req.query || Object.fromEntries(new URL(req.url, 'http://local').searchParams);
    let status = 200, body;
    if (rateLimited(req, perMin, fn.name)) { status = 429; body = { error: '요청이 너무 많아요. 잠시 후 다시 시도하세요' }; }
    else {
      try { body = await fn(q); } catch (e) {
        status = e instanceof ApiError ? e.status : 500;
        body = { error: e instanceof ApiError ? e.message : '서버 오류' };
        if (!(e instanceof ApiError)) console.error(e);
      }
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 불완전한 결과(complete=false)는 성공 응답이어도 CDN에 저장하지 않음 (update12 감사)
    res.setHeader('Cache-Control', status === 200 && cacheSec && !(body && body.complete === false) ? `public, max-age=0, s-maxage=${cacheSec}, stale-while-revalidate=${cacheSec}` : 'no-store');
    res.end(JSON.stringify(body));
  };
}

module.exports = { nearbyStops, arrivals, arrivalsDaejeon, busRoute, stationDist, subway, drive, config, search, stations, transit, walk, bike, tashu, health, handler, ApiError, _test: { tagoItems, simplifyPath, drivePath, legPath, parseTransit, parseLeg, quotaFor, parseStnDist, xmlTree, checkDistItem } };
