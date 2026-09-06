// Isolated browser proof. All PC, launchctl and Situations calls use a fixture.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../test-support/pc-ci-fixture.mjs';
import { pcCiHandler } from '../pc-ci-http.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f = await fixture();
const port = 14177;
const handler = pcCiHandler(f.controller, port);
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/api/pc-ci') return handler(req, res);
  if (pathname === '/finish-fixture') {
    f.machine.jobs = 0; f.machine.stopped = !f.machine.active;
    res.writeHead(303, { Location: '/' }); res.end(); return;
  }
  const files = { '/': 'index.html', '/styles.css': 'styles.css', '/pc-ci.js': 'pc-ci.js' };
  if (!files[pathname]) { res.writeHead(404); res.end(); return; }
  let body = await fs.readFile(path.join(root, 'public', files[pathname]), 'utf8');
  if (pathname === '/') body = body.replace(/<script[^>]*src="\/app.js"[^>]*><\/script>/, '').replace('</head>', '<style>#boot{display:none!important}</style></head>').replace('<body class="shift-day">', '<body class="shift-day"><p style="padding:12px;background:#5b2400;color:white">ISOLATED TEST — no live PC commands. <a href="/finish-fixture">Finish fixture jobs</a></p>');
  res.writeHead(200, { 'Content-Type': pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body);
});
server.listen(port, '127.0.0.1', () => console.log(`Fixture UI: http://127.0.0.1:${port}; state ${f.dir}`));
process.on('SIGINT', () => { server.close(); fs.rm(f.dir, { recursive: true, force: true }).finally(() => process.exit()); });
