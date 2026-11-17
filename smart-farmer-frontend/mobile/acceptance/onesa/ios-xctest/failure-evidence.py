"""Retain bounded, secret-free XCTest failure metadata and pre-input screenshots."""
import json
import re
import subprocess
import sys
from pathlib import Path


CHECKPOINTS = set("fixture reauthenticate rememberedSession signedOut localLauncher introduction developerMenu signInControl consent email password remember firstSubmit mfa secondSubmit returnLink nativeInvitation joinFarm farmWorkspace forumTab forumScreen forumFeed completed test-launch".split())
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


def classify(log, role, checkpoint):
    if role not in {"cancel", "member", "admin"} or checkpoint not in CHECKPOINTS:
        raise ValueError("Invalid diagnostic identity")
    return {
        "version": 1,
        "role": role,
        "checkpoint": checkpoint,
        "signals": [name for name, pattern in PATTERNS.items() if re.search(pattern, log, re.IGNORECASE)],
        "renderObservations": sorted(set(re.findall(
            r"^FARMER_RENDER (systemConsent|consentTapped|browserVisible|frameRequested|frameWritten|requestWriteFailed|responseTimedOut|screenshotUnavailable|displayMismatch|noForegroundOwner|recognitionUnavailable|chromeMissing|landmarksMissing|ambiguousAction|outsideOwner|actionReady)$",
            log, re.MULTILINE))),
        "sourceLines": sorted({int(line) for line in re.findall(r"PortalColdTests\.swift:(\d{1,5})(?::\d+)?:", log) if 0 < int(line) < 10000})[:20],
        "controls": [dict(zip(("phase", "owner", "control", "fact"), fact))
                     for fact in list(dict.fromkeys(CONTROL_FACT.findall(log)))[:64]],
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


def launch_retry_reason(log, summary, fixture_lines, initial_lines):
    # Never repeat a journey which started, sent an issuer request, or has a
    # test outcome. Use the entire private log here, not its diagnostics tail.
    if initial_lines < 0 or len(fixture_lines) < initial_lines or any(
        line.startswith(("ONESA_DEVICE_HTTP ", "ONESA_DEVICE_PORTAL ")) for line in fixture_lines[initial_lines:]
    ):
        return None
    if re.search(r"FARMER_XCUI_|FARMER_RENDER |Test Case[^\n]*testCancelPortal[^\n]*started", log, re.I):
        return None
    counts = [summary.get(key) for key in ("passedTests", "failedTests", "skippedTests", "totalTestCount")]
    if any(value is not None and (type(value) is not int or value != 0) for value in counts):
        return None
    if all(value == 0 for value in counts):
        return "zero-tests"
    if re.search(r"failed to (?:install or launch|install|launch) (?:the )?test runner|test runner never began", log, re.I):
        return "runner-launch"
    return None


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
    if len(sys.argv) == 6 and sys.argv[1] == "launch-retry":
        log_file, summary_file, fixture_file, initial = sys.argv[2:]
        try:
            summary = json.loads(Path(summary_file).read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            summary = {}
        reason = launch_retry_reason(Path(log_file).read_text(errors="replace"), summary,
                                     Path(fixture_file).read_text(errors="replace").splitlines(), int(initial))
        if reason is None:
            sys.exit(1)
        print(reason)
    else:
        main(sys.argv[1:])
