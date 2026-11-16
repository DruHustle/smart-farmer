"""Retain bounded, secret-free XCTest failure metadata and pre-input screenshots."""
import json
import re
import signal
import subprocess
import sys
import time
from pathlib import Path


CHECKPOINTS = set("fixture signedOut localLauncher introduction developerMenu signInControl consent email password remember firstSubmit mfa secondSubmit returnLink nativeInvitation joinFarm farmWorkspace forumTab forumScreen forumFeed completed test-launch".split())
PATTERNS = {
    "execution-timeout": r"exceeded (?:its |the )?execution time allowance|test (?:case )?.{0,180}timed out|test execution time allowance",
    "snapshot-failure": r"failed to (?:get|take|fetch).{0,100}(?:snapshot|screenshot)|unable to (?:get|take|fetch).{0,100}(?:snapshot|screenshot)",
    "hit-point-failure": r"failed to compute hit point|activation point invalid",
    "element-query-failure": r"failed to no matches found|no matches found for",
    "application-not-running": r"application.{0,160}(?:is not running|isn't running|not running)",
    "runner-connection": r"failed to establish communication with the test runner|test runner never began|lost connection to the test runner|failed to get automation session",
    "assertion-failure": r"XCTUnwrap failed|XCTAssert\w* failed|assertion failure",
    "runner-exit": r"early unexpected exit|test runner exited|test runner.{0,80}crashed",
}
CONTROL_FACT = re.compile(
    r"^FARMER_XCUI_CONTROL (startup|cancel) (farmer|safari|authSheet) "
    r"(signIn|introduction|developerMenu|localChooser|savedBundle|cancelButton|cancelLink) "
    r"(absent|present|enabled|disabled|visible-frame|not-visible-frame|hittable-query|hittable|not-hittable)$",
    re.MULTILINE,
)
ISSUER_FACT = re.compile(
    r"^FARMER_XCUI_ISSUER (farmer|safari|authSheet) (owner|web0|web1|web2) "
    r"(state|webViews|heading|remember|cancelButton|cancelLink|emailNamed|passwordNamed|emailTyped|passwordTyped) "
    r"(query|zero|one|many|unknown|suspended|background|foreground|not-running)$",
    re.MULTILINE,
)


def classify(log, role, checkpoint):
    if role not in {"cancel", "member", "admin"} or checkpoint not in CHECKPOINTS:
        raise ValueError("Invalid diagnostic identity")
    return {
        "version": 1,
        "role": role,
        "checkpoint": checkpoint,
        "signals": [name for name, pattern in PATTERNS.items() if re.search(pattern, log, re.IGNORECASE)],
        "sourceLines": sorted({int(line) for line in re.findall(r"PortalColdTests\.swift:(\d{1,5})(?::\d+)?:", log) if 0 < int(line) < 10000})[:20],
        "controls": [dict(zip(("phase", "owner", "control", "fact"), fact))
                     for fact in list(dict.fromkeys(CONTROL_FACT.findall(log)))[:64]],
        "issuerProbe": list(dict.fromkeys(re.findall(r"^FARMER_XCUI_ISSUER (begin|complete)$", log, re.MULTILINE)))[:2]
                       if checkpoint == "consent" else [],
        "issuerExposure": [dict(zip(("owner", "scope", "target", "fact"), fact))
                           for fact in list(dict.fromkeys(ISSUER_FACT.findall(log)))[:256]]
                          if checkpoint == "consent" else [],
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


def read_tail(log_path):
    with Path(log_path).open("rb") as stream:
        stream.seek(0, 2)
        stream.seek(max(0, stream.tell() - 1024 * 1024))
        return stream.read().decode("utf-8", errors="replace")


def last_checkpoint(log):
    checkpoints = re.findall(r"^FARMER_XCUI_CHECKPOINT ([A-Za-z]+)$", log, re.MULTILINE)
    return checkpoints[-1] if checkpoints and checkpoints[-1] in CHECKPOINTS else None


def watch_cancel(log_path, device, directory):
    # This watcher runs only for the cancellation test, which never loads or
    # enters credentials. simctl reads the frame without starting a UI driver.
    # Take the live blocking screen before XCTest's timeout can tear it down.
    deadline = time.monotonic() + 450
    while time.monotonic() < deadline:
        try:
            checkpoint = last_checkpoint(read_tail(log_path))
        except FileNotFoundError:
            checkpoint = None
        if checkpoint == "consent":
            time.sleep(3)
            if last_checkpoint(read_tail(log_path)) == "consent":
                capture(device, Path(directory), "cancel-live", "consent")
            return
        if checkpoint in {"returnLink", "completed"}:
            return
        time.sleep(1)


def main(args):
    if len(args) != 5:
        raise ValueError("Invalid diagnostic arguments")
    log_path, role, checkpoint, device, directory = args
    log = read_tail(log_path)
    receipt = classify(log, role, checkpoint)
    evidence = Path(directory)
    evidence.mkdir(parents=True, exist_ok=True)
    receipt["screenshot"] = capture(device, evidence, role, checkpoint)
    (evidence / f"ios-{role}-failure.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    # subprocess.run kills its child when interrupted by SystemExit, so the
    # owning shell can stop this bounded watcher without leaving simctl behind.
    def stop(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    if len(sys.argv) == 5 and sys.argv[1] == "watch-cancel":
        watch_cancel(*sys.argv[2:])
    else:
        main(sys.argv[1:])
