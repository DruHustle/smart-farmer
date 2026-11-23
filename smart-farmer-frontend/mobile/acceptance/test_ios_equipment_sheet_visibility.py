"""Ensure iOS equipment panel scrolls to the real resource before actuation.

A visibility tolerance does not waive the tap, authorization or confirmation.
This static guard cannot substitute for real native hardware acceptance.
"""
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parent

class EquipmentSheetVisibility(unittest.TestCase):
    def test_nested_scroll_preserves_actual_open_and_safe_simulated_command(self):
        src = (BASE / "product-equipment.yaml").read_text()
        marker = 'id: "asset-open-${ASSET_ID}"'
        self.assertEqual(src.count(marker), 2)
        first = src.index(marker)
        before = src[max(0, first-150):first]
        self.assertIn("centerElement: false", before)
        self.assertIn("visibilityPercentage: 50", before)
        later = src[first:]
        for exact in (
            '- tapOn:\n    id: "asset-open-${ASSET_ID}"',
            'id: "equipment-tabs-option-commands"',
            'id: "command-start"',
            'id: "command-confirm"',
            'notVisible:\n      id: "command-confirm"',
        ):
            self.assertIn(exact, later)

if __name__=="__main__":
    unittest.main()
