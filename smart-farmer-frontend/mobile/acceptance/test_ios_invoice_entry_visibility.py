"""Regression for a real native iPhone supplier invoice sheet scroll failure.

The failed 2026-11-21 Maestro receipt reported 'invoice-open' missing even
though the exact accessible control was inside the active invoice sheet
viewport. Remove forced centering; never skip a signed invoice workflow.
"""
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent


class NativeInvoiceEntryVisibility(unittest.TestCase):
    def test_supplier_invoice_scroll_preserves_an_actual_visible_control(self):
        flow = (HERE / "product-accounting.yaml").read_text(encoding="utf8")
        key = 'id: "invoice-open-${PURCHASE_INVOICE_ID}"'
        self.assertEqual(flow.count(key), 2, "The exact invoice ID must be located and tapped")
        scroll = flow.split(key, 1)[0].rsplit("- scrollUntilVisible:", 1)[1]
        self.assertIn("centerElement: false", scroll)
        self.assertIn("visibilityPercentage: 50", scroll)
        self.assertIn("direction: DOWN", flow.split(key, 1)[1])
        self.assertNotIn("visibilityPercentage: 0", scroll)

    def test_payment_and_posting_acceptance_still_require_real_results(self):
        flow = (HERE / "product-accounting.yaml").read_text(encoding="utf8")
        self.assertIn("file: accounting-finalize.yaml", flow)
        self.assertIn("file: accounting-payment.yaml", flow)
        self.assertIn('PAYMENT_AMOUNT: "7.50"', flow)
        self.assertIn('PAYMENT_AMOUNT: "10.00"', flow)
        self.assertIn("accounting-posted-bill-partial-payment", flow)
        self.assertIn("accounting-issued-invoice-partial-receipt", flow)
        payment = (HERE / "accounting-payment.yaml").read_text(encoding="utf8")
        self.assertIn('id: "invoice-payment-status"', payment)
        self.assertIn('id: "invoice-balance"', payment)
        self.assertIn('text: "${PAYMENT_AMOUNT_REGEX}"', payment)
        self.assertIn('text: "${OUTSTANDING_AMOUNT}"', payment)
        self.assertIn('id: "product-confirm"', payment)


if __name__ == "__main__":
    unittest.main()
