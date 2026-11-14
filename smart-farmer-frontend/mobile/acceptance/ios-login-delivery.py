"""Classify a single initial login attempt from the isolated iPhone invoice fixture."""
import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path


def observations(path, prefix):
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Unexpected observation size")
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line[len(prefix):]) for line in stream if line.startswith(prefix)]


def millis(value):
    return round(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def initial_submit_window(evidence):
    report = ET.parse(evidence / "ios-login.xml")
    cases = report.findall(".//testcase")
    if len(cases) != 1 or cases[0].get("file") != "smart-farmer-frontend/mobile/acceptance/login.yaml":
        return False
    failures = cases[0].findall("failure")
    if len(failures) != 1 or failures[0].text != "Assertion is false: id: auth-submit is not visible":
        return False
    trace = json.loads((evidence / "ios-login/login/commands.json").read_text())
    tap, platform, wait = trace[-3:]
    target = {"idRegex": "auth-submit", "optional": False}
    if (tap["metadata"]["status"] != "COMPLETED" or tap["command"]["tapOnElement"]["selector"] != target
            or platform["metadata"]["status"] != "FAILED" or platform["command"]["runFlowCommand"]["condition"] != {"platform": "IOS"}
            or wait["metadata"]["status"] != "FAILED" or wait["command"]["assertConditionCommand"]["condition"] != {"notVisible": target}):
        return False
    first = int(tap["metadata"]["timestamp"])
    last = int(wait["metadata"]["timestamp"]) + int(wait["metadata"]["duration"])
    return first, last


def one_lost_session(evidence):
    window = initial_submit_window(evidence)
    if not window:
        return False
    first, last = window
    proxy = [r for r in observations(evidence / "proxy.log", "[native-proxy] ")
             if first <= millis(r["timestamp"]) <= last]
    if [r.get("status") for r in proxy] != ["pending", "closed"] or not all(
        r.get("method") == "POST" and r.get("route") == "/v1/sessions" for r in proxy
    ):
        return False
    api = [r for r in observations(evidence / "api.log", "[native-api] ") if first <= millis(r["time"]) <= last]
    starts = [r for r in api if r.get("event") == "request.start"]
    if len(starts) != 1 or starts[0].get("method") != "POST" or starts[0].get("path") != "/v1/sessions":
        return False
    finishes = [r for r in api if r.get("event") == "response.finish" and r.get("id") == starts[0]["id"]]
    return (len(finishes) == 1 and finishes[0].get("status") == 200 and finishes[0].get("finished") is True
            and millis(proxy[0]["timestamp"]) <= millis(starts[0]["time"]) <= millis(proxy[1]["timestamp"])
            <= millis(finishes[0]["time"]))


def rejected_before_request(evidence):
    window = initial_submit_window(evidence)
    if not window:
        return False
    first, last = window
    api = observations(evidence / "api.log", "[native-api] ")
    proxy = observations(evidence / "proxy.log", "[native-proxy] ")
    beats = sorted(millis(r["time"]) for r in api if r.get("event") == "heartbeat" and not r.get("pending"))
    # Verify the real API stayed observable across the entire UI attempt.
    if not any(first - 10_000 <= t <= first for t in beats) or not any(last <= t <= last + 10_000 for t in beats):
        return False
    observed = [t for t in beats if first - 10_000 <= t <= last + 10_000]
    if any(b - a > 10_000 for a, b in zip(observed, observed[1:])):
        return False
    if not any(r.get("status") == 200 and millis(r["timestamp"]) < first for r in proxy):
        return False
    if any(first <= millis(r["timestamp"]) <= last and r.get("method") == "POST" for r in proxy):
        return False
    if any(first <= millis(r["time"]) <= last and r.get("event") != "heartbeat" for r in api):
        return False
    root = evidence / "ios-login/login/screen-hierarchy"
    frames = list(root.glob("step-*-assertCondition-auth-submit.json"))
    if len(frames) != 1 or frames[0].stat().st_size > 1024 * 1024:
        return False
    pending = [json.loads(frames[0].read_text())]
    controls = {}
    required = False
    while pending:
        node = pending.pop()
        a = node["attributes"]
        required |= a.get("accessibilityText") == "Zadza mashoko anodiwa."
        key = a.get("resource-id")
        if key in ("auth-username", "auth-password", "auth-submit"):
            if key in controls or a.get("enabled") != "true":
                return False
            controls[key] = a.get("value", "")
        pending.extend(node.get("children", []))
    password = controls.get("auth-password", "")
    return (required and controls.get("auth-username") == "native_owner" and "auth-submit" in controls
            and len(password) == 25 and set(password) <= {"•", "●"})


if __name__ == "__main__":
    try:
        action = {"closed-response": one_lost_session, "client-validation": rejected_before_request}[sys.argv[2]]
        accepted = len(sys.argv) == 3 and action(Path(sys.argv[1]))
    except (OSError, ValueError, IndexError, TypeError, KeyError, ET.ParseError):
        accepted = False
    sys.exit(0 if accepted else 1)
