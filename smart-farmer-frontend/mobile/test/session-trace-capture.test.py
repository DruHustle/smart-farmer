import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('session_trace_capture', Path(__file__).parent.parent / 'acceptance' / 'capture-session-trace.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.value = {'at': '2026-11-05T16:00:00.000Z', 'sequence': 1, 'elapsed_ms': 0, 'stage': 'trace', 'phase': 'ready'}

    def line(self, value):
        return 'system metadata must be discarded ' + capture.PREFIX + json.dumps(value)

    def test_drops_free_form_fields_categories_and_errors(self):
        canary = 'private-user-token-error-must-not-appear'
        output = io.StringIO()
        receipts = capture.Receipts(output)
        receipts.accept(self.line(self.value))
        touch = dict(self.value, stage='farm_touch', phase='cancelled')
        receipts.accept(self.line(touch))
        for value in [dict(self.value, error=canary), dict(self.value, stage=canary), dict(self.value, phase=canary), dict(self.value, at=canary), dict(self.value, sequence=True), dict(self.value, elapsed_ms=-1), ['not', 'a', 'receipt']]:
            receipts.accept(self.line(value))
        receipts.accept(capture.PREFIX + canary)
        self.assertEqual(receipts.count, 2)
        self.assertTrue(receipts.ready)
        self.assertNotIn(canary, output.getvalue())
        self.assertNotIn('system metadata', output.getvalue())
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], [self.value, touch])

    def test_artifact_is_bounded_and_reports_unverified_capture_without_ready(self):
        output = io.StringIO()
        receipts = capture.Receipts(output)
        for _ in range(capture.LIMIT * 3):
            receipts.accept(self.line(dict(self.value, stage='sign_out', phase='start')))
        receipts.finish('stopped')
        values = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(values), capture.LIMIT + 2)
        self.assertEqual(values[-2], {'event': 'capture_limit'})
        self.assertFalse(values[-1]['traceReady'])
        self.assertEqual(values[-1]['records'], capture.LIMIT)
        self.assertLess(len(output.getvalue()), 32 * 1024)

    def check_denied_operation(self, denied_signal, expected_calls):
        canary = 'private-process-error-must-not-appear'
        output = io.StringIO()
        receipts = capture.Receipts(output)
        receipts.accept(self.line(self.value))
        child = mock.Mock(pid=43210)
        calls = []

        def signal_group(pid, value):
            self.assertEqual(pid, child.pid)
            calls.append(value)
            if value == denied_signal:
                raise PermissionError(1, canary)

        with mock.patch.object(capture.os, 'killpg', side_effect=signal_group), mock.patch.object(capture.time, 'monotonic', side_effect=[0, 3]), mock.patch.object(capture.time, 'sleep') as sleep:
            capture.finish_capture(child, receipts, 'stopped')
        self.assertEqual(calls, expected_calls, 'A denied operation must stop further group signals/probes')
        sleep.assert_not_called()
        child.wait.assert_called_once_with(timeout=2)
        child.stdout.close.assert_called_once_with()
        values = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(values, [self.value, {'event': 'capture_status', 'reason': 'stop_denied', 'traceReady': True, 'records': 1, 'limited': False}])
        self.assertNotIn(canary, output.getvalue())

    def test_denied_term_stops_group_operations_but_retains_terminal_failure(self):
        self.check_denied_operation(signal.SIGTERM, [signal.SIGTERM])

    def test_denied_probe_stops_group_operations_but_retains_terminal_failure(self):
        self.check_denied_operation(0, [signal.SIGTERM, 0])

    def test_denied_kill_stops_group_operations_but_retains_terminal_failure(self):
        self.check_denied_operation(signal.SIGKILL, [signal.SIGTERM, 0, signal.SIGKILL])

    def check_terminal_receipt_survives(self, cleanup_error=None, close_error=None, cleanup_result=None, expected='stop_failed'):
        output = io.StringIO()
        receipts = capture.Receipts(output)
        child = mock.Mock(pid=43210)
        child.stdout.close.side_effect = close_error
        with mock.patch.object(capture, 'stop_capture_group', side_effect=cleanup_error, return_value=cleanup_result):
            capture.finish_capture(child, receipts, 'stream_ended')
        child.stdout.close.assert_called_once_with()
        self.assertEqual(json.loads(output.getvalue()), {'event': 'capture_status', 'reason': expected, 'traceReady': False, 'records': 0, 'limited': False})
        self.assertNotIn('private-error', output.getvalue())

    def test_unexpected_cleanup_exception_cannot_hide_terminal_failure(self):
        self.check_terminal_receipt_survives(cleanup_error=RuntimeError('private-error'))

    def test_stdout_close_exception_cannot_hide_terminal_failure(self):
        self.check_terminal_receipt_survives(close_error=OSError('private-error'), expected='close_failed')

    def test_cleanup_and_stdout_close_exceptions_still_emit_one_terminal_failure(self):
        self.check_terminal_receipt_survives(cleanup_error=RuntimeError('private-error'), close_error=OSError('private-error'))

    def test_stdout_close_failure_does_not_hide_denied_cleanup(self):
        self.check_terminal_receipt_survives(cleanup_result='stop_denied', close_error=OSError('private-error'), expected='stop_denied')

    def test_reap_remains_bounded_and_reports_timeout(self):
        output = io.StringIO()
        child = mock.Mock(pid=43210)
        child.wait.side_effect = subprocess.TimeoutExpired('private-error', 2)
        with mock.patch.object(capture.os, 'killpg', side_effect=ProcessLookupError) as signal_group:
            capture.finish_capture(child, capture.Receipts(output), 'stopped')
        signal_group.assert_called_once_with(child.pid, signal.SIGTERM)
        child.wait.assert_called_once_with(timeout=2)
        self.assertEqual(json.loads(output.getvalue())['reason'], 'stop_timeout')
        self.assertNotIn('private-error', output.getvalue())

    def check_live_capture(self, ignores_term, orphan=False):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            command = directory / 'xcrun'
            descendant = directory / 'descendant'
            stream = 'import os,signal,time\n' + ('signal.signal(signal.SIGTERM,signal.SIG_IGN)\n' if ignores_term else '') + ('open(' + repr(str(descendant)) + ',"w").write(str(os.getpid())+" "+str(os.getpgrp()))\n' if orphan else '') + 'print(' + repr(self.line(self.value)) + ',flush=True)\nwhile True:time.sleep(1)\n'
            command.write_text('#!' + sys.executable + '\nimport subprocess,sys\nassert "--level" in sys.argv and "info" in sys.argv\n' + ('subprocess.Popen([sys.executable,"-u","-c",' + repr(stream) + '])\n' if orphan else stream))
            command.chmod(0o700)
            output = directory / 'receipts.jsonl'
            child = subprocess.Popen([sys.executable, '-B', str(Path(capture.__file__)), 'synthetic-simulator', str(output)], env={**os.environ, 'PATH': str(directory) + os.pathsep + os.environ.get('PATH', '')}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while (not output.exists() or '"phase":"ready"' not in output.read_text()) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(output.exists() and '"phase":"ready"' in output.read_text())
                child.terminate()
                stdout, stderr = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0)
                self.assertEqual(stdout + stderr, b'')
                values = [json.loads(line) for line in output.read_text().splitlines()]
                self.assertEqual(values[0], {'event': 'capture_started'})
                self.assertEqual(values[-1], {'event': 'capture_status', 'reason': 'stopped', 'traceReady': True, 'records': 1, 'limited': False})
                self.assertNotIn('system metadata', output.read_text())
                if orphan:
                    pid, _ = map(int, descendant.read_text().split())
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        status = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
                        if not status or status.startswith('Z'):
                            break
                        time.sleep(0.025)
                    self.assertTrue(not status or status.startswith('Z'), 'An owned descendant must be killed even after its stream leader has exited')
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=5)
                if descendant.exists():
                    _, group = map(int, descendant.read_text().split())
                    try:
                        os.killpg(group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_live_capture_terminates_its_child_and_retains_status_without_raw_log_metadata(self):
        self.check_live_capture(False)

    def test_sigterm_ignoring_stream_cannot_block_capture_exit_or_hide_status(self):
        self.check_live_capture(True)

    def test_sigterm_ignoring_descendant_holding_stdout_is_killed_after_leader_exit(self):
        self.check_live_capture(True, orphan=True)


if __name__ == '__main__':
    unittest.main()
