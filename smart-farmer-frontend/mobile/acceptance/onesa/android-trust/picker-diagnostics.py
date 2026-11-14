"""Summarize the Android system picker without retaining screen contents or input."""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

picker_packages = {"com.android.documentsui", "com.google.android.documentsui"}
safe_labels = {
    "root": "Onesa test issuer",
    "certificate": "farmer-device-ca.crt",
    "empty": "No items",
    "error": "Can't load content",
    "retry": "Try again",
    "choose": "Open",
}
try:
    nodes = list(ET.parse(sys.argv[1]).iter("node"))
except (ET.ParseError, OSError):
    nodes = []
picker = [node for node in nodes if node.get("package") in picker_packages]
visible = {}
for key, label in safe_labels.items():
    exact = 0
    included = 0
    for node in picker:
        values = (node.get("text", ""), node.get("content-desc", ""))
        exact += int(any(value.casefold() == label.casefold() for value in values))
        included += int(any(label.casefold() in value.casefold() for value in values))
    visible[key] = {"exact": exact, "containing": included}
ids = {}
for node in picker:
    resource_id = node.get("resource-id", "")
    if resource_id in {"android:id/title", "android:id/summary"} or any(
        resource_id.startswith(package + ":id/") for package in picker_packages
    ):
        ids[resource_id] = ids.get(resource_id, 0) + 1
logs = Path(sys.argv[2]).read_text(errors="replace")
print(json.dumps({
    "systemPickerNodes": len(picker), "stateLabels": visible, "resourceIDs": ids,
    "providerSignals": [entry for entry in (
        "Failed to load root document", "Failed to query", "Provider returned null",
        "SecurityException", "IllegalArgumentException", "NullPointerException",
        "FileNotFoundException", "UnsupportedOperationException", "Permission Denial",
    ) if entry in logs],
}, sort_keys=True))
