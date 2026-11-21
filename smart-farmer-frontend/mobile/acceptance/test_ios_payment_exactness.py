"""Guard iPhone payment fixture against reintroducing a synthetic leading zero.

The native test still validates the exact visible form amount before any
payment submission; this source-level guard prevents the old 07.50 failure.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent


class NativePaymentTyping(unittest.TestCase):
    def test_partial_payment_has_no_disposable_leading_zero(self):
        text = (ROOT / "product-accounting.yaml").read_text(encoding="utf-8")
        partial = text.split('PAYMENT_AMOUNT: "7.50"', 1)[1].split('- takeScreenshot:', 1)[0]
        for digit, expected in enumerate(['7', '.', '5', '0', ''], 1):
            self.assertIn(f'PAYMENT_CHAR_{digit}: "{expected}"', partial)
        self.assertIn('PAYMENT_AMOUNT_REGEX: "^7\\\\.50$"', partial)

    def test_five_character_sales_receipt_still_uses_all_digits(self):
        text = (ROOT / "product-accounting.yaml").read_text(encoding="utf-8")
        receipt = text.split('PAYMENT_AMOUNT: "10.00"', 1)[1]
        for digit, expected in enumerate(['1', '0', '.', '0', '0'], 1):
            self.assertIn(f'PAYMENT_CHAR_{digit}: "{expected}"', receipt)

    def test_optional_fifth_digit_and_exact_pre_submit_assertion(self):
        text = (ROOT / "accounting-payment.yaml").read_text(encoding="utf-8")
        self.assertIn("true: ${PAYMENT_CHAR_5 !== ''}", text)
        self.assertIn('inputText: "${PAYMENT_CHAR_5}"', text)
        self.assertIn('text: "${PAYMENT_AMOUNT_REGEX}"', text)
        self.assertLess(text.index('text: "${PAYMENT_AMOUNT_REGEX}"'),
                        text.index('id: "product-confirm"'))


if __name__ == "__main__":
    unittest.main()
