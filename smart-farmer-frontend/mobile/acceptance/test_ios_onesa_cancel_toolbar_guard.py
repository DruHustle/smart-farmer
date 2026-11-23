"""Receipt-based guard: only reveal an actual obstructed iOS issuer cancel.

This static contract complements, but cannot replace, the native iOS XCTest
cancel/denial flow. It must never turn a missing issuer callback into PASS.
"""
from pathlib import Path
import unittest

SOURCE = (Path(__file__).resolve().parent / "onesa" / "ios-xctest" / "PortalColdTests.swift").read_text()


class NativeIssuerCancelToolbar(unittest.TestCase):
    def test_single_observed_preinput_swipe_does_not_bypass_auth(self):
        body = SOURCE.split("private func revealObscuredCancel(", 1)[1].split(
            "private func portalCancel()", 1
        )[0]
        for required in (
            "currentCheckpoint == .consent",
            'ProcessInfo.processInfo.environment["FARMER_ROLE"] == "cancel"',
            "!cancelRevealAttempted",
            "element.exists",
            "element.isEnabled",
            "!element.isHittable",
            "bounds.contains(frame)",
            "frame.minY > bounds.minY + bounds.height * 0.75",
            '["Sign in to Onesa"]',
            '["Remember this browser"]',
            "owner.webViews.firstMatch.exists",
            "cancelRevealAttempted = true",
            "press(forDuration: 0.15, thenDragTo: finish)",
        ):
            self.assertIn(required, body)
        for unsafe in ("typeText(", "auth-submit", "redeemOnesa(", "smartfarmer://"):
            self.assertNotIn(unsafe, body)

    def test_failed_hittability_only_scrolls_once_then_rechecks_real_control(self):
        body = SOURCE.split("private func portalCancel()", 1)[1].split(
            "func testCancelPortal()", 1
        )[0]
        self.assertIn("let hittable = controlReady(", body)
        self.assertIn("if !hittable {", body)
        self.assertIn("revealObscuredCancel(element, owner: owner)", body)
        self.assertIn("if !hittable {\n                    revealObscuredCancel(element, owner: owner)\n                    continue", body)
        self.assertIn("query.count == 1", body)
        self.assertIn("renderObserved(.actionReady)", body)

    def test_cancel_journey_still_requires_real_denial_and_no_session(self):
        body = SOURCE.split("func testCancelPortal()", 1)[1].split(
            "func testColdPortal()", 1
        )[0]
        for required in (
            "self.portalCancel()",
            "Actual issuer offers cancel sign-in",
            "try returnToFarmer(afterCancellation: true)",
            "Denied issuer callback restores signed-out Farmer",
            '["tab-forum"]',
            "XCTAssertFalse",
        ):
            self.assertIn(required, body)


if __name__ == "__main__":
    unittest.main()
