// Vercel 서버 함수 1개로 모든 /api/<이름> 요청을 처리 (update13 · Hobby 배포당 함수 12개 제한 대응)
//   경로 표는 lib/routes.js (로컬 server.js와 공용)
const routes = require('../lib/routes');

module.exports = (req, res) => {
  const { pathname } = new URL(req.url, 'http://local');
  const name = decodeURIComponent(pathname.replace(/\/+$/, '').split('/').pop() || '');
  const route = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null;
  if (!route) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: '없는 API예요' }));
  }
  // Vercel이 파일 이름의 [name]을 쿼리에 넣으므로 원래 요청 파라미터만 남김
  if (req.query && typeof req.query === 'object' && 'name' in req.query) {
    const { name: _drop, ...rest } = req.query;
    req.query = rest;
  }
  return route(req, res);
};
