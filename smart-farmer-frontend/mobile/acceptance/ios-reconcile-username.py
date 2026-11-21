"""Fail-closed classifier for the observed iOS pre-submit missing character.

Only a real signed-out accessibility frame and exact Maestro command trace
permit a single fresh credential-entry attempt. Never resume after a submit.
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

RECONCILE = "smart-farmer-frontend/mobile/acceptance/reconcile-signin.yaml"
LOGIN = "smart-farmer-frontend/mobile/acceptance/login.yaml"
ALLOWED_FLOWS = frozenset((RECONCILE, LOGIN))
FAILURE = 'Assertion is false: "^native_owner$", id: auth-username is visible'
EXPECTED = "native_owner"
TARGET = {"visible": {"idRegex": "auth-username", "textRegex": "^native_owner$", "optional": False}}


def safe_username_retry(report, commands, hierarchy):
    try:
        report, commands, hierarchy = map(Path, (report, commands, hierarchy))
        if commands.stat().st_size > 2_000_000 or report.stat().st_size > 100_000:
            return False
        cases = ET.parse(report).findall(".//testcase")
        if len(cases) != 1 or cases[0].get("file") not in ALLOWED_FLOWS:
            return False
        failures = cases[0].findall("failure")
        if len(failures) != 1 or failures[0].text != FAILURE:
            return False
        trace = json.loads(commands.read_text(encoding="utf-8"))
        if not isinstance(trace, list) or len(trace) > 100:
            return False
        last = trace[-1]
        if (last.get("metadata", {}).get("status") != "FAILED"
                or last.get("command", {}).get("assertConditionCommand", {}).get("condition") != TARGET):
            return False
        # Credential entry previously used one command per character, but the
        # current Maestro fixture uses a single bulk inputText. Both must be
        # followed immediately by the exact failed username assertion.
        previous = trace[:-1]
        typed_separately = (
            len(previous) >= len(EXPECTED)
            and all(row.get("metadata", {}).get("status") == "COMPLETED"
                    and row.get("command", {}).get("inputTextCommand", {}).get("text") == char
                    for row, char in zip(previous[-len(EXPECTED):], EXPECTED))
        )
        typed_in_bulk = (
            bool(previous)
            and previous[-1].get("metadata", {}).get("status") == "COMPLETED"
            and previous[-1].get("command", {}).get("inputTextCommand", {}).get("text") == EXPECTED
        )
        if not (typed_separately or typed_in_bulk):
            return False
        # No session may have been submitted anywhere in this UI attempt.
        if any(row.get("command", {}).get("tapOnElement", {}).get("selector", {}).get("idRegex") == "auth-submit"
               for row in trace):
            return False
        frames = list(hierarchy.glob("step-*-assertCondition-^native_owner$.json"))
        if len(frames) != 1 or frames[0].stat().st_size > 1_000_000:
            return False
        nodes = [json.loads(frames[0].read_text(encoding="utf-8"))]
        controls = {}
        examined = 0
        while nodes:
            node = nodes.pop()
            examined += 1
            if examined > 5000 or not isinstance(node, dict):
                return False
            attr = node.get("attributes", {})
            key = attr.get("resource-id")
            if key in {"auth-username", "auth-password", "auth-submit"}:
                if key in controls:
                    return False
                controls[key] = attr
            nodes.extend(node.get("children", []))
        # iPad run 44905808303 observed exactly "n" after a completed
        # single bulk inputText command. The older character-by-character
        # flow observed exactly "ntive_owner". Do not authorize other values,
        # other command sequences, passwords, or any submitted session.
        typed_value = controls["auth-username"].get("value")
        exact_observed_loss = (
            (typed_in_bulk and typed_value == "n")
            or (typed_separately and typed_value == "ntive_owner")
        )
        return (set(controls) == {"auth-username", "auth-password", "auth-submit"}
                and exact_observed_loss
                and controls["auth-username"].get("enabled") == "true"
                and not controls["auth-password"].get("value")
                and controls["auth-submit"].get("enabled") == "true")
    except (OSError, ValueError, TypeError, KeyError, ET.ParseError, IndexError, AttributeError):
        return False


if __name__ == "__main__":
    if len(sys.argv) != 4 or not safe_username_retry(*sys.argv[1:]):
        sys.exit(1)
    print("EXACT_PRE_SUBMIT_IOS_USERNAME_RETRY")
