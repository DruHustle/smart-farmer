#!/usr/bin/env python3
"""Retain only bounded, allowlisted acceptance receipts from the iOS INFO stream."""
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time

PREFIX = 'SF_SESSION_TRACE '
LIMIT = 128
STAGES = frozenset(('trace', 'unlock_press', 'sign_out_press', 'unlock', 'sign_out', 'session_delete', 'notifications_cleanup', 'notification_unregister', 'notification_cancel', 'notification_dismiss', 'channels_read', 'channels_write', 'local_session_clear', 'auth_screen', 'farm_touch', 'farm_press', 'tab_today', 'tab_farm', 'tab_record', 'tab_more'))
PHASES = frozenset(('ready', 'received', 'start', 'complete', 'failed', 'blocked', 'fallback', 'queued', 'committed', 'cancelled', 'limit'))


def parse_receipt(line):
    if PREFIX not in line:
        return None
    payload = line.split(PREFIX, 1)[1].strip()
    if len(payload) > 240:
        return None
    try:
        value = json.loads(payload)
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or set(value) != {'at', 'sequence', 'elapsed_ms', 'stage', 'phase'}:
        return None
    if not isinstance(value['at'], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value['at']):
        return None
    if type(value['sequence']) is not int or not 1 <= value['sequence'] <= LIMIT:
        return None
    if type(value['elapsed_ms']) is not int or not 0 <= value['elapsed_ms'] <= 86_400_000:
        return None
    if not isinstance(value['stage'], str) or value['stage'] not in STAGES or not isinstance(value['phase'], str) or value['phase'] not in PHASES:
        return None
    return value


class Receipts:
    def __init__(self, output):
        self.output = output
        self.count = 0
        self.ready = False
        self.limited = False

    def write(self, value):
        self.output.write(json.dumps(value, separators=(',', ':')) + '\n')
        self.output.flush()

    def accept(self, line):
        value = parse_receipt(line)
        if value is None:
            return
        if self.count >= LIMIT:
            if not self.limited:
                self.write({'event': 'capture_limit'})
                self.limited = True
            return
        self.count += 1
        self.ready = self.ready or (value['stage'] == 'trace' and value['phase'] == 'ready')
        self.write(value)

    def finish(self, reason):
        self.write({'event': 'capture_status', 'reason': reason, 'traceReady': self.ready, 'records': self.count, 'limited': self.limited})


def stop_capture_group(child):
    # The leader may already have exited while an owned descendant still holds stdout.
    def signal_group(value):
        try:
            os.killpg(child.pid, value)
        except ProcessLookupError:
            return 'gone'
        except PermissionError:
            return 'denied'
        except OSError:
            return 'failed'
        return 'sent'

    result = signal_group(signal.SIGTERM)
    deadline = time.monotonic() + 2
    while result == 'sent':
        child.poll()
        result = signal_group(0)
        if result != 'sent':
            break
        if time.monotonic() >= deadline:
            result = signal_group(signal.SIGKILL)
            break
        time.sleep(0.025)
    # A denied group must not be probed/signalled again or treated as cleaned up.
    failure = {'denied': 'stop_denied', 'failed': 'stop_failed'}.get(result)
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return failure or 'stop_timeout'
    return failure


def finish_capture(child, receipts, reason):
    cleanup_reason = 'stop_failed'
    try:
        cleanup_reason = stop_capture_group(child) or reason
    except Exception:
        # Retain a fixed failure category, never an exception's private details.
        pass
    finally:
        final_reason = cleanup_reason if cleanup_reason not in ('stopped', 'stream_ended') else 'close_failed'
        try:
            child.stdout.close()
            final_reason = cleanup_reason
        except Exception:
            pass
        finally:
            receipts.finish(final_reason)


def capture(device, path):
    # Never retain the surrounding system log metadata, raw errors or other app messages.
    predicate = 'process == "SmartFarmer" AND subsystem == "com.facebook.react.log" AND category == "javascript" AND eventMessage BEGINSWITH "SF_SESSION_TRACE "'
    child = None
    stopping = False

    def stop(_signal=None, _frame=None):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with open(path, 'w', encoding='utf-8') as output:
        receipts = Receipts(output)
        try:
            child = subprocess.Popen(['xcrun', 'simctl', 'spawn', device, 'log', 'stream', '--style', 'syslog', '--level', 'info', '--predicate', predicate], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            receipts.finish('launch_failed')
            return
        receipts.write({'event': 'capture_started'})
        try:
            # A blocked/partial stdout line must not prevent EXIT from stopping capture.
            os.set_blocking(child.stdout.fileno(), False)
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                pending = b''
                ended = False
                while not stopping and not ended:
                    for key, _ in selector.select(timeout=0.25):
                        chunk = os.read(key.fd, 4096)
                        if not chunk:
                            ended = True
                            break
                        lines = (pending + chunk).split(b'\n')
                        pending = lines.pop()
                        if len(pending) > 4096:
                            pending = b''
                        for line in lines:
                            receipts.accept(line.decode('utf-8', errors='replace'))
        finally:
            reason = 'stopped' if stopping else 'stream_ended'
            finish_capture(child, receipts, reason)


if __name__ == '__main__':
    capture(sys.argv[1], sys.argv[2])
