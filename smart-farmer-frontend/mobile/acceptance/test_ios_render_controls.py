import importlib.util
import json
import struct
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch


path = Path(__file__).parent / "onesa/ios-xctest/render-controls.py"
spec = importlib.util.spec_from_file_location("render_controls", path)
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)


def tsv(lines):
    header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"
    rows = [header]
    for block, line, top, left, words in lines:
        for index, word in enumerate(words.split()):
            width = len(word) * 7
            rows.append(f"5\t1\t{block}\t1\t{line}\t{index + 1}\t{left}\t{top}\t{width}\t14\t95\t{word}")
            left += width + 5
    return "\n".join(rows)


def screen(lines, email=""):
    return controls.recognize_controls(tsv(lines), 400, 850, email)


class SimulatorControls(unittest.TestCase):
    def test_simctl_writes_named_private_file_and_frame_is_removed_before_ocr(self):
        header = b"\x89PNG\r\n\x1a\n" + bytes(8) + struct.pack(">II", 400, 850)
        frame = None
        with tempfile.TemporaryDirectory() as private:
            def tool(args, **kwargs):
                nonlocal frame
                if args[0] == "xcrun":
                    frame = Path(args[-1])
                    self.assertEqual(frame.parent.parent, Path(private))
                    self.assertEqual(frame.parent.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
                    frame.write_bytes(header)
                    return subprocess.CompletedProcess(args, 0)
                self.assertEqual(args[0], "tesseract")
                self.assertEqual(kwargs["input"], header)
                self.assertFalse(frame.exists())
                return subprocess.CompletedProcess(args, 0, stdout=tsv([]).encode())

            with patch.object(controls.subprocess, "run", side_effect=tool):
                self.assertEqual(controls.capture("simulator", "", private)["rows"], [])
            self.assertEqual(list(Path(private).iterdir()), [])

    def test_partial_frame_is_removed_when_simctl_fails(self):
        with tempfile.TemporaryDirectory() as private:
            def fail(args, **kwargs):
                Path(args[-1]).write_bytes(b"partial")
                raise subprocess.TimeoutExpired("simctl", 5)
            with patch.object(controls.subprocess, "run", side_effect=fail):
                with self.assertRaises(subprocess.TimeoutExpired):
                    controls.capture("simulator", "", private)
            self.assertEqual(list(Path(private).iterdir()), [])

    def test_browser_title_and_complete_controls_have_normalized_in_control_positions(self):
        result = screen([(1, 1, 80, 160, "X localhost"), (2, 1, 150, 35, "Sign in to Onesa"),
                         (3, 1, 300, 40, "Cancel sign-in"), (4, 1, 500, 70, "Cancel")])
        self.assertTrue(result["chrome"])
        self.assertEqual([x["text"] for x in result["rows"]], ["Sign in to Onesa", "Cancel sign-in"])
        x, y, w, h = result["rows"][1]["box"]
        self.assertAlmostEqual((x+w/2)*400, 61)
        self.assertAlmostEqual((1-y-h/2)*850, 307)

    def test_chrome_is_confined_to_device_browser_and_exact_loopback_names(self):
        for host, top, left in (("localhost.example", 60, 160), ("localhost", 250, 160),
                                ("127.0.0.1", 60, 6), ("127.0.0.1:9999", 60, 150)):
            self.assertFalse(screen([(1, 1, top, left, host)])["chrome"])
        self.assertTrue(screen([(1, 1, 80, 162, "127.0.0.1")])["chrome"])
        self.assertTrue(screen([(1, 1, 80, 145, "127.0.0.1:46502")])["chrome"])

    def test_both_languages_and_wrapped_return_link_stay_distinct_from_heading(self):
        for first, last, label in (("Dzokera", "muSmart Farmer", "Dzokera muSmart Farmer"),
                                   ("Buyela", "ku-Smart Farmer", "Buyela ku-Smart Farmer")):
            result = screen([(1, 1, 80, 165, "127.0.0.1"), (2, 1, 220, 80, "Smart Farmer"),
                             (3, 1, 310, 95, first), (3, 2, 330, 95, last)])
            self.assertEqual([row["text"] for row in result["rows"]], ["Smart Farmer", label])
            self.assertGreater(result["rows"][0]["box"][1], sum(result["rows"][1]["box"][1::2]))

    def test_ambiguous_actions_are_preserved_for_the_driver_to_reject(self):
        result = screen([(1, 1, 280, 40, "Continue"), (2, 1, 500, 60, "Continue")])
        self.assertEqual([row["text"] for row in result["rows"]], ["Continue", "Continue"])

    def test_credentials_and_free_text_never_leave_the_observer(self):
        email = "test@example.invalid"
        text = [(1, 1, 180, 60, "Password"), (2, 1, 200, 60, "private-password"), (3, 1, 250, 60, email)]
        result = screen(text, email)
        self.assertCountEqual([row["text"] for row in result["rows"]], ["Password", "fixtureEmail"])
        self.assertNotIn(email, json.dumps(result))
        self.assertNotIn("private-password", json.dumps(result))
        self.assertNotIn("fixtureEmail", json.dumps(screen(text, email.upper())))


if __name__ == "__main__":
    unittest.main()
