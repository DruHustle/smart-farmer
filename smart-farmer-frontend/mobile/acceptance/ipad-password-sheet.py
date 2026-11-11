"""Locate the decline button on the observed English iPad AutoFill sheet."""
import csv
import io
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict


def not_now_point(image):
    tsv = subprocess.check_output(["tesseract", image, "stdout", "-l", "eng", "tsv"],
                                  text=True, stderr=subprocess.DEVNULL)
    words_by_line = defaultdict(list)
    page_size = None
    for row in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        if row["level"] == "1":
            page_size = int(row["width"]), int(row["height"])
        if row["level"] == "5" and row["text"]:
            line = tuple(row[field] for field in ("page_num", "block_num", "par_num", "line_num"))
            words_by_line[line].append(row)
    if not page_size:
        return None
    matches = {}
    for words in words_by_line.values():
        label = " ".join(word["text"] for word in words).strip().lower()
        if label in ("save password?", "save", "not now"):
            if label in matches:
                return None
            left = min(int(w["left"]) for w in words)
            right = max(int(w["left"]) + int(w["width"]) for w in words)
            top = min(int(w["top"]) for w in words)
            bottom = max(int(w["top"]) + int(w["height"]) for w in words)
            matches[label] = (left + right) / 2, (top + bottom) / 2
    body = " ".join(w["text"].lower() for words in words_by_line.values() for w in words)
    if set(matches) != {"save password?", "save", "not now"} or "securely store your password" not in body:
        return None
    width, height = page_size
    title, save, decline = (matches[k] for k in ("save password?", "save", "not now"))
    if not title[1] < save[1] < decline[1] or abs(save[0] - decline[0]) > width * 0.1:
        return None
    return f"{round(100 * decline[0] / width)}%,{round(100 * decline[1] / height)}%"


if __name__ == "__main__":
    failures = [e.text for e in ET.parse(sys.argv[1]).findall(".//failure")]
    if failures != ["Assertion is false: id: tab-record is visible"]:
        sys.exit("The iPad did not stop at the expected post-login assertion.")
    point = not_now_point(sys.argv[2])
    if not point:
        sys.exit("The current iPad screenshot does not identify the system password sheet.")
    print(point)
