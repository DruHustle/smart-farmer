"""Retain bounded, secret-free XCTest failure metadata and pre-input screenshots."""
import json
import re
import subprocess
import sys
from pathlib import Path


CHECKPOINTS = set("fixture signedOut localLauncher introduction developerMenu signInControl consent email password remember firstSubmit mfa secondSubmit returnLink nativeInvitation joinFarm farmWorkspace forumTab forumScreen forumFeed completed test-launch".split())
PATTERNS = {
    "execution-timeout": r"exceeded (?:its |the )?execution time allowance|test (?:case )?.{0,180}timed out|test execution time allowance",
    "snapshot-failure": r"failed to (?:get|take|fetch).{0,100}(?:snapshot|screenshot)|unable to (?:get|take|fetch).{0,100}(?:snapshot|screenshot)",
    "application-not-running": r"application.{0,160}(?:is not running|isn't running|not running)",
    "runner-connection": r"failed to establish communication with the test runner|test runner never began|lost connection to the test runner|failed to get automation session",
    "assertion-failure": r"XCTUnwrap failed|XCTAssert\w* failed|assertion failure",
    "runner-exit": r"early unexpected exit|test runner exited|test runner.{0,80}crashed",
}


def classify(log, role, checkpoint):
    if role not in {"cancel", "member", "admin"} or checkpoint not in CHECKPOINTS:
        raise ValueError("Invalid diagnostic identity")
    return {
        "version": 1,
        "role": role,
        "checkpoint": checkpoint,
        "signals": [name for name, pattern in PATTERNS.items() if re.search(pattern, log, re.IGNORECASE)],
        "sourceLines": sorted({int(line) for line in re.findall(r"PortalColdTests\.swift:(\d{1,5})(?::\d+)?:", log) if 0 < int(line) < 10000})[:20],
    }


def capture(device, evidence, role, checkpoint):
    # Consent is before any input in both tests. Later checkpoints can contain
    # credentials or private fixture records and must never produce a screenshot.
    if checkpoint != "consent":
        return "not-requested"
    if not re.fullmatch(r"[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}", device):
        return "invalid-device"
    try:
        result = subprocess.run(
            ["xcrun", "simctl", "io", device, "screenshot", str(evidence / f"ios-{role}-consent.png")],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False,
        )
        return "captured" if result.returncode == 0 else "unavailable"
    except subprocess.TimeoutExpired:
        return "timeout"
    except OSError:
        return "unavailable"


def main(args):
    if len(args) != 5:
        raise ValueError("Invalid diagnostic arguments")
    log_path, role, checkpoint, device, directory = args
    with Path(log_path).open("rb") as stream:
        stream.seek(0, 2)
        stream.seek(max(0, stream.tell() - 1024 * 1024))
        log = stream.read().decode("utf-8", errors="replace")
    receipt = classify(log, role, checkpoint)
    evidence = Path(directory)
    evidence.mkdir(parents=True, exist_ok=True)
    receipt["screenshot"] = capture(device, evidence, role, checkpoint)
    (evidence / f"ios-{role}-failure.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
