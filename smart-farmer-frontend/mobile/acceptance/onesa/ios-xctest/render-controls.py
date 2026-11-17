"""Recognize only the known iPhone browser controls on a disposable simulator."""
import csv
import io
import json
import os
import re
import signal
import stat
import struct
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path


LABELS = ("Sign in to Onesa", "Email address", "Password", "Remember this browser",
          "Authenticator or recovery code", "Continue", "Cancel", "Cancel sign-in",
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
    for host in ("localhost", "127.0.0.1"):
        for quotes in (("“", "”"), ('"', '"')):
            opening, closing = quotes
            title = f"{opening}SmartFarmer{closing} Wants to Use {opening}{host}{closing} to Sign In"
            labels[normalize(title)] = "systemConsentTitle"
    if email:
        labels[normalize("Continue as " + email)] = "rememberedAccount"
    boxes = []
    title_bottom = None
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
            title_bottom = bounds[1] if title_bottom is None else min(title_bottom, bounds[1])
        paragraphs[(row["block_num"], row["par_num"])].append((token, int(row["line_num"]), bounds))
    for words in paragraphs.values():
        for i, (_, first_line, bounds) in enumerate(words):
            phrase = ""
            for word, line, _ in words[i:i+10]:
                if line > first_line + 1:
                    break
                phrase += word
                label = labels.get(phrase)
                if label:
                    boxes.append({"text": label, "box": bounds})
    # Plain Cancel belongs to Apple's prompt. The issuer has its own Cancel sign-in control.
    if not any(box["text"] == "systemConsentTitle" for box in boxes):
        boxes = [box for box in boxes if box["text"] != "Cancel"]
    return {"width": width, "height": height, "chrome": title_bottom is not None, "titleBottom": title_bottom, "rows": boxes}


def recognize_frame(frame, email):
    # XCTest atomically writes the PNG before publishing its request ID. Unlink
    # it before starting OCR. Neither full frames nor arbitrary OCR text leave
    # the disposable device and Mac.
    try:
        fd = os.open(frame, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or not 24 <= info.st_size <= 32*1024*1024:
                raise ValueError("Invalid XCTest frame")
            image = source.read(info.st_size)
    finally:
        frame.unlink(missing_ok=True)
    if image[:8] != b"\x89PNG\r\n\x1a\n" or len(image) < 24:
        raise ValueError("Invalid compositor frame")
    width, height = struct.unpack(">II", image[16:24])
    def read(mode):
        result = subprocess.run(["tesseract", "stdin", "stdout", "-l", "eng", "--psm", mode, "tsv"],
                                input=image, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                check=True, timeout=8)
        return recognize_controls(result.stdout.decode("utf-8"), width, height, email)

    screen = read("3")
    labels = {row["text"] for row in screen["rows"]}
    callback = {"Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"} & labels
    form = {"Email address", "Password", "Cancel sign-in", "Remember this browser"} <= labels
    if "systemConsentTitle" in labels and {"Cancel", "Continue"} <= labels:
        return screen
    if screen["chrome"] and ((callback and "Smart Farmer" in labels) or (form and (not email or "fixtureEmail" in labels))):
        return screen
    # Sparse segmentation also finds the earlier, narrow inline link. Use
    # the same frame for both passes and keep duplicate controls ambiguous.
    sparse = read("11")
    edges = [edge for edge in (screen["titleBottom"], sparse["titleBottom"]) if edge is not None]
    screen["titleBottom"] = min(edges) if edges else None
    screen["chrome"] = bool(edges)
    for label in {row["text"] for row in sparse["rows"]}:
        matches = [row for row in sparse["rows"] if row["text"] == label]
        if len(matches) > sum(row["text"] == label for row in screen["rows"]):
            screen["rows"] = [row for row in screen["rows"] if row["text"] != label] + matches
    return screen


def request_directory(data_root, session, private_log):
    name = "farmer-ocr-" + session
    # XCTest output can be buffered until the test ends. Discover its random
    # session in an app or device cache without depending on live log delivery.
    folders = [data_root / "Library" / "Caches" / name]
    folders.extend((data_root / "Containers" / "Data" / "Application").glob("*/Library/Caches/" + name))
    try:
        with private_log.open("rb") as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - 64*1024))
            lines = stream.read().decode(errors="replace").splitlines()
        prefix = "FARMER_PRIVATE_OCR_DIRECTORY "
        folders.extend(Path(line[len(prefix):]) for line in lines if line.startswith(prefix))
    except FileNotFoundError:
        pass
    valid = set()
    for folder in folders:
        if not folder.is_absolute():
            continue
        path = folder.resolve()
        if path.is_relative_to(data_root) and path.parts[-3:] == ("Library", "Caches", name) and path.is_dir():
            valid.add(path)
    return valid.pop() if len(valid) == 1 else None


def observe(data_path, session, log_name):
    if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", session):
        raise ValueError("Invalid observation session")
    root = Path(data_path).resolve(strict=True)
    directory = None
    last = None
    reported = set()

    def stage(name):
        if name not in reported:
            print("FARMER_OCR_STAGE " + name, flush=True)
            reported.add(name)

    stage("observer-started")
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if directory is None or not directory.is_dir():
            directory = request_directory(root, session, Path(log_name))
            if directory is None:
                time.sleep(.3)
                continue
            stage("runner-directory")
        try:
            request = (directory / "request").read_text()
        except FileNotFoundError:
            time.sleep(.1)
            continue
        if request != last and re.fullmatch(r"[A-Fa-f0-9-]{36}", request):
            last = request
            stage("received-request")
            try:
                screen = recognize_frame(directory / (request + ".png"), os.environ.get("TEST_RUNNER_FARMER_EMAIL", ""))
                stage("recognized-frame")
            except subprocess.TimeoutExpired:
                stage("recognizer-timeout")
                screen = None
            except (OSError, ValueError, subprocess.SubprocessError):
                stage("frame-unavailable")
                screen = None
            temp = directory / "response.tmp"
            temp.write_text(json.dumps({"id": request, "screen": screen}))
            temp.replace(directory / "response.json")
            stage("answered-request")
        time.sleep(.1)


def remove_private_frames(root, session, private_log):
    directory = request_directory(root, session, private_log)
    if directory:
        for frame in directory.glob("*.png"):
            if re.fullmatch(r"[A-Fa-f0-9-]{36}\.png", frame.name):
                frame.unlink(missing_ok=True)


if __name__ == "__main__":
    data_path, session, log_name = sys.argv[1:]
    def stop(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    try:
        observe(data_path, session, log_name)
    finally:
        remove_private_frames(Path(data_path).resolve(), session, Path(log_name))
