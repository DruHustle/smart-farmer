import json
import re
import sys
from pathlib import Path

row = re.compile(re.escape(sys.argv[2]) + r" · 3(?:[.]0+)? kg")
tree = json.loads(Path(sys.argv[1]).read_text())

def matches(value):
    if isinstance(value, dict):
        attributes = value.get("attributes", {})
        found = any(row.fullmatch(str(attributes.get(key, ""))) for key in ("text", "accessibilityText", "contentDescription"))
        return int(found) + sum(matches(child) for key, child in value.items() if key != "attributes")
    if isinstance(value, list):
        return sum(map(matches, value))
    return 0

assert matches(tree) == 1, "Expected exactly one visible matching observation"
