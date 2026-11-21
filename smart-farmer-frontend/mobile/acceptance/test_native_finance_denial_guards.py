"""Regression checks for captured iOS payment input and Android denial visibility.

These checks preserve the actual on-device/native E2E gates; they cannot
substitute for the real currency, backend ledger or SSO acceptance tests.
"""
import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class NativeAmountAndDenialGuards(unittest.TestCase):
    def test_ios_payment_uses_exact_minor_unit_equivalent_and_posted_balance(self):
        source = (HERE / "product-accounting.yaml").read_text()
        pay = (HERE / "accounting-payment.yaml").read_text()
        section = source.split('PAYMENT_AMOUNT: "7.50"', 1)[1].split('PAYMENT_REFERENCE:', 1)[0]
        regexp = json.loads(re.search(r'PAYMENT_AMOUNT_REGEX: (".*?")', section).group(1))
        for amount in ("7.50", "07.50"):
            with self.subTest(amount=amount):
                self.assertRegex(amount, regexp)
        for unsafe in ("17.50", "70.50", "7.500", "0.75", "75.0", "007.50", ""):
            with self.subTest(unsafe=unsafe):
                self.assertIsNone(re.fullmatch(regexp, unsafe))
        self.assertIn('OUTSTANDING_AMOUNT: "USD 12.50"', source)
        self.assertIn('id: "form-amount"', pay)
        self.assertIn('text: "${PAYMENT_AMOUNT_REGEX}"', pay)
        self.assertIn('id: "invoice-balance"', pay)
        self.assertIn('text: "${OUTSTANDING_AMOUNT}"', pay)

    def test_denial_requires_real_signed_out_screen_and_exact_visible_message(self):
        source = (HERE / "onesa" / "android-complete.yaml").read_text()
        start = source.index("true: ${FLOW_STATE === 'cancel'}")
        end = source.index("true: ${FLOW_STATE === 'cold'}", start)
        cancel = source[start:end]
        self.assertIn("visible: {id: auth-onesa}", cancel)
        self.assertIn("scrollUntilVisible:", cancel)
        self.assertIn("direction: DOWN", cancel)
        self.assertIn("assertVisible: '^(Onesa haina kupa mvumo", cancel)
        self.assertIn("assertNotVisible: {id: tab-forum}", cancel)
        # A generic dismissal is not equivalent to a checked denial.
        self.assertNotIn("onesa_cancelled", cancel)
        self.assertLess(cancel.index("visible: {id: auth-onesa}"), cancel.index("scrollUntilVisible:"))
        self.assertLess(cancel.index("scrollUntilVisible:"), cancel.index("assertVisible: '^(Onesa"))


if __name__ == "__main__":
    unittest.main()
