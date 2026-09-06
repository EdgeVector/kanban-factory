import { randomUUID } from 'node:crypto';

export function pcCiHandler(controller, port) {
  const token = randomUUID();
  return async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const host = req.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return send(403, { error: 'Local factory host required.' });
    if (req.method === 'GET') {
      try { return send(200, { ...await controller.status(), token }); }
      catch { return send(503, { error: 'PC control state is unavailable.' }); }
    }
    if (req.method !== 'POST') return send(405, { error: 'Use GET or POST.' });
    if (req.headers.origin !== `http://${host}` || req.headers['x-pc-ci-token'] !== token || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Use the local factory PC controls.' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return send(413, { error: 'Request is too large.' });
    }
    let action;
    try { action = JSON.parse(body).action; } catch { return send(400, { error: 'Invalid JSON.' }); }
    if (!['pause', 'resume'].includes(action)) return send(400, { error: 'Use pause or resume.' });
    try { return send(200, { ...await controller.change(action), token }); }
    catch (error) { return send(409, { error: error.message }); }
  };
}
