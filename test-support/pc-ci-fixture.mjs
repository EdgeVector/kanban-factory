import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PcCiController } from '../pc-ci.mjs';

export async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-pc-test-'));
  t?.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const machine = { guarded: false, active: true, stopped: false, loaded: true, disabled: false, jobs: 1, fail: null };
  const remote = () => ({ guarded: machine.guarded, active: machine.active, stopped: machine.stopped, runners: ['forgejo-runner.service', 'forgejo-runner-heavy.service'].map(Id => ({ Id, ActiveState: machine.active ? 'active' : machine.stopped ? 'inactive' : 'deactivating', MainPID: machine.stopped ? '0' : '10', Result: 'success' })) });
  const run = async (file, args, input) => {
    const call = { file, args, input }; calls.push(call);
    if (machine.fail?.(call)) return { code: 1, stdout: '' };
    if (file.endsWith('/ssh')) {
      const action = args.at(-1).split(' ').at(-1);
      if (action === 'pause') { machine.guarded = true; machine.active = false; machine.stopped = machine.jobs === 0; }
      if (action === 'resume') {
        if (!machine.stopped && !machine.active) return { code: 1, stdout: JSON.stringify({ error: 'Jobs still finish.' }) };
        machine.guarded = false; machine.active = true; machine.stopped = false;
      }
      return { code: 0, stdout: JSON.stringify(remote()) };
    }
    if (file.endsWith('/launchctl')) {
      if (args[0] === 'print') return { code: machine.loaded ? 0 : 1, stdout: '' };
      if (args[0] === 'print-disabled') return { code: 0, stdout: `"com.edgevector.pc-runner-watchdog" => ${machine.disabled}` };
      if (args[0] === 'disable') machine.disabled = true;
      if (args[0] === 'enable') machine.disabled = false;
      if (args[0] === 'bootout') machine.loaded = false;
      if (args[0] === 'bootstrap') machine.loaded = true;
    }
    return { code: 0, stdout: '{}' };
  };
  const options = { run, stateDir: dir, home: '/fixture', uid: 501 };
  return { dir, calls, machine, run, controller: new PcCiController(options), options };
}
