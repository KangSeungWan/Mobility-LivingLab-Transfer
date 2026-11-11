// 로컬 실행용 서버: node server.js → http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 파일 읽기 (외부 패키지 없이)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const routes = {
  '/api/stops': require('./api/stops'),
  '/api/arrivals': require('./api/arrivals'),
  '/api/arrivals-dj': require('./api/arrivals-dj'),
  '/api/drive': require('./api/drive'),
  '/api/config': require('./api/config'),
  '/api/health': require('./api/health'),
  '/api/search': require('./api/search'),
  '/api/tashu': require('./api/tashu'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC = path.join(__dirname, 'public');

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://local');
  if (routes[pathname]) return routes[pathname](req, res);
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(process.env.PORT || 3000, () => {
  const mock = process.env.MOCK === '1' || !process.env.DATA_GO_KR_KEY;
  console.log(`통학길 비교 실행 중 → http://localhost:${process.env.PORT || 3000}${mock ? '  (예시 데이터 모드: .env에 DATA_GO_KR_KEY를 넣으면 실시간)' : ''}`);
});
