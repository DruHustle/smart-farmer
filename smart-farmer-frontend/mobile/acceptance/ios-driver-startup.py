"""Identify an XCTest accessibility startup failure before the first login command."""
from pathlib import Path
import sys


def failed_before_test(evidence, label):
    if label != "ios-login" or (evidence / (label + ".xml")).exists():
        return False
    folder = evidence / label
    excluded = ("commands.json", "manifest.json")
    if any(path.name in excluded or path.suffix == ".png" for path in folder.rglob("*")):
        return False
    runners = list(folder.glob("xctest_runner_*.log"))
    if len(runners) != 1:
        return False
    expected = ("The test runner failed to initialize for UI testing. "
                "(Underlying Error: Timed out while loading Accessibility.)")
    driver = (folder / "maestro.log").read_text().splitlines()
    refused = "xcTestDriverStatusCheck: [Failed] Perform XCUITest driver status check"
    if expected not in runners[0].read_text() or not driver or refused not in driver[-1]:
        return False
    # The proxy is created after fixture seeding. Any UI submission or other
    # proxy activity makes initial-driver-only recovery inappropriate.
    return (evidence / "proxy.log").read_text().strip() == "Native acceptance network proxy ready."


if __name__ == "__main__":
    try:
        eligible = len(sys.argv) == 3 and failed_before_test(Path(sys.argv[1]), sys.argv[2])
    except (OSError, UnicodeError):
        eligible = False
    sys.exit(0 if eligible else 1)
