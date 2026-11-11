// 공공데이터·카카오 API 호출을 서버에서 대신 처리합니다 (키는 브라우저로 나가지 않음)
const CACHE = new Map();
const DAEJEON_CITY_CODE = '25';
const ORIGIN = { lat: 36.36525, lng: 127.34648 }; // 공대 3호관 (카카오 장소 검색 좌표)

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const env = (k) => (process.env[k] || '').trim();
const isMock = () => env('MOCK') === '1' || !env('DATA_GO_KR_KEY');

async function cached(key, ttlMs, fn) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  CACHE.set(key, { t: Date.now(), v });
  if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value);
  return v;
}

async function fetchText(url, headers = {}) {
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
    catch (e) { if (i >= 2 || !/\(5\d\d\)|시간 초과/.test(e.message)) throw e; } // 포털 일시 오류(500 APPLICATION_ERROR 등)도 재시도
    if (t !== undefined && (i >= 2 || !/"resultCode"\s*:\s*"?99\b/.test(t))) return t;
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

function num(v, name) {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) throw new ApiError(400, `${name} 값이 필요합니다`);
  return n;
}

/* ---------- 1. 좌표 근처 정류장 (TAGO 버스정류소정보 · 반경 약 500m) ---------- */
async function nearbyStops(q) {
  const lat = num(q.lat, 'lat'), lng = num(q.lng, 'lng');
  if (isMock()) return { mock: true, stops: mockStops(lat, lng) };
  const key = `stops:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const stops = await cached(key, 24 * 3600e3, async () => {
    const text = await fetchTago(dataGoUrl('https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList',
      { gpsLati: lat, gpsLong: lng, numOfRows: 40, pageNo: 1, _type: 'json' }));
    return tagoItems(text).map((it) => ({
      id: String(it.nodeid), name: String(it.nodenm), lat: Number(it.gpslati), lng: Number(it.gpslong),
      no: it.nodeno != null ? String(it.nodeno) : null, city: it.citycode != null ? String(it.citycode) : null,
    })).filter((s) => !s.city || s.city === DAEJEON_CITY_CODE);
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
      routeNo: String(it.routeno), routeId: String(it.routeid || ''), routeType: it.routetp || '',
      arrSec: Number(it.arrtime), prevCnt: Number(it.arrprevstationcnt), vehicleType: it.vehicletp || '',
    })).filter((a) => Number.isFinite(a.arrSec)).sort((a, b) => a.arrSec - b.arrSec);
    return { mock: false, source: 'tago', nodeId, at: Date.now(), list };
  });
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
      const sec = Number(xmlField(b, 'EXTIME_SEC')), min = Number(xmlField(b, 'EXTIME_MIN'));
      return {
        routeNo: xmlField(b, 'ROUTE_NO'), routeId: xmlField(b, 'ROUTE_CD'), destination: xmlField(b, 'DESTINATION'),
        arrSec: Number.isFinite(sec) && sec > 0 ? sec : min * 60, prevCnt: Number(xmlField(b, 'STATUS_POS')),
        message: xmlField(b, 'MSG_TP'),
      };
    }).filter((a) => a.routeNo && Number.isFinite(a.arrSec)).sort((a, b) => a.arrSec - b.arrSec);
    return { mock: false, source: 'daejeon', arsId, at: Date.now(), list };
  });
}

/* ---------- 3-1. 대전도시철도 열차시각표 (대전교통공사 TimeTableSVC · 전체 역을 한 번에 받아 12시간 캐시) ---------- */
// dayType 0=평일 1=휴일 · drctType 0=판암 방면 1=반석 방면 · stNum 101(판암)~122(반석), 월평 114, 대전역 104
const SUBWAY_URL = () => env('DJ_SUBWAY_URL') || 'https://apis.data.go.kr/B554695/TimeTableSVC/getAllTimeTable';
function parseTimetable(xml) {
  if (/<returnAuthMsg>|<errMsg>/.test(xml) && !/<returnAuthMsg>\s*NORMAL/i.test(xml)) throw new ApiError(502, '열차시각표 API 오류: ' + explainXmlError(xml));
  const map = {};
  for (const b of xmlBlocks(xml)) {
    const k = `${xmlField(b, 'dayType')}|${xmlField(b, 'drctType')}|${xmlField(b, 'stNum')}`;
    let hr = Number(xmlField(b, 'tmZone')); if (hr < 4) hr += 24;  // 자정 넘은 막차
    for (const m of xmlField(b, 'tmList').split(/\s+/).filter(Boolean)) (map[k] = map[k] || []).push(hr * 60 + Number(m));
  }
  for (const k in map) map[k].sort((a, b) => a - b);
  if (!Object.keys(map).length) throw new ApiError(502, '열차시각표 응답에 시각이 없습니다');
  return map;
}
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
  const days = {};
  for (const d of ['0', '1']) { days[d] = {}; for (const dir of ['0', '1']) {
    const a = all[`${d}|${dir}|${from}`] || [], b = all[`${d}|${dir}|${to}`] || [], o = bestOffset(a, b);
    days[d][dir] = { from: a, ride: o.min > 0 && o.hits >= 5 ? o.min : null };
  } }
  return { mock: false, from, to, days };
}

/* ---------- 3. 자동차(택시) 이동시간·요금 (카카오모빌리티 길찾기, 선택) ---------- */
let driveBlockedUntil = 0;
async function drive(q) {
  const o = [num(q.olat, 'olat'), num(q.olng, 'olng')], d = [num(q.dlat, 'dlat'), num(q.dlng, 'dlng')];
  if (!env('KAKAO_REST_KEY') || env('MOCK') === '1') throw new ApiError(501, '카카오 길찾기 키가 없어 고정값을 사용합니다');
  if (Date.now() < driveBlockedUntil) throw new ApiError(503, '카카오 길찾기를 쓸 수 없어 고정값을 사용합니다 (권한 확인)');
  const key = `drive:${o.map((v) => v.toFixed(3))}:${d.map((v) => v.toFixed(3))}`;
  return cached(key, 5 * 60e3, async () => {
    const u = new URL('https://apis-navi.kakaomobility.com/v1/directions');
    u.searchParams.set('origin', `${o[1]},${o[0]}`);
    u.searchParams.set('destination', `${d[1]},${d[0]}`);
    u.searchParams.set('priority', 'RECOMMEND');
    let j;
    try { j = JSON.parse(await fetchText(u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` })); }
    catch (e) { driveBlockedUntil = Date.now() + 10 * 60e3; throw e; }
    const r = j.routes && j.routes[0];
    if (!r || r.result_code !== 0) throw new ApiError(502, '카카오 길찾기 결과 없음: ' + (r ? r.result_msg : ''));
    return { durationSec: r.summary.duration, distanceM: r.summary.distance, taxiFare: r.summary.fare ? r.summary.fare.taxi : null };
  });
}

