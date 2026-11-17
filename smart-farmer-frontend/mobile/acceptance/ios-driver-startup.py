"""Identify an XCTest startup failure before the first login command."""
from pathlib import Path
import json
import re
import sys
import xml.etree.ElementTree as ET


def failed_before_test(evidence, label, device=None):
    if label not in ("ios-login", "ipad-large-font"):
        return False
    folder = evidence / label
    report = evidence / (label + ".xml")
    if report.exists():
        return initial_launch_disconnected(report, folder, device) and (
            evidence / "proxy.log").read_text().strip() == "Native acceptance network proxy ready."
    excluded = ("commands.json", "manifest.json")
    if any(path.name in excluded or path.suffix == ".png" for path in folder.rglob("*")):
        return False
    runners = list(folder.glob("xctest_runner_*.log"))
    if len(runners) != 1:
        return False
    runner = runners[0].read_text()
    driver = (folder / "maestro.log").read_text().splitlines()
    # A refused transport is distinct from an Accessibility initialization
    # error, but both precede UI work. Require every status probe to be either
    # a start or this exact refusal, bound to the selected simulator.
    if device and re.fullmatch(r"[0-9a-fA-F-]{36}", device):
        probes = [line for line in driver if "xcTestDriverStatusCheck:" in line]
        failure = f"[Failed] Perform XCUITest driver status check on {device}, exception: java.net.ConnectException: Failed to connect to /127.0.0.1:"
        transport_only = f"id:{device}," in runner and bool(probes) and failure in probes[-1] and all(
            f"[Start] Perform XCUITest driver status check on {device}" in line or failure in line
            for line in probes
        )
        if transport_only:
            return (evidence / "proxy.log").read_text().strip() == "Native acceptance network proxy ready."
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
    refused = "xcTestDriverStatusCheck: [Failed] Perform XCUITest driver status check"
    if not driver or refused not in driver[-1]:
        return False
    # The proxy is created after fixture seeding. Any UI submission or other
    # proxy activity makes initial-driver-only recovery inappropriate.
    return (evidence / "proxy.log").read_text().strip() == "Native acceptance network proxy ready."


def initial_launch_disconnected(report, folder, device):
    # Maestro applies permissions before launching the bundle. Only retry a
    # refused driver connection at that first launch, before any form input.
    if not device or not re.fullmatch(r"[0-9a-fA-F-]{36}", device):
        return False
    commands = folder / "login" / "commands.json"
    if not commands.is_file():
        return False
    root = ET.parse(report)
    suites = root.findall(".//testsuite")
    cases = root.findall(".//testcase")
    if len(suites) != 1 or not suites[0].get("device", "").endswith(" - " + device):
        return False
    if len(cases) != 1 or cases[0].get("file") != "smart-farmer-frontend/mobile/acceptance/login.yaml":
        return False
    failure = cases[0].findtext("failure") or ""
    if (not failure.startswith("maestro.DeviceUnreachableException: Device became unreachable during setPermissions\n")
            or "Caused by: java.net.ConnectException: Connection refused" not in failure):
        return False
    trace = json.loads(commands.read_text())
    setup = [("defineVariablesCommand", "COMPLETED"), ("applyConfigurationCommand", "COMPLETED"),
             ("runFlowCommand", "RUNNING"), ("runFlowCommand", "RUNNING"),
             ("applyConfigurationCommand", "COMPLETED"), ("launchAppCommand", "RUNNING")]
    return (len(trace) == len(setup)
            and all(list(row["command"]) == [kind] and row["metadata"]["status"] == status
                    for row, (kind, status) in zip(trace, setup))
            and trace[2]["command"]["runFlowCommand"].get("condition") == {"platform": "IOS"}
            and trace[3]["command"]["runFlowCommand"].get("sourceDescription") == "ios-launch-bundle.yaml"
            and trace[-1]["command"]["launchAppCommand"].get("appId") == "eu.onesa.smartfarmer")


if __name__ == "__main__":
    try:
        eligible = len(sys.argv) in (3, 4) and failed_before_test(Path(sys.argv[1]), *sys.argv[2:])
    except (OSError, ValueError, TypeError, KeyError, ET.ParseError):
        eligible = False
    sys.exit(0 if eligible else 1)
