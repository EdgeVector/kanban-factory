import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PcCiController } from './pc-ci.mjs';
import { pcCiHandler } from './pc-ci-http.mjs';

import { fixture } from './test-support/pc-ci-fixture.mjs';

test('status is read-only and names both live runners', async t => {
  const f = await fixture(t); const result = await f.controller.status();
  assert.equal(result.phase, 'normal'); assert.equal(result.canPause, true);
  assert.deepEqual(await fs.readdir(f.dir), []);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].args.at(-1), / status$/);
});
test('pause fences recovery before stop, drains jobs, and resume restores it', async t => {
  const f = await fixture(t);
  assert.equal((await f.controller.change('pause')).phase, 'draining');
  assert.equal(f.machine.jobs, 1); assert.equal(f.machine.loaded, false); assert.equal(f.machine.disabled, true);
  const stop = f.calls.findIndex(c => c.file.endsWith('ssh') && c.args.at(-1).endsWith(' pause'));
  const fence = f.calls.findIndex(c => c.args[0] === 'bootout');
  const situation = f.calls.findIndex(c => c.args[0] === 'put');
  assert.ok(situation < fence && fence < stop);
  await assert.rejects(f.controller.change('resume'), /Jobs still finish/);
  assert.equal(f.machine.guarded, true);
  f.machine.jobs = 0; f.machine.stopped = true;
  const restart = new PcCiController(f.options);
  // Retry pause clears a transient error and is idempotent.
  assert.equal((await restart.change('pause')).phase, 'paused');
  assert.equal((await restart.change('resume')).phase, 'normal');
  assert.equal(f.machine.loaded, true); assert.equal(f.machine.disabled, false);
  assert.equal((await restart.read()).intent, 'normal');
  const resolved = f.calls.filter(c => c.args[0] === 'put').map(c => JSON.parse(c.input));
  assert.equal(resolved.at(-1).status, 'resolved');
});
test('original disabled watchdog stays disabled and unloaded after resume', async t => {
  const f = await fixture(t); Object.assign(f.machine, { jobs: 0, loaded: false, disabled: true });
  await f.controller.change('pause'); await f.controller.change('resume');
  assert.equal(f.machine.loaded, false); assert.equal(f.machine.disabled, true);
  assert.ok(!f.calls.some(c => ['enable', 'bootstrap'].includes(c.args[0])));
});
test('preflight refusal cannot change PC or recovery state', async t => {
  const f = await fixture(t); f.machine.fail = c => c.args[0] === 'preflight';
  await assert.rejects(f.controller.change('pause'));
  assert.equal(f.machine.guarded, false); assert.equal(f.machine.loaded, true);
  assert.equal((await f.controller.read()).intent, 'normal');
});
test('Situation failure preserves recovery metadata and stops before PC mutation', async t => {
  const f = await fixture(t); f.machine.fail = c => c.args[0] === 'put';
  await assert.rejects(f.controller.change('pause'));
  assert.equal(f.machine.active, true); assert.equal(f.machine.loaded, true);
  assert.equal((await f.controller.read()).watchdog.loaded, true);
  f.machine.fail = null;
  await f.controller.change('resume');
  assert.equal((await f.controller.read()).intent, 'normal');
});
test('SSH failure preserves pause intent and never reports PC ready', async t => {
  const f = await fixture(t);
  f.machine.fail = c => c.file.endsWith('ssh') && c.args.at(-1).endsWith(' pause');
  await assert.rejects(f.controller.change('pause'));
  const state = await f.controller.status();
  assert.notEqual(state.phase, 'paused'); assert.equal(state.canResume, true);
  assert.equal((await f.controller.read()).intent, 'paused');
});
test('unknown PC status is not an idle PC', async t => {
  const f = await fixture(t); f.machine.fail = c => c.file.endsWith('ssh');
  assert.equal((await f.controller.status()).phase, 'unknown');
  assert.equal((await f.controller.status()).canPause, false);
});
test('invalid or corrupted local state fails closed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.controller.change('stop-all'));
  await fs.writeFile(f.controller.stateFile, '{');
  await assert.rejects(f.controller.change('pause'), /unreadable/);
  assert.equal(f.machine.active, true);
});
test('concurrent requests cannot overwrite a pause', async t => {
  const f = await fixture(t); const request = f.controller.change('pause');
  await assert.rejects(f.controller.change('resume'), /already in progress/);
  await request;
});
test('another process lock prevents mutations', async t => {
  const f = await fixture(t);
  const owner = await f.controller.acquireLock();
  try { await assert.rejects(f.controller.change('pause')); assert.equal(f.calls.length, 0); }
  finally { await owner.close(); }
});
test('HTTP rejects cross-origin, missing token, foreign Host, oversized and invalid actions', async t => {
  const f = await fixture(t);
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port; handler = pcCiHandler(f.controller, port);
  const url = `http://127.0.0.1:${port}`;
  const status = await (await fetch(url)).json();
  const headers = { 'Content-Type': 'application/json', Origin: url, 'X-PC-CI-Token': status.token };
  const post = (extra = {}, body = '{"action":"pause"}') => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await post({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ 'X-PC-CI-Token': '' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{"action":"pause"}');
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post({}, '{"action":"shutdown"}')).status, 400);
  assert.equal((await post({}, 'x'.repeat(1025))).status, 413);
  assert.equal(f.machine.active, true);
  assert.equal((await post()).status, 200);
  assert.equal(f.machine.guarded, true);
});

test('a dead controller lock can be recovered without loss of pause state', async t => {
  const f = await fixture(t);
  // A leftover lock file does not imply an active OS lock.
  await fs.writeFile(path.join(f.dir, 'control.lock'), '2147483647');
  assert.equal((await f.controller.change('pause')).phase, 'draining');
  assert.equal((await f.controller.read()).watchdog.loaded, true);
});
test('resume retains intent when runner start is incomplete or recovery fails', async t => {
  const f = await fixture(t); f.machine.jobs = 0;
  await f.controller.change('pause');
  f.machine.fail = c => c.args[0] === 'bootstrap';
  await assert.rejects(f.controller.change('resume'));
  assert.equal((await f.controller.read()).intent, 'paused');
  assert.equal(f.machine.active, true);
  f.machine.fail = null;
  await f.controller.change('resume');
  assert.equal(f.machine.loaded, true);
  assert.equal((await f.controller.read()).intent, 'normal');
});
