"""Guard the real native camera playback journey against false iOS scroll failures.

A failed 2026-11-21 simulator receipt had the exact playback resource-id
in its accessibility tree within the sheet, while Maestro's 100%-visible,
centerElement scroll returned 'No visible element found'. This does not
prove the HLS decoder is working; the native flow must still test it.
"""
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent


class NativeCameraPlaybackContract(unittest.TestCase):
    def test_ios_nested_sheet_scroll_is_not_pixel_perfect(self):
        flow = (HERE / "product-security.yaml").read_text(encoding="utf8")
        key = 'id: "camera-playback-${CAMERA_EVENT_ID}"'
        self.assertEqual(flow.count(key), 2, "Playback must be found then tapped")
        scroll = flow.split(key, 1)[0].rsplit("- scrollUntilVisible:", 1)[1]
        self.assertIn("centerElement: false", scroll)
        self.assertIn("visibilityPercentage: 50", scroll)
        self.assertIn("direction: DOWN", flow.split(key, 1)[1])
        self.assertNotIn("visibilityPercentage: 0", scroll)

    def test_actual_playback_and_acknowledgment_still_required(self):
        flow = (HERE / "product-security.yaml").read_text(encoding="utf8")
        self.assertIn('id: "camera-player-(ready|completed)"', flow)
        self.assertIn("id: camera-player-error", flow)
        self.assertIn("assertNotVisible:", flow)
        self.assertIn('id: "camera-ack-${CAMERA_EVENT_ID}"', flow)
        self.assertIn("private-hls-native-decoder-ready", flow)
        self.assertIn("private-motion-event-acknowledged", flow)
        ui = (NATIVE / "src/screens/SecurityPanel.tsx").read_text(encoding="utf8")
        self.assertIn("item.clip_available ? <Action", ui,
                      "Playback must never be shown for a missing real event clip")
        self.assertIn("camera-player-${view}", ui)


if __name__ == "__main__":
    unittest.main()
