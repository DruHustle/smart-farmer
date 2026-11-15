"""Identify a first-launch XCTest transport failure before any test command."""
from pathlib import Path
import re
import sys


def failed_before_login(evidence, device):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", device):
        return False
    trace = evidence / "ios-login"
    if (evidence / "ios-login.xml").exists() or any(
        file.name in {"commands.json", "manifest.json"} or file.suffix == ".png"
        for file in trace.rglob("*")
    ):
        return False
    if (evidence / "proxy.log").read_text().strip() != "Native acceptance network proxy ready.":
        return False
    runners = list(trace.glob("xctest_runner_*.log"))
    if len(runners) != 1 or f"id:{device}," not in runners[0].read_text():
        return False
    checks = [line for line in (trace / "maestro.log").read_text().splitlines()
              if "xcTestDriverStatusCheck:" in line]
    failure = f"[Failed] Perform XCUITest driver status check on {device}, exception: java.net.ConnectException: Failed to connect to /127.0.0.1:"
    return bool(checks) and failure in checks[-1] and all(
        f"[Start] Perform XCUITest driver status check on {device}" in line or failure in line
        for line in checks
    )


if __name__ == "__main__":
    try:
        retry = len(sys.argv) == 3 and failed_before_login(Path(sys.argv[1]), sys.argv[2])
    except (OSError, UnicodeError):
        retry = False
    sys.exit(0 if retry else 1)
