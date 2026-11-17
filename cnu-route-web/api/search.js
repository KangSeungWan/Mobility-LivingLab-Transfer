const { handler, search } = require('../lib/core');
module.exports = handler(search, { perMin: 30 }); // 카카오 결과는 공유 캐시 금지 → CDN 캐시 없음(no-store)
