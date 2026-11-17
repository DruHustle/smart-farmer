"""Only failures before UI/API activity may repeat initial driver setup."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("startup", Path(__file__).with_name("ios-driver-startup.py"))
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)


class DriverStartup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.device = "11111111-2222-3333-4444-555555555555"
        self.trace = self.root / "ios-login"
        self.trace.mkdir()
        (self.root / "proxy.log").write_text("Native acceptance network proxy ready.\n")
        (self.trace / "xctest_runner_1.log").write_text(f"-destination platform=iOS Simulator,id:{self.device},\n")
        self.start = f"xcTestDriverStatusCheck: [Start] Perform XCUITest driver status check on {self.device}"
        self.failure = f"xcTestDriverStatusCheck: [Failed] Perform XCUITest driver status check on {self.device}, exception: java.net.ConnectException: Failed to connect to /127.0.0.1:7001"
        (self.trace / "maestro.log").write_text(self.start + "\n" + self.failure + "\n")

    def eligible(self):
        return startup.failed_before_test(self.root, "ios-login", self.device)

    def test_connection_refused_before_any_ui_is_eligible(self):
        self.assertTrue(self.eligible())

    def test_first_launch_permission_transport_failure_restarts_only_before_input(self):
        label = "ipad-large-font"
        suite = ET.Element("testsuite", device="iPad - iOS 26.4 - " + self.device)
        report = ET.Element("testsuites")
        report.append(suite)
        case = ET.SubElement(suite, "testcase", file="smart-farmer-frontend/mobile/acceptance/login.yaml")
        failure = ET.SubElement(case, "failure")
        failure.text = ("maestro.DeviceUnreachableException: Device became unreachable during setPermissions\n"
                        "Caused by: java.net.ConnectException: Connection refused")
        ET.ElementTree(report).write(self.root / (label + ".xml"))
        events = [
            ("defineVariablesCommand", "COMPLETED", {}), ("applyConfigurationCommand", "COMPLETED", {}),
            ("runFlowCommand", "RUNNING", {"condition": {"platform": "IOS"}}),
            ("runFlowCommand", "RUNNING", {"sourceDescription": "ios-launch-bundle.yaml"}),
            ("applyConfigurationCommand", "COMPLETED", {}),
            ("launchAppCommand", "RUNNING", {"appId": "eu.onesa.smartfarmer"}),
        ]
        trace = [{"command": {kind: data}, "metadata": {"status": status}} for kind, status, data in events]
        path = self.root / label / "login" / "commands.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(trace))
        self.assertTrue(startup.failed_before_test(self.root, label, self.device))
        self.assertFalse(startup.failed_before_test(self.root, label, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
        path.write_text(json.dumps(trace + [{"command": {"tapOnElement": {}}, "metadata": {"status": "RUNNING"}}]))
        self.assertFalse(startup.failed_before_test(self.root, label, self.device))
        path.write_text(json.dumps(trace))
        (self.root / "proxy.log").write_text("Native acceptance network proxy ready.\n[native-proxy] request\n")
        self.assertFalse(startup.failed_before_test(self.root, label, self.device))

    def test_commands_reports_or_screenshots_forbid_replay(self):
        for path in [self.trace / "commands.json", self.trace / "manifest.json", self.trace / "screen.png", self.root / "ios-login.xml"]:
            with self.subTest(path=path.name):
                path.write_text("observed")
                self.assertFalse(self.eligible())
                path.unlink()

    def test_any_api_activity_forbids_replay(self):
        (self.root / "proxy.log").write_text('Native acceptance network proxy ready.\n[native-proxy] {"method":"GET"}\n')
        self.assertFalse(self.eligible())

    def test_answered_driver_then_transport_loss_forbids_replay(self):
        (self.trace / "maestro.log").write_text(self.start + "\nxcTestDriverStatusCheck: [Success] driver answered\n" + self.failure)
        self.assertFalse(self.eligible())

    def test_different_simulator_cannot_authorize_replay(self):
        self.assertFalse(startup.failed_before_test(self.root, "ios-login", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))

    def test_later_login_is_never_an_initial_startup(self):
        self.assertFalse(startup.failed_before_test(self.root, "ios-reconcile-login", self.device))


if __name__ == "__main__":
    unittest.main()
