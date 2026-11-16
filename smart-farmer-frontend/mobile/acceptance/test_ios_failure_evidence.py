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
    def test_only_fixed_categories_and_source_lines_leave_private_log(self):
        secret = "synthetic-secret-must-not-leave-the-runner"
        log = f"/private/{secret}/PortalColdTests.swift:143: error: XCTUnwrap failed: {secret}\nApplication {secret} is not running\nTest exceeded its execution time allowance of 330 seconds\n"
        receipt = evidence.classify(log, "cancel", "consent")
        self.assertEqual(receipt["sourceLines"], [143])
        self.assertEqual(receipt["signals"], ["execution-timeout", "application-not-running", "assertion-failure"])
        self.assertNotIn(secret, json.dumps(receipt))
        self.assertNotIn("/private/", json.dumps(receipt))

    def test_invalid_checkpoint_cannot_export_arbitrary_input(self):
        with self.assertRaises(ValueError):
            evidence.classify("", "cancel", "synthetic-secret")

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
