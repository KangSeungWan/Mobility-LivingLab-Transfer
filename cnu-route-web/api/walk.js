const { handler, walk } = require('../lib/core');
module.exports = handler(walk, { perMin: 30 }); // 카카오 결과는 공유 캐시 금지 → CDN 캐시 없음(no-store)
