"""Let the installed app process its selected photo without XCTest accessibility polling."""
import sys
import time
from pathlib import Path


def rendered_since(directory: Path, started_ns: int) -> bool:
    try:
        return directory.is_dir() and directory.stat().st_mtime_ns >= started_ns
    except FileNotFoundError:
        return False


def main() -> None:
    container = Path(sys.argv[1])
    if not container.is_dir():
        raise SystemExit("Installed Farmer app container unavailable.")
    directory = container / "Library" / "Caches" / "ImageManipulator"
    started_ns = int(sys.argv[2])
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if rendered_since(directory, started_ns):
            print("Farmer's image render cache changed after the real picker action.")
            return
        time.sleep(1)
    # The normal UI and SQLCipher checks remain authoritative even if Expo
    # changes its optional cache location, or conversion fails in the app.
    print("No current image render cache change observed before UI verification.")


if __name__ == "__main__":
    main()
