"""Recognize only the known iPhone browser controls on a disposable simulator."""
import csv
import io
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path


LABELS = ("Sign in to Onesa", "Email address", "Password", "Remember this browser",
          "Authenticator or recovery code", "Continue", "Cancel sign-in",
          "Smart Farmer", "Dzokera muSmart Farmer", "Buyela ku-Smart Farmer",
          "Save Password?", "Save", "Not Now")
LOCAL_BROWSER_TITLES = {"localhost", "localhost:46501", "127.0.0.1", "127.0.0.1:46502"}


def normalize(text):
    return "".join(text.replace("‑", "-").replace("–", "-").split()).casefold()


def recognize_controls(tsv, width, height, email):
    # Keep text and complete rows only in process memory. Each returned box
    # denotes a whole allowlisted control. Its first word supplies a tap point
    # inside the label even if the link wraps across two lines.
    labels = {normalize(label): label for label in LABELS}
    boxes = []
    chrome = False
    paragraphs = defaultdict(list)
    for row in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        if row["level"] != "5" or float(row["conf"]) < 45:
            continue
        x, y, w, h = (int(row[k]) for k in ("left", "top", "width", "height"))
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > width or y + h > height:
            continue
        token = normalize(row["text"])
        bounds = [x / width, 1 - (y + h) / height, w / width, h / height]
        if email and row["text"] == email:
            boxes.append({"text": "fixtureEmail", "box": bounds})
        if token in LOCAL_BROWSER_TITLES and .25 < (x + w/2)/width < .75 and (y + h/2)/height < .18:
            chrome = True
        paragraphs[(row["block_num"], row["par_num"])].append((token, int(row["line_num"]), bounds))
    for words in paragraphs.values():
        for i, (_, first_line, bounds) in enumerate(words):
            phrase = ""
            for word, line, _ in words[i:i+7]:
                if line > first_line + 1:
                    break
                phrase += word
                label = labels.get(phrase)
                if label:
                    boxes.append({"text": label, "box": bounds})
    return {"width": width, "height": height, "chrome": chrome, "rows": boxes}


def capture(device, email, private):
    # Some simctl versions treat "-" as a literal filename. Use an explicit
    # private path outside Actions artifacts. Remove the frame before OCR and
    # on exceptions. browser.sh also removes the enclosing run on termination.
    with tempfile.TemporaryDirectory(prefix="frame-", dir=private) as frame_dir:
        frame = Path(frame_dir) / "screen.png"
        subprocess.run(["xcrun", "simctl", "io", device, "screenshot", "--type=png", str(frame)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5)
        image = frame.read_bytes()
    if image[:8] != b"\x89PNG\r\n\x1a\n" or len(image) < 24:
        raise ValueError("Invalid compositor frame")
    width, height = struct.unpack(">II", image[16:24])
    def read(mode):
        result = subprocess.run(["tesseract", "stdin", "stdout", "-l", "eng", "--psm", mode, "tsv"],
                                input=image, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                check=True, timeout=5)
        return recognize_controls(result.stdout.decode("utf-8"), width, height, email)

    screen = read("3")
    labels = {row["text"] for row in screen["rows"]}
    callback = {"Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"} & labels
    form = {"Email address", "Password", "Cancel sign-in", "Remember this browser"} <= labels
    if screen["chrome"] and (callback or (form and (not email or "fixtureEmail" in labels))):
        return screen
    # Sparse segmentation also finds the earlier, narrow inline link. Use
    # the same frame for both passes and keep duplicate controls ambiguous.
    sparse = read("11")
    screen["chrome"] |= sparse["chrome"]
    for label in {row["text"] for row in sparse["rows"]}:
        matches = [row for row in sparse["rows"] if row["text"] == label]
        if len(matches) > sum(row["text"] == label for row in screen["rows"]):
            screen["rows"] = [row for row in screen["rows"] if row["text"] != label] + matches
    return screen


def observe(device, runner_id, session, private):
    if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", session):
        raise ValueError("Invalid observation session")
    directory = None
    last = None
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if directory is None or not directory.is_dir():
            try:
                container = subprocess.run(["xcrun", "simctl", "get_app_container", device, runner_id, "data"],
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           text=True, check=True, timeout=4).stdout.strip()
                candidate = Path(container) / "tmp" / ("farmer-ocr-" + session)
                if candidate.is_dir():
                    directory = candidate
            except (OSError, subprocess.SubprocessError):
                pass
            time.sleep(.3)
            continue
        try:
            request = (directory / "request").read_text()
        except FileNotFoundError:
            time.sleep(.1)
            continue
        if request != last and re.fullmatch(r"[A-Fa-f0-9-]{36}", request):
            last = request
            try:
                screen = capture(device, os.environ.get("TEST_RUNNER_FARMER_EMAIL", ""), private)
            except (OSError, ValueError, subprocess.SubprocessError):
                screen = None
            temp = directory / "response.tmp"
            temp.write_text(json.dumps({"id": request, "screen": screen}))
            temp.replace(directory / "response.json")
        time.sleep(.1)


if __name__ == "__main__":
    observe(*sys.argv[1:])
