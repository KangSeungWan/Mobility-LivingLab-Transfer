const { handler, nearbyStops } = require('../lib/core');
module.exports = handler(nearbyStops); // 출발 좌표가 주소에 들어가므로 CDN 공유 캐시 안 함(no-store). 정류장 목록은 서버 메모리에 하루 보관
