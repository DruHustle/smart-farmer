"""Regression guard for the observed post-login iPhone AutoFill obstruction.

These static checks do not replace actual XCTest hardware/simulator acceptance.
"""
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parent


class PostLoginSystemSheetGate(unittest.TestCase):
    def test_ios_farm_guard_is_after_login_and_before_offline_mutations(self):
        content = (BASE / "ios.sh").read_text()
        logged_in = content.index('run_native_login "$NATIVE_PHONE" iphone ios-login')
        gate = content.index('bash "$NATIVE_DIR/acceptance/ios-dismiss-native-password-sheet.sh" "$NATIVE_PHONE" iphone')
        offline = content.index('touch "$NATIVE_OFFLINE_FLAG"')
        self.assertLess(logged_in, gate)
        self.assertLess(gate, offline)
        self.assertIn('[[ "$NATIVE_SUITE" == farm ]]', content[logged_in:offline])

    def test_cross_device_xctest_does_not_submit_credentials_or_circumvent_lock(self):
        text = (BASE / "ios-dismiss-native-password-sheet.sh").read_text()
        self.assertIn('case "$layout" in ipad|iphone)', text)
        self.assertIn('testDismissSystemPasswordSheet', text)
        for forbidden in ('auth-submit', 'credential', 'login.yaml', 'signOut', 'device-unlock'):
            # Comments can refer to credential safety; only guard commands.
            self.assertNotIn(f'--only-testing:{forbidden}', text)
        native = (BASE / "onesa" / "ios-xctest" / "PortalColdTests.swift").read_text()
        body = native.split("func testDismissSystemPasswordSheet()", 1)[1]
        self.assertIn('staticTexts["Save Password?"]', body)
        self.assertIn('buttons["Not Now"]', body)
        self.assertIn('record.isHittable', body)
        self.assertNotIn('typeText(', body)


if __name__ == "__main__":
    unittest.main()
