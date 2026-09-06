import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SLUG = 'factory-pc-ci-owner-pause';
const WATCHDOG = 'com.edgevector.pc-runner-watchdog';
const HOME = os.homedir();

export function command(file, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    // Drain stderr, but do not expose arbitrary subprocess output to browsers.
    child.stderr.resume();
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 128_000) child.kill(); });
    const timer = setTimeout(() => child.kill(), 35_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class PcCiController {
  constructor({ run = command, stateDir = path.join(HOME, '.local/state/last-stack/pc-ci'), home = HOME, uid = process.getuid?.() ?? 501 } = {}) {
    this.run = run;
    this.stateDir = stateDir;
    this.home = home;
    this.domain = `gui/${uid}`;
    this.target = `${this.domain}/${WATCHDOG}`;
    this.stateFile = path.join(stateDir, 'state.json');
    this.busy = false;
  }
  async read() {
    try { return JSON.parse(await fs.readFile(this.stateFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { intent: 'normal' }; throw new Error('PC control state is unreadable. Preserve the pause until repaired.'); }
  }
  async save(state) {
    await fs.mkdir(this.stateDir, { recursive: true });
    const tmp = this.stateFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    await fs.rename(tmp, this.stateFile);
  }
  async checked(file, args, input = '') {
    const result = await this.run(file, args, input);
    if (result.code !== 0) throw new Error(`${path.basename(file)} failed. The pause state remains available for recovery.`);
    return result.stdout;
  }
  async remote(action) {
    const script = await fs.readFile(path.join(ROOT, 'scripts/pc-ci-remote.py'), 'utf8');
    const result = await this.run('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'pc', `wsl -d Ubuntu-24.04 -u tom -- sudo -n python3 - ${action}`], script);
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new Error('PC did not return valid runner status.'); }
    if (result.code !== 0 || data.error) throw new Error(data.error || 'PC runner command failed.');
    if (!Array.isArray(data.runners) || data.runners.length !== 2 || typeof data.guarded !== 'boolean' || typeof data.stopped !== 'boolean' || typeof data.active !== 'boolean') throw new Error('PC runner status is incomplete.');
    return data;
  }
  async situation(active) {
    const body = {
      slug: SLUG, title: 'PC CI paused by the owner', status: active ? 'active' : 'resolved', severity: 'p3', owner: 'Tom',
      summary: active ? 'The owner requested a PC CI pause from the factory. Let active jobs finish. Do not restart or wake the PC runners. Resume only through the factory.' : 'The owner resumed PC CI from the factory.',
      scope_systems: ['pc-ci', 'pc-runner', 'pc-runner-watchdog'],
      blocked_actions: active ? ['revive-pc-runner', 'dispatch-pc-ci', 'wake-pc-runner'] : [],
      allowed_actions: ['read-logs', 'inspect-ci', 'resume-pc-ci'],
      requires_human_clearance: false,
      preflight_message: 'PC CI is paused by the owner. Use the factory Resume PC control to restore it.',
    };
    await this.checked(path.join(this.home, '.local/bin/situations'), ['put', '-'], JSON.stringify(body));
  }
  async watchdogState() {
    const loaded = await this.run('/bin/launchctl', ['print', this.target]);
    const disabled = await this.checked('/bin/launchctl', ['print-disabled', this.domain]);
    return { loaded: loaded.code === 0, disabled: new RegExp(`"${WATCHDOG.replaceAll('.', '\\.')}"\\s*=>\\s*true`).test(disabled) };
  }
  async suspendWatchdog(state) {
    await this.checked('/bin/launchctl', ['disable', this.target]);
    const loaded = await this.run('/bin/launchctl', ['print', this.target]);
    if (loaded.code === 0) await this.checked('/bin/launchctl', ['bootout', this.target]);
  }
  async restoreWatchdog(state) {
    if (!state.watchdog) return;
    if (!state.watchdog.disabled) await this.checked('/bin/launchctl', ['enable', this.target]);
    if (state.watchdog.loaded) {
      const loaded = await this.run('/bin/launchctl', ['print', this.target]);
      if (loaded.code !== 0) await this.checked('/bin/launchctl', ['bootstrap', this.domain, path.join(this.home, 'Library/LaunchAgents', WATCHDOG + '.plist')]);
    }
  }
  async status() {
    const state = await this.read();
    try {
      const remote = await this.remote('status');
      const held = state.intent === 'paused' || remote.guarded;
      const failed = remote.runners.some(row => row.ActiveState === 'failed' || !['success', undefined].includes(row.Result));
      const phase = held ? (failed || state.error ? 'error' : remote.guarded && remote.stopped ? 'paused' : 'draining') : (remote.active ? 'normal' : 'unknown');
      const messages = { normal: 'PC CI is available.', paused: 'PC ready for games. CI jobs wait until you resume.', draining: 'The pause is in progress. Wait for PC ready for games.', error: 'A runner failed. Inspect it before you use the PC.', unknown: 'PC CI is not fully active. Check the runners.' };
      return { phase, message: state.error || messages[phase], error: state.error || null, intent: state.intent, runners: remote.runners.map(row => ({ name: row.Id, state: row.ActiveState })), canPause: !held && remote.active, canResume: held && !remote.runners.some(row => row.ActiveState === 'deactivating'), busy: this.busy };
    } catch (error) {
      return { phase: 'unknown', intent: state.intent, message: error.message, canPause: false, canResume: state.intent === 'paused', busy: this.busy };
    }
  }
  async acquireLock() {
    // The OS releases this advisory lock when either process dies. A leftover
    // file is harmless, and two server processes cannot reclaim each other's lock.
    return new Promise((resolve, reject) => {
      const child = spawn('python3', [path.join(ROOT, 'scripts/pc-ci-lock.py'), path.join(this.stateDir, 'control.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let ready = false;
      child.stderr.resume();
      child.stdin.on('error', () => {});
      const timer = setTimeout(() => { child.kill(); reject(new Error('PC control lock timed out.')); }, 10000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('PC control lock is unavailable.')); });
      child.once('close', () => { clearTimeout(timer); if (!ready) reject(new Error('Another PC controller owns the request lock.')); });
      child.stdout.once('data', data => {
        if (data.toString().trim() !== 'locked') { child.kill(); return; }
        ready = true;
        clearTimeout(timer);
        resolve({ close: () => new Promise(done => { child.once('close', done); child.stdin.end(); }) });
      });
    });
  }
  async change(action) {
    if (!['pause', 'resume'].includes(action)) throw new Error('Use pause or resume.');
    if (this.busy) throw new Error('A PC control request is already in progress.');
    this.busy = true;
    let lock;
    let state;
    try {
      await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      // A process lock also protects against a second factory instance.
      lock = await this.acquireLock();
      state = await this.read();
      await this.checked(path.join(this.home, '.local/bin/situations'), ['preflight', '--action', `${action}-pc-ci`, '--system', 'pc-ci']);
      if (action === 'pause') {
        if (state.intent !== 'paused') {
          const remote = await this.remote('status');
          if (!remote.active || remote.guarded) throw new Error('Both PC runners must be active before a new pause.');
          state = { intent: 'paused', watchdog: await this.watchdogState() };
          await this.save(state);
        }
        await this.situation(true);
        await this.suspendWatchdog(state);
        await this.remote('pause');
        delete state.error;
        await this.save(state);
      } else {
        if (state.intent !== 'paused') throw new Error('No factory pause exists to resume.');
        const result = await this.remote('resume');
        if (!result.active) throw new Error('PC runners are not active yet. Select Resume PC again after they start.');
        await this.restoreWatchdog(state);
        await this.situation(false);
        await this.save({ intent: 'normal' });
      }
    } catch (error) {
      if (state?.intent === 'paused') await this.save({ ...state, error: error.message });
      throw error;
    } finally {
      if (lock) await lock.close();
      this.busy = false;
    }
    return this.status();
  }
}
