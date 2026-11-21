// API 경로 표 (update13): /api/<이름> → 처리 함수와 옵션
//   Vercel Hobby는 프레임워크 없는 배포에서 api/ 파일 1개 = 서버 함수 1개로 세고 배포당 최대 12개까지만 허용합니다.
//   그래서 api/[name].js 하나가 이 표를 보고 나눠 주고, 로컬 server.js도 같은 표를 씁니다.
//   새 API를 추가할 때: lib/core.js에 함수 → 여기에 한 줄 (api/ 폴더에 파일을 더 만들지 마세요)
const core = require('./core');
const { handler } = core;

module.exports = {
  // 출발 좌표가 주소에 들어가므로 CDN 공유 캐시 안 함(no-store). 정류장 목록은 서버 메모리에 하루 보관
  stops: handler(core.nearbyStops),
  arrivals: handler(core.arrivals, { cacheSec: 15 }),
  'arrivals-dj': handler(core.arrivalsDaejeon, { cacheSec: 15 }),
  // 노선·경유 정류장은 공공 원천 데이터이고 사용자 위치가 아님 → 서버 1일 캐시 + CDN 6시간 (도착정보와 분리)
  busroute: handler(core.busRoute, { cacheSec: 21600 }),
  subway: handler(core.subway, { cacheSec: 21600 }),
  // 대전교통공사 역간 소요시간/거리/요금: 서버 1일 캐시(정상 응답만), CDN 저장 안 함
  stdist: handler(core.stationDist, { perMin: 30 }),
  // 카카오 결과는 공유 캐시 금지 → CDN 캐시 없음(no-store)
  drive: handler(core.drive, { perMin: 30 }),
  search: handler(core.search, { perMin: 30 }),
  stations: handler(core.stations, { perMin: 30 }),
  transit: handler(core.transit, { perMin: 30 }),
  walk: handler(core.walk, { perMin: 30 }),
  bike: handler(core.bike, { perMin: 30 }),
  // 출발 좌표가 주소에 들어가므로 CDN 공유 캐시 안 함(no-store). 전체 대여소 목록은 서버 메모리에 60초 보관
  tashu: handler(core.tashu),
  config: handler(core.config, { cacheSec: 300 }),
  health: handler(core.health, { perMin: 3 }),
};
