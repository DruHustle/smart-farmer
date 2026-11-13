"""Locate the decline button on the observed English iOS AutoFill sheet."""
import csv
import json
import io
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict


def not_now_point(image, device):
    # The iPhone uses separate same-row buttons. Sparse-text mode reads both.
    mode = ["--psm", "11"] if device == "iphone" else []
    tsv = subprocess.check_output(["tesseract", image, "stdout", "-l", "eng", *mode, "tsv"],
                                  text=True, stderr=subprocess.DEVNULL)
    words_by_line = defaultdict(list)
    page_size = None
    for row in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        if row["level"] == "1":
            page_size = int(row["width"]), int(row["height"])
        if row["level"] == "5" and row["text"]:
            line = tuple(row[field] for field in ("page_num", "block_num", "par_num", "line_num"))
            words_by_line[line].append(row)
    if not page_size:
        return None
    matches = {}
    for words in words_by_line.values():
        label = " ".join(word["text"] for word in words).strip().lower()
        if label in ("save password?", "save", "not now"):
            if label in matches:
                return None
            left = min(int(w["left"]) for w in words)
            right = max(int(w["left"]) + int(w["width"]) for w in words)
            top = min(int(w["top"]) for w in words)
            bottom = max(int(w["top"]) + int(w["height"]) for w in words)
            matches[label] = (left + right) / 2, (top + bottom) / 2
    body = " ".join(w["text"].lower() for words in words_by_line.values() for w in words)
    if set(matches) != {"save password?", "save", "not now"} or "securely store your password" not in body:
        return None
    width, height = page_size
    title, save, decline = (matches[k] for k in ("save password?", "save", "not now"))
    if device == "iphone":
        if not (title[1] < min(save[1], decline[1]) and decline[0] < save[0]
                and abs(save[1] - decline[1]) <= height * 0.02):
            return None
    elif not (title[1] < save[1] < decline[1] and abs(save[0] - decline[0]) <= width * 0.1):
        return None
    return f"{round(100 * decline[0] / width)}%,{round(100 * decline[1] / height)}%"


RECORD_CHECKPOINTS = {
    "Assertion is false: id: tab-record is visible",
    "Assertion is false: id: tab-record, selected is visible",
}
SHEET_BODY = r"^Securely store your password so it’s filled automatically the next time you need it\.$"
DEVICE_LOSS = "maestro.DeviceUnreachableException: Device became unreachable during deviceInfo"
STATIC_LOSS = "maestro.DeviceUnreachableException: Device became unreachable during isScreenStatic"


def lost_after_submit(trace):
    # Match the contiguous Maestro 2.12 stack, including the scope of each tap.
    # Accept no other interrupted command and never replay credential submission.
    expected = [
        ("tapOnElement", "COMPLETED"), ("runFlowCommand", "RUNNING"),
        ("assertConditionCommand", "COMPLETED"), ("runFlowCommand", "RUNNING"),
        ("applyConfigurationCommand", "COMPLETED"), ("tapOnElement", "RUNNING"),
    ]
    tail = trace[-len(expected):]
    if len(tail) != len(expected):
        return False
    for entry, (kind, status) in zip(tail, expected):
        if list(entry["command"]) != [kind] or entry["metadata"]["status"] != status:
            return False
    submit, platform, hidden, sheet, config, decline = [
        next(iter(entry["command"].values())) for entry in tail
    ]
    control = {"idRegex": "auth-submit", "optional": False}
    return (submit["selector"] == control and submit["optional"] is False
            and platform["condition"] == {"platform": "IOS"}
            and hidden["condition"] == {"notVisible": control} and hidden["optional"] is False
            and sheet["sourceDescription"] == "dismiss-password-save.yaml"
            and config["config"] == {"appId": "eu.onesa.smartfarmer"}
            and decline["optional"] is True and decline["selector"] == {
                "textRegex": "^Not Now$", "optional": True,
                "below": {"textRegex": SHEET_BODY, "optional": False},
            })


def restored_invoice_login(trace):
    # Confirm the intact original preview, explicit upload, actual restart and
    # reauthentication. The continuation can then read only this restored draft.
    def control(entry, command, key):
        value = entry["command"].get(command, {})
        target = value.get("condition", {}).get("visible") if command == "assertConditionCommand" else value.get("selector")
        return entry["metadata"]["status"] == "COMPLETED" and target == {"idRegex": key, "optional": False}

    i = 0
    for command, key in [
        ("assertConditionCommand", "invoice-local-source-image"),
        ("assertConditionCommand", "^invoice-upload-[0-9a-f-]+$"),
        ("stopAppCommand", None), ("launchAppCommand", None),
        ("assertConditionCommand", "device-reauthenticate"),
        ("tapOnElement", "device-reauthenticate"),
        ("assertConditionCommand", "auth-username"),
    ]:
        while i < len(trace):
            current = trace[i]
            i += 1
            if key is None:
                matched = command in current["command"] and current["metadata"]["status"] == "COMPLETED"
            else:
                matched = control(current, command, key)
            if matched:
                break
        else:
            return False
    return lost_after_submit(trace[i:])


def checkpoint(report, commands):
    tests = ET.parse(report).findall(".//testcase")
    invoice = "smart-farmer-frontend/mobile/acceptance/accounting-intake-check-local.yaml"
    if len(tests) != 1 or tests[0].get("file") not in {
        invoice,
        "smart-farmer-frontend/mobile/acceptance/login.yaml",
        "smart-farmer-frontend/mobile/acceptance/reconcile-signin.yaml",
    }:
        return None
    failures = tests[0].findall("failure")
    if len(failures) != 1 or not failures[0].text:
        return None
    failure = failures[0].text
    if tests[0].get("file") == invoice:
        if failure.splitlines()[0] not in {DEVICE_LOSS, STATIC_LOSS}:
            return None
        with open(commands, encoding="utf-8") as stream:
            return "invoice-restored-postlogin" if restored_invoice_login(json.load(stream)) else None
    if failure in RECORD_CHECKPOINTS:
        return "record-assertion"
    if failure.splitlines()[0] == DEVICE_LOSS:
        with open(commands, encoding="utf-8") as stream:
            if lost_after_submit(json.load(stream)):
                return "submitted-driver-lost"
    return None


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "checkpoint":
        try:
            phase = checkpoint(sys.argv[2], sys.argv[3])
        except (OSError, ET.ParseError, KeyError, TypeError, ValueError):
            phase = None
        if not phase:
            sys.exit("The device did not stop at a recognized post-login checkpoint.")
        print(phase)
    elif len(sys.argv) == 4 and sys.argv[1] == "locate" and sys.argv[3] in ("iphone", "ipad"):
        point = not_now_point(sys.argv[2], sys.argv[3])
        if not point:
            sys.exit("The current screenshot does not identify the system password sheet.")
        print(point)
    else:
        sys.exit("Specify checkpoint REPORT COMMANDS or locate SCREENSHOT iphone|ipad.")
