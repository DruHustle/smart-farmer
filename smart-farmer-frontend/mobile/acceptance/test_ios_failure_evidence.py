import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("failure_evidence", Path(__file__).parent / "onesa/ios-xctest/failure-evidence.py")
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class FailureEvidence(unittest.TestCase):
    def test_cancel_launch_retry_requires_positive_evidence_and_no_interaction(self):
        counts = dict(totalTestCount=0, passedTests=0, failedTests=0, skippedTests=0)
        reason = evidence.launch_retry_reason
        receipts = ["ONESA_DEVICE_HTTP authorize 303 123"]
        self.assertEqual(reason("", counts, receipts, 1), "zero-tests")
        self.assertEqual(reason("Failed to install or launch the test runner", {}, [], 0), "runner-launch")
        self.assertIsNone(reason("unclassified failure", {}, [], 0))
        self.assertIsNone(reason("", counts, [], 1))
        self.assertIsNone(reason("", counts, receipts, 0))
        self.assertIsNone(reason("", counts, ["ONESA_DEVICE_PORTAL cancel 200"], 0))
        self.assertIsNone(reason("Failed to launch the test runner", dict(counts, failedTests=1), [], 0))
        for started in ("FARMER_XCUI_CHECKPOINT fixture", "FARMER_RENDER actionReady",
                        "Test Case '-[PortalColdTests testCancelPortal]' started."):
            self.assertIsNone(reason(started, counts, [], 0))

    def test_only_fixed_categories_and_source_lines_leave_private_log(self):
        secret = "synthetic-secret-must-not-leave-the-runner"
        log = f"/private/{secret}/PortalColdTests.swift:143: error: XCTUnwrap failed: {secret}\nApplication {secret} is not running\nTest exceeded its execution time allowance of 330 seconds\n"
        log += f"FARMER_RENDER frameRequested\nFARMER_RENDER frameWritten\nFARMER_RENDER frameWritten {secret}\n"
        receipt = evidence.classify(log, "cancel", "consent")
        self.assertEqual(receipt["renderObservations"], ["frameRequested", "frameWritten"])
        self.assertEqual(receipt["sourceLines"], [143])
        self.assertEqual(receipt["signals"], ["execution-timeout", "application-not-running", "assertion-failure"])
        self.assertNotIn(secret, json.dumps(receipt))
        self.assertNotIn("/private/", json.dumps(receipt))

    def test_invalid_checkpoint_cannot_export_arbitrary_input(self):
        with self.assertRaises(ValueError):
            evidence.classify("", "cancel", "synthetic-secret")

    def test_pre_input_hit_query_facts_identify_the_exact_control_without_private_text(self):
        secret = "synthetic-private-element-value"
        log = "\n".join([
            "FARMER_XCUI_CONTROL startup farmer signIn present",
            "FARMER_XCUI_CONTROL startup farmer signIn visible-frame",
            "FARMER_XCUI_CONTROL startup farmer signIn hittable-query",
            f"Failed to compute hit point for {secret}: Activation point invalid",
            f"FARMER_XCUI_CONTROL startup farmer {secret} present",
            f"FARMER_XCUI_CONTROL cancel farmer cancelButton {secret}",
            f"FARMER_XCUI_CONTROL cancel {secret} cancelButton present",
            f"FARMER_XCUI_CONTROL {secret} farmer cancelButton present",
            f"FARMER_XCUI_CONTROL cancel farmer cancelButton present {secret}",
        ])
        receipt = evidence.classify(log, "admin", "signedOut")
        self.assertEqual(receipt["signals"], ["hit-point-failure"])
        self.assertEqual([fact["fact"] for fact in receipt["controls"]],
                         ["present", "visible-frame", "hittable-query"])
        self.assertTrue(all(fact["control"] == "signIn" for fact in receipt["controls"]))
        self.assertNotIn(secret, json.dumps(receipt))

    def test_control_facts_are_deduplicated_and_bounded(self):
        log = "FARMER_XCUI_CONTROL cancel farmer cancelButton absent\n" * 1000
        log += "FARMER_XCUI_CONTROL cancel farmer cancelButton present\n"
        receipt = evidence.classify(log, "cancel", "consent")
        self.assertEqual([fact["fact"] for fact in receipt["controls"]], ["absent", "present"])
        combinations = (f"FARMER_XCUI_CONTROL {phase} {owner} {control} {fact}\n"
                        for phase in ["startup", "cancel"]
                        for owner in ["farmer", "safari", "authSheet"]
                        for control in ["signIn", "introduction", "developerMenu", "localChooser", "savedBundle", "cancelButton", "cancelLink"]
                        for fact in ["absent", "present", "enabled", "disabled", "visible-frame", "hittable-query"])
        self.assertEqual(len(evidence.classify("".join(combinations), "cancel", "consent")["controls"]), 64)

    def test_remote_alert_hit_point_failure_does_not_export_the_element_payload(self):
        secret = "synthetic-private-element"
        log = f"Failed to compute hit point for {secret}: Activation point invalid\nFailed to no matches found for {secret}\n"
        receipt = evidence.classify(log, "member", "returnLink")
        self.assertEqual(receipt["signals"], ["hit-point-failure", "element-query-failure"])
        self.assertNotIn(secret, json.dumps(receipt))

    def test_screenshots_are_forbidden_after_any_credential_checkpoint(self):
        with patch.object(evidence.subprocess, "run") as run:
            for checkpoint in ["email", "password", "mfa", "firstSubmit", "farmWorkspace"]:
                self.assertEqual(evidence.capture("ignored", Path("/tmp"), "admin", checkpoint), "not-requested")
            run.assert_not_called()

    def test_pre_input_capture_has_a_deadline_and_does_not_copy_command_output(self):
        device = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory() as directory, patch.object(evidence.subprocess, "run", side_effect=subprocess.TimeoutExpired("private-command", 20)) as run:
            self.assertEqual(evidence.capture(device, Path(directory), "cancel", "consent"), "timeout")
            self.assertEqual(run.call_args.kwargs["timeout"], 20)
            self.assertEqual(run.call_args.kwargs["stdout"], subprocess.DEVNULL)
            self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)

if __name__ == "__main__":
    unittest.main()
