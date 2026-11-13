"""Regressions for the observed XCTest disconnect after credential submission."""
import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

spec = importlib.util.spec_from_file_location("password_sheet", Path(__file__).with_name("ios-password-sheet.py"))
sheet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sheet)


def trace():
    submit = {"idRegex": "auth-submit", "optional": False}
    decline = {"textRegex": "^Not Now$", "optional": True,
               "below": {"textRegex": sheet.SHEET_BODY, "optional": False}}
    events = [
        ("tapOnElement", "COMPLETED", {"selector": submit, "optional": False}),
        ("runFlowCommand", "RUNNING", {"condition": {"platform": "IOS"}}),
        ("assertConditionCommand", "COMPLETED", {"condition": {"notVisible": submit}, "optional": False}),
        ("runFlowCommand", "RUNNING", {"sourceDescription": "dismiss-password-save.yaml"}),
        ("applyConfigurationCommand", "COMPLETED", {"config": {"appId": "eu.onesa.smartfarmer"}}),
        ("tapOnElement", "RUNNING", {"selector": decline, "optional": True}),
    ]
    return [{"command": {kind: data}, "metadata": {"status": status}} for kind, status, data in events]


class SubmittedLogin(unittest.TestCase):
    def checkpoint(self, failure, commands, flow="login"):
        with tempfile.TemporaryDirectory() as directory:
            root = ET.Element("testsuite")
            case = ET.SubElement(root, "testcase", file=f"smart-farmer-frontend/mobile/acceptance/{flow}.yaml")
            ET.SubElement(case, "failure").text = failure
            report = Path(directory, "result.xml")
            ET.ElementTree(root).write(report)
            evidence = Path(directory, "commands.json")
            evidence.write_text(json.dumps(commands))
            return sheet.checkpoint(report, evidence)

    def test_observed_login_and_reauthentication(self):
        for flow in ("login", "reconcile-signin"):
            self.assertEqual(self.checkpoint(sheet.DEVICE_LOSS + "\n  at driver", trace(), flow),
                             "submitted-driver-lost")

    def test_first_visibility_wait_requires_exactly_one_confirmed_session_from_that_tap(self):
        entries = trace()[:3]
        entries[-1]["metadata"]["status"] = "RUNNING"
        entries[0]["metadata"]["timestamp"] = 1700000000000
        with tempfile.TemporaryDirectory() as directory:
            proxy = Path(directory, "proxy.log")
            rows = [{"method": "POST", "route": "/v1/sessions", "status": status, "timestamp": stamp}
                    for status, stamp in [("pending", "2023-11-14T22:13:21Z"), (200, "2023-11-14T22:13:22Z")]]
            def accepts(events):
                proxy.write_text("".join("[native-proxy] " + json.dumps(row) + "\n" for row in events))
                return sheet.submitted_session_response(entries, proxy)
            self.assertTrue(accepts(rows))
            self.assertFalse(accepts(rows[:1]))
            self.assertFalse(accepts(rows + rows))
            self.assertFalse(accepts([rows[0], {**rows[1], "status": 403}]))
            self.assertFalse(accepts([rows[0], {**rows[1], "timestamp": "2023-11-14T22:17:22Z"}]))
            entries[0]["metadata"]["status"] = "RUNNING"
            self.assertFalse(accepts(rows))

    def test_unrecognized_loss_cannot_resume(self):
        self.assertIsNone(self.checkpoint("Device unreachable", trace()))
        self.assertIsNone(self.checkpoint(sheet.DEVICE_LOSS, trace(), "accounting-intake-post"))
        self.assertIsNone(self.checkpoint(sheet.DEVICE_LOSS, trace()[:-3]))
        self.assertIsNone(self.checkpoint(sheet.DEVICE_LOSS, trace() + trace()[:1]))
        for index in range(6):
            incomplete = trace()
            incomplete[index]["metadata"]["status"] = "PENDING"
            self.assertIsNone(self.checkpoint(sheet.DEVICE_LOSS, incomplete))
        for index, kind, field, value in [
            (0, "tapOnElement", "selector", {"idRegex": "auth-username", "optional": False}),
            (1, "runFlowCommand", "condition", {"platform": "ANDROID"}),
            (2, "assertConditionCommand", "condition", {"visible": {"idRegex": "auth-submit"}}),
            (3, "runFlowCommand", "sourceDescription", "other.yaml"),
            (4, "applyConfigurationCommand", "config", {"appId": "other"}),
            (5, "tapOnElement", "selector", {"textRegex": "^Continue$"}),
        ]:
            alternate = trace()
            alternate[index]["command"][kind][field] = value
            self.assertIsNone(self.checkpoint(sheet.DEVICE_LOSS, alternate))

    def test_record_tap_requires_prior_visibility_and_the_exact_failed_control(self):
        failure = "Element not found: Id matching regex: tab-record, Enabled"
        visible = {"metadata": {"status": "COMPLETED"}, "command": {
            "assertConditionCommand": {"condition": {"visible": {"idRegex": "tab-record", "optional": False}}}}}
        tap = {"metadata": {"status": "FAILED"}, "command": {
            "tapOnElement": {"selector": {"idRegex": "tab-record", "enabled": True, "optional": False}}}}
        self.assertEqual(self.checkpoint(failure, [visible, tap]), "record-tap")
        self.assertIsNone(self.checkpoint(failure, [tap]))
        self.assertIsNone(self.checkpoint(failure, [visible, tap, visible]))
        tap["command"]["tapOnElement"]["selector"]["idRegex"] = "other-tab"
        self.assertIsNone(self.checkpoint(failure, [visible, tap]))

    def test_previous_record_failures_still_require_frame_check(self):
        for failure in sheet.RECORD_CHECKPOINTS:
            self.assertEqual(self.checkpoint(failure, []), "record-assertion")


    def test_invoice_requires_draft_restart_and_exact_driver_disconnect(self):
        def visible(key):
            return {"command": {"assertConditionCommand": {"condition": {"visible": {"idRegex": key, "optional": False}}}},
                    "metadata": {"status": "COMPLETED"}}

        def completed(name, value):
            return {"command": {name: value}, "metadata": {"status": "COMPLETED"}}

        prefix = [visible("invoice-local-source-image"), visible("^invoice-upload-[0-9a-f-]+$"),
                  completed("stopAppCommand", {}), completed("launchAppCommand", {}),
                  visible("device-reauthenticate"), completed("tapOnElement", {"selector": {"idRegex": "device-reauthenticate", "optional": False}}),
                  visible("auth-username")]
        flow = "accounting-intake-check-local"
        self.assertEqual(self.checkpoint(sheet.STATIC_LOSS, prefix + trace(), flow), "invoice-restored-postlogin")
        self.assertIsNone(self.checkpoint(sheet.STATIC_LOSS, prefix[1:] + trace(), flow))
        self.assertIsNone(self.checkpoint(sheet.STATIC_LOSS, prefix[:2] + prefix[3:] + trace(), flow))
        self.assertIsNone(self.checkpoint(sheet.STATIC_LOSS, prefix + trace()[:-1], flow))
        self.assertIsNone(self.checkpoint("Missing element: invoice-local-source-image", prefix + trace(), flow))
        self.assertIsNone(self.checkpoint(sheet.STATIC_LOSS, prefix + trace(), "accounting-intake-post"))
        shown = prefix[4]["command"]["assertConditionCommand"]["condition"]["visible"]
        tapped = prefix[5]["command"]["tapOnElement"]["selector"]
        for selector in (shown, tapped):
            selector["enabled"] = True
        self.assertEqual(self.checkpoint(sheet.DEVICE_LOSS, prefix + trace(), flow), "invoice-restored-postlogin")
        for selector in (shown, tapped):
            selector["enabled"] = False
            self.assertIsNone(self.checkpoint(sheet.DEVICE_LOSS, prefix + trace(), flow))
            selector["enabled"] = True

if __name__ == "__main__":
    unittest.main()
