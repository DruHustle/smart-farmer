"""Identify an XCTest accessibility startup failure before the first login command."""
from pathlib import Path
import re
import sys


def failed_before_test(evidence, label, device=None):
    if label not in ("ios-login", "ipad-large-font") or (evidence / (label + ".xml")).exists():
        return False
    folder = evidence / label
    excluded = ("commands.json", "manifest.json")
    if any(path.name in excluded or path.suffix == ".png" for path in folder.rglob("*")):
        return False
    runners = list(folder.glob("xctest_runner_*.log"))
    if len(runners) != 1:
        return False
    runner = runners[0].read_text()
    if label == "ipad-large-font":
        # The driver cannot send even its first UI command when Xcode does not
        # enumerate the exact simulator that simctl just booted.
        if not device or not re.fullmatch(r"[0-9a-fA-F-]{36}", device):
            return False
        missing = "Unable to find a device matching the provided destination specifier:"
        if missing not in runner or not re.search(r"\{\s*id:\s*" + re.escape(device) + r"\s*\}", runner):
            return False
        if "name:Any iOS Simulator Device" not in runner:
            return False
    elif ("The test runner failed to initialize for UI testing. "
          "(Underlying Error: Timed out while loading Accessibility.)") not in runner:
        return False
    driver = (folder / "maestro.log").read_text().splitlines()
    refused = "xcTestDriverStatusCheck: [Failed] Perform XCUITest driver status check"
    if not driver or refused not in driver[-1]:
        return False
    # The proxy is created after fixture seeding. Any UI submission or other
    # proxy activity makes initial-driver-only recovery inappropriate.
    return (evidence / "proxy.log").read_text().strip() == "Native acceptance network proxy ready."


if __name__ == "__main__":
    try:
        eligible = len(sys.argv) in (3, 4) and failed_before_test(Path(sys.argv[1]), *sys.argv[2:])
    except (OSError, UnicodeError):
        eligible = False
    sys.exit(0 if eligible else 1)
