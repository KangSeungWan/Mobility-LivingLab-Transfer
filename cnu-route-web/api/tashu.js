const { handler, tashu } = require('../lib/core');
module.exports = handler(tashu); // 출발 좌표가 주소에 들어가므로 CDN 공유 캐시 안 함(no-store). 전체 대여소 목록은 서버 메모리에 60초 보관
