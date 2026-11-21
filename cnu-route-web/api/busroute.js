const { handler, busRoute } = require('../lib/core');
// 노선·경유 정류장은 공공 원천 데이터이고 사용자 위치가 아님 → 서버 1일 캐시 + CDN 6시간 (도착정보와 분리)
module.exports = handler(busRoute, { cacheSec: 21600 });
