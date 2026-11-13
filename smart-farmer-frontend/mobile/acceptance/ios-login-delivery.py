"""Classify one lost login response in the isolated iPhone accounting fixture."""
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


def one_lost_session(evidence):
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


if __name__ == "__main__":
    try:
        accepted = len(sys.argv) == 2 and one_lost_session(Path(sys.argv[1]))
    except (OSError, ValueError, IndexError, TypeError, KeyError, ET.ParseError):
        accepted = False
    sys.exit(0 if accepted else 1)
