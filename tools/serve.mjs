// tiny static server for local checks: node tools/serve.mjs [port]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('dist'); const port = +process.argv[2] || 8788;
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4','.woff2':'font/woff2','.otf':'font/otf','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json' };
http.createServer((q, s) => {
  let p = decodeURIComponent(q.url.split('?')[0]); let f = path.join(root, p);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { f = path.join(root, '404.html'); s.statusCode = 404; if (!fs.existsSync(f)) return s.end('404'); }
  s.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(s);
}).listen(port, () => console.log('http://localhost:' + port));
