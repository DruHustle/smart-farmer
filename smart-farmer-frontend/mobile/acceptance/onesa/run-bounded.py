"""Bound a private simulator driver process and its descendants on macOS."""

import os
import signal
import subprocess
import sys


def run(seconds, command):
    if seconds <= 0 or not command:
        raise ValueError("Expected a positive timeout and a command")
    child = subprocess.Popen(command, start_new_session=True)
    try:
        return child.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        # Xcode and Maestro may leave a local server behind after Java exits.
        # Kill only the process group created for this individual invocation.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        return 124


if __name__ == "__main__":
    sys.exit(run(int(sys.argv[1]), sys.argv[2:]))
