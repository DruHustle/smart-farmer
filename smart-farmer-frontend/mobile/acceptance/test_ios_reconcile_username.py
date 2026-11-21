"""Synthetic fixture checks for the exact observed pre-submit input loss."""
import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ios_reconcile_username",
    Path(__file__).with_name("ios-reconcile-username.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def command(kind, status, value):
    return {"command": {kind: value}, "metadata": {"status": status}}


class InputRecoveryBoundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.folder = self.base / "screen-hierarchy"
        self.folder.mkdir()
        self.report = self.base / "result.xml"
        self.commands = self.base / "commands.json"
        self.frame = self.folder / "step-029-assertCondition-^native_owner$.json"
        root = ET.Element("testsuite")
        case = ET.SubElement(root, "testcase", file=module.RECONCILE)
        ET.SubElement(case, "failure").text = module.FAILURE
        ET.ElementTree(root).write(self.report)
        self.trace = [command("tapOnElement", "COMPLETED",
                              {"selector": {"idRegex": "device-reauthenticate"}})]
        self.trace.extend(
            command("inputTextCommand", "COMPLETED", {"text": char})
            for char in module.EXPECTED
        )
        self.trace.append(command("assertConditionCommand", "FAILED",
                                  {"condition": module.TARGET}))
        self.hierarchy = {"attributes": {}, "children": [
            {"attributes": {"resource-id": "auth-username", "value": "ntive_owner",
                            "enabled": "true"}},
            {"attributes": {"resource-id": "auth-password", "enabled": "true"}},
            {"attributes": {"resource-id": "auth-submit", "enabled": "true"}},
        ]}

    def qualifies(self, *, create_frame=True):
        self.commands.write_text(json.dumps(self.trace))
        if create_frame:
            self.frame.write_text(json.dumps(self.hierarchy))
        return module.safe_username_retry(self.report, self.commands, self.folder)

    def test_only_exact_pre_submit_lost_character_can_retry(self):
        self.assertTrue(self.qualifies())
        self.hierarchy["children"][0]["attributes"]["value"] = "native_owner"
        self.assertFalse(self.qualifies())
        self.hierarchy["children"][0]["attributes"]["value"] = "ntive_owner"
        self.trace[-2]["metadata"]["status"] = "FAILED"
        self.assertFalse(self.qualifies())
        self.trace[-2]["metadata"]["status"] = "COMPLETED"
        self.trace[-2]["command"]["inputTextCommand"]["text"] = "x"
        self.assertFalse(self.qualifies())

    def test_ipad_initial_login_requires_same_exact_pre_submit_evidence(self):
        root = ET.parse(self.report)
        root.find(".//testcase").set("file", module.LOGIN)
        root.write(self.report)
        self.assertTrue(self.qualifies())
        # Password entry and any session submit invalidate the same clean-login proof.
        self.hierarchy["children"][1]["attributes"]["value"] = "already-entered"
        self.assertFalse(self.qualifies())
        self.hierarchy["children"][1]["attributes"].pop("value")
        self.trace.insert(1, command("tapOnElement", "COMPLETED",
                                     {"selector": {"idRegex": "auth-submit"}}))
        self.assertFalse(self.qualifies())

    def test_no_replay_after_submit_or_password_entry(self):
        self.assertTrue(self.qualifies())
        self.trace.insert(1, command("tapOnElement", "COMPLETED",
                                     {"selector": {"idRegex": "auth-submit"}}))
        self.assertFalse(self.qualifies())
        self.trace.pop(1)
        self.hierarchy["children"][1]["attributes"]["value"] = "already-entered"
        self.assertFalse(self.qualifies())

    def test_untrusted_report_screen_and_wrong_flow_fail_closed(self):
        self.assertTrue(self.qualifies())
        self.frame.unlink()
        self.assertFalse(self.qualifies(create_frame=False))
        root = ET.parse(self.report)
        root.find(".//testcase").set("file", "other.yaml")
        root.write(self.report)
        self.assertFalse(self.qualifies())
        root.find(".//testcase").set("file", module.RECONCILE)
        root.find(".//failure").text = "Other failure"
        root.write(self.report)
        self.assertFalse(self.qualifies())


if __name__ == "__main__":
    unittest.main()
