#!/usr/bin/env python3
"""Fixed-scope PC runner control. Sent over SSH stdin; never reads credentials."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

UNITS = ('forgejo-runner.service', 'forgejo-runner-heavy.service')
CONFIGS = ('/home/tom/.forgejo-runner/config.yml', '/home/tom/.forgejo-runner-heavy/config.yml')
MARKER = Path('/var/lib/edgevector/pc-ci-paused')
DROPIN = '90-factory-pc-pause.conf'
CONTENT = '[Unit]\nConditionPathExists=!/var/lib/edgevector/pc-ci-paused\n[Service]\nTimeoutStopSec=infinity\nKillMode=process\nKillSignal=SIGTERM\n'
PROPS = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'Result', 'ExecMainStartTimestamp', 'TimeoutStopUSec', 'KillMode', 'KillSignal')


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=25).stdout


def unit_state(unit):
    text = run('systemctl', 'show', unit, *['--property=' + prop for prop in PROPS])
    row = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    if row.get('LoadState') != 'loaded':
        raise RuntimeError('Runner unit is not loaded: ' + unit)
    return row


def check_grace(row, config):
    # Never print config contents: runner config may contain secret values.
    text = Path(config).read_text()
    section = re.search(r'^runner:\s*\n((?:[ \t]+[^\n]*\n|\n)*)', text, re.M)
    values = re.findall(r'^\s+shutdown_timeout:\s*[\"\']?(\d+)h[\"\']?\s*(?:#.*)?$', section.group(1) if section else '', re.M)
    if len(values) != 1 or int(values[0]) < 3:
        raise RuntimeError('Runner needs a loaded shutdown_timeout of at least 3h: ' + row['Id'])
    if int(row.get('MainPID', '0')):
        started = float(run('date', '--date=' + row['ExecMainStartTimestamp'], '+%s').strip())
        if Path(config).stat().st_mtime > started:
            raise RuntimeError('Runner config changed after process start; restart safely before pause: ' + row['Id'])


def dropin(unit):
    return Path('/etc/systemd/system') / (unit + '.d') / DROPIN


def snapshot():
    rows = [unit_state(unit) for unit in UNITS]
    guarded = MARKER.exists() and all(dropin(unit).exists() and dropin(unit).read_text() == CONTENT for unit in UNITS)
    stopped = all(row.get('ActiveState') == 'inactive' and row.get('MainPID') == '0' and row.get('Result') == 'success' for row in rows)
    active = all(row.get('ActiveState') == 'active' and int(row.get('MainPID', '0')) > 0 for row in rows)
    return {'guarded': guarded, 'stopped': stopped, 'active': active, 'runners': rows}


def control(action):
    if action == 'status':
        return snapshot()
    if action not in ('pause', 'resume'):
        raise ValueError('Unknown action')
    MARKER.parent.mkdir(parents=True, exist_ok=True)
    with (MARKER.parent / 'pc-ci-control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = [unit_state(unit) for unit in UNITS]
        if action == 'pause':
            for row, config in zip(rows, CONFIGS):
                check_grace(row, config)
            for unit in UNITS:
                target = dropin(unit)
                if target.exists() and target.read_text() != CONTENT:
                    raise RuntimeError('Unrecognized factory drop-in; preserve it: ' + str(target))
            # Guard first. The marker and conditions survive a reboot and external restarts.
            MARKER.write_text('Owner pause from Kanban Factory. Resume from the factory.\n')
            for unit in UNITS:
                target = dropin(unit)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(CONTENT)
            run('systemctl', 'daemon-reload')
            for unit in UNITS:
                row = unit_state(unit)
                if row.get('TimeoutStopUSec') != 'infinity' or row.get('KillMode') != 'process' or row.get('KillSignal') not in ('15', 'SIGTERM'):
                    raise RuntimeError('Safe stop settings did not load: ' + unit)
            # SIGTERM stops polling, then the runner waits up to its loaded 3h grace.
            # --no-block keeps the UI responsive while jobs finish.
            run('systemctl', 'stop', '--no-block', *UNITS)
        else:
            if any(row.get('ActiveState') == 'deactivating' for row in rows):
                raise RuntimeError('Jobs still finish. Resume becomes available after the runners stop.')
            MARKER.unlink(missing_ok=True)
            run('systemctl', 'start', *UNITS)
        return snapshot()


if __name__ == '__main__':
    try:
        print(json.dumps(control(sys.argv[1])))
    except Exception as error:
        # Do not expose subprocess stdout/stderr or config values.
        print(json.dumps({'error': str(error) if not isinstance(error, subprocess.CalledProcessError) else 'Runner control command failed'}))
        sys.exit(1)