/* ---------- 4. 브라우저에 줄 설정 (카카오 JavaScript 키는 원래 공개용) ---------- */
async function config() {
  const rest = !!env('KAKAO_REST_KEY') && env('MOCK') !== '1';
  return { kakaoJsKey: env('KAKAO_JS_KEY') || null, mock: isMock(), drive: rest, search: rest,
    tashu: !!env('TASHU_KEY') && env('MOCK') !== '1' };
}

/* ---------- 5. 장소 검색 (카카오 로컬 키워드 검색 · REST 키) ---------- */
async function search(q) {
  const query = String(q.q || '').trim().slice(0, 60);
  if (!query) throw new ApiError(400, '검색어가 필요합니다');
  if (!env('KAKAO_REST_KEY')) throw new ApiError(501, '카카오 REST 키가 없어 검색할 수 없어요');
  return cached(`search:${query}`, 10 * 60e3, async () => {
    const u = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
    u.searchParams.set('query', query); u.searchParams.set('x', '127.385'); u.searchParams.set('y', '36.350');
    u.searchParams.set('radius', '20000'); u.searchParams.set('size', '10');
    const j = JSON.parse(await fetchText(u, { Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}` }));
    return { places: (j.documents || []).map((d) => ({ name: d.place_name, address: d.road_address_name || d.address_name, lat: Number(d.y), lng: Number(d.x) })) };
  });
}

/* ---------- 6. 타슈 대여소 실시간 자전거 수 (타슈 Open API · api-token 헤더) ---------- */
async function tashuStations() {
  return cached('tashu:all', 60e3, async () => {
    const text = await fetchText('https://bikeapp.tashu.or.kr:50041/v1/openapi/station', { 'api-token': env('TASHU_KEY') });
    let j; try { j = JSON.parse(text); } catch { throw new ApiError(502, '타슈 API 응답을 읽을 수 없어요'); }
    const list = Array.isArray(j) ? j : (j.results || j.result || j.data || []);
    return list.map((r) => {
      let a = Number(r.x_pos), b = Number(r.y_pos);
      if (a > 100 && b < 100) [a, b] = [b, a]; // 문서상 x_pos=위도지만, 반대로 오면 바로잡기
      return { id: String(r.id), name: String(r.name || ''), lat: a, lng: b, bikes: Number(r.parking_count), address: r.address || '' };
    }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  });
}
function meters(a, b) {
  const R = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function tashu(q) {
  const p = { lat: num(q.lat, 'lat'), lng: num(q.lng, 'lng') };
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
    const r = await fetch(url, { headers, signal: ctl.signal });
    return { http: r.status, text: await r.text(), ms: Date.now() - t0 };
  } catch (e) {
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
  const keys = { DATA_GO_KR_KEY: !!env('DATA_GO_KR_KEY'), KAKAO_JS_KEY: !!env('KAKAO_JS_KEY'), KAKAO_REST_KEY: !!env('KAKAO_REST_KEY'), TASHU_KEY: !!env('TASHU_KEY'),
    DJ_SUBWAY_TEST_URL: !!env('DJ_SUBWAY_TEST_URL'), MOCK: env('MOCK') === '1' };
  const checks = [];
  if (!keys.DATA_GO_KR_KEY) return { keys, checks, note: '.env에 DATA_GO_KR_KEY가 없어 공공데이터 점검을 건너뛰었어요.' };
  const lat = Number(q.lat) || ORIGIN.lat, lng = Number(q.lng) || ORIGIN.lng;

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
      return s ? { ok: true, message: `정상 · 공대→대전역 ${Math.round(s.duration / 60)}분, 택시 ${s.fare && s.fare.taxi}원` } : { ok: false, message: '경로 없음' };
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
    return { ok: true, message: `정상 · ${Object.keys(map).length}개 (요일·방향·역) · ` + parts.join(' / ') };
  }));

  // 5) 지하철 시각표 — 공공데이터포털 '미리보기'의 요청 주소를 그대로 넣어 응답 형식 확인
  if (keys.DJ_SUBWAY_TEST_URL) {
    const u = new URL(env('DJ_SUBWAY_TEST_URL'));
    u.searchParams.set('serviceKey', env('DATA_GO_KR_KEY'));
    checks.push(await check('대전교통공사 열차시각표 (테스트 주소)', u.toString(), {}, (r) => ({ ok: r.http === 200, message: r.http === 200 ? '응답 받음 · 아래 원본을 보내 주시면 시각표 계산에 연결할게요' : `HTTP ${r.http}` })));
  }
  return { keys, checks, at: new Date().toISOString() };
}

/* ---------- Vercel·로컬 서버 공용 래퍼 ---------- */
function handler(fn) {
  return async (req, res) => {
    const q = req.query || Object.fromEntries(new URL(req.url, 'http://local').searchParams);
    let status = 200, body;
    try { body = await fn(q); } catch (e) {
      status = e instanceof ApiError ? e.status : 500;
      body = { error: e instanceof ApiError ? e.message : '서버 오류' };
      if (!(e instanceof ApiError)) console.error(e);
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
}

module.exports = { nearbyStops, arrivals, arrivalsDaejeon, subway, drive, config, search, tashu, health, handler, ApiError };
