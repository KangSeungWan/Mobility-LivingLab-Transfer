const { handler, stationDist } = require('../lib/core');
// 대전교통공사 역간 소요시간/거리/요금 (update12): 서버 1일 캐시(정상 응답만), CDN 저장 안 함
module.exports = handler(stationDist, { perMin: 30 });
