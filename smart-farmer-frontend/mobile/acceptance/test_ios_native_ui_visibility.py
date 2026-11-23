"""Regression contracts for receipt-based, fail-closed iOS UI recovery.

These source checks do not replace the full real simulator suites.
"""
from pathlib import Path
import unittest

BASE = Path(__file__).resolve().parent


class IOSNativeUIVisibility(unittest.TestCase):
    def test_dev_menu_dismissal_is_exact_and_pre_auth_only(self):
        flow = (BASE / "open-fixture-app.yaml").read_text()
        tutorial = flow.index("Dismiss the observed Expo developer-menu tutorial on iOS")
        signed_out = flow.index("id: auth-username")
        self.assertLess(tutorial, signed_out)
        guard = flow[tutorial:signed_out]
        self.assertIn("platform: iOS", guard)
        self.assertIn("visible: '^This is the developer menu", guard)
        self.assertIn("text: '^Continue$'", guard)
        self.assertIn("visible: '^Close$'", guard)
        self.assertNotIn("auth-submit", guard)
        self.assertNotIn("device-unlock", guard)
        self.assertNotIn("auth-onesa", guard)

    def test_i_phone_service_card_must_still_be_tapped_and_confirmed(self):
        flow = (BASE / "product-services.yaml").read_text()
        service = flow.index('id: "service-open-${SERVICE_ID}"')
        area = flow[max(0, service-170):service]
        self.assertIn("centerElement: false", area)
        self.assertIn("visibilityPercentage: 50", area)
        follow = flow[service:]
        self.assertIn('- tapOn:\n    id: "service-open-${SERVICE_ID}"', follow)
        self.assertIn('id: "product-review"', follow)
        self.assertIn('id: "product-confirm"', follow)


if __name__ == "__main__":
    unittest.main()
