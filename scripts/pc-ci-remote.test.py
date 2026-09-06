import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote', Path(__file__).with_name('pc-ci-remote.py'))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.states = {unit: {'Id': unit, 'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running', 'MainPID': '10', 'Result': 'success', 'ExecMainStartTimestamp': 'test', 'TimeoutStopUSec': '1min 30s', 'KillMode': 'control-group', 'KillSignal': '15'} for unit in remote.UNITS}
        configs = []
        for number in range(2):
            file = self.root / str(number)
            file.write_text('runner:\n  shutdown_timeout: 3h\n  capacity: 4\nserver:\n  other: value\n')
            configs.append(str(file))
        self.marker = self.root / 'state' / 'pc-ci-paused'
        patches = [patch.object(remote, 'MARKER', self.marker), patch.object(remote, 'CONFIGS', configs), patch.object(remote, 'dropin', lambda unit: self.root / unit / remote.DROPIN), patch.object(remote, 'run', self.fake_run)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def fake_run(self, *args):
        self.calls.append(args)
        if args[0] == 'date':
            return '9999999999\n'
        if args[:2] == ('systemctl', 'show'):
            return '\n'.join(f'{k}={v}' for k, v in self.states[args[2]].items())
        if args[:2] == ('systemctl', 'daemon-reload'):
            for row in self.states.values():
                row.update(TimeoutStopUSec='infinity', KillMode='process')
        if args[:2] == ('systemctl', 'stop'):
            self.assertTrue(self.marker.exists())
            for row in self.states.values():
                self.assertEqual(row['TimeoutStopUSec'], 'infinity')
                row['ActiveState'] = 'deactivating'
        if args[:2] == ('systemctl', 'start'):
            self.assertFalse(self.marker.exists())
            for row in self.states.values():
                row.update(ActiveState='active', MainPID='12')
        return ''

    def finish(self):
        for row in self.states.values():
            row.update(ActiveState='inactive', MainPID='0')

    def test_status_does_not_create_state(self):
        state = remote.control('status')
        self.assertTrue(state['active'])
        self.assertFalse(self.marker.parent.exists())
        self.assertTrue(all(c[:2] == ('systemctl', 'show') for c in self.calls))

    def test_pause_guards_both_runners_before_nonblocking_graceful_stop(self):
        state = remote.control('pause')
        self.assertTrue(state['guarded'])
        self.assertFalse(state['stopped'])
        self.assertIn(('systemctl', 'stop', '--no-block', *remote.UNITS), self.calls)
        self.assertFalse(any('kill' in c for c in self.calls))
        for unit in remote.UNITS:
            self.assertIn('ConditionPathExists=!', remote.dropin(unit).read_text())
        self.finish()
        self.assertTrue(remote.control('status')['stopped'])
        self.assertTrue(remote.control('status')['guarded'])

    def test_resume_refuses_to_interrupt_drain_then_restores_both(self):
        remote.control('pause')
        with self.assertRaisesRegex(RuntimeError, 'Jobs still finish'):
            remote.control('resume')
        self.assertTrue(self.marker.exists())
        self.finish()
        self.assertTrue(remote.control('resume')['active'])
        self.assertFalse(self.marker.exists())

    def test_unloaded_grace_config_rejects_before_marker_or_stop(self):
        Path(remote.CONFIGS[0]).write_text('runner:\n  shutdown_timeout: 0s\n')
        with self.assertRaisesRegex(RuntimeError, 'loaded shutdown_timeout'):
            remote.control('pause')
        self.assertFalse(self.marker.exists())
        self.assertFalse(any(c[:2] == ('systemctl', 'stop') for c in self.calls))

    def test_changed_config_rejects_before_stop(self):
        original = self.fake_run
        with patch.object(remote, 'run', lambda *args: '0\n' if args[0] == 'date' else original(*args)):
            with self.assertRaisesRegex(RuntimeError, 'changed after process start'):
                remote.control('pause')
        self.assertFalse(self.marker.exists())

    def test_foreign_dropin_is_never_overwritten(self):
        target = remote.dropin(remote.UNITS[0]); target.parent.mkdir()
        target.write_text('operator config')
        with self.assertRaisesRegex(RuntimeError, 'Unrecognized'):
            remote.control('pause')
        self.assertEqual(target.read_text(), 'operator config')
        self.assertFalse(self.marker.exists())

    def test_failed_reload_keeps_guard_and_never_stops(self):
        original = self.fake_run
        def fail(*args):
            if args[:2] == ('systemctl', 'daemon-reload'):
                raise RuntimeError('reload failed')
            return original(*args)
        with patch.object(remote, 'run', fail):
            with self.assertRaisesRegex(RuntimeError, 'reload failed'):
                remote.control('pause')
        self.assertTrue(self.marker.exists())
        self.assertFalse(any(c[:2] == ('systemctl', 'stop') for c in self.calls))

    def test_failed_runner_is_not_ready_for_games(self):
        remote.control('pause'); self.finish()
        self.states[remote.UNITS[0]]['Result'] = 'signal'
        self.assertFalse(remote.control('status')['stopped'])

    def test_unknown_unit_fails_closed(self):
        self.states[remote.UNITS[0]]['LoadState'] = 'not-found'
        with self.assertRaisesRegex(RuntimeError, 'not loaded'):
            remote.control('pause')
        self.assertFalse(self.marker.exists())

if __name__ == '__main__':
    unittest.main()
