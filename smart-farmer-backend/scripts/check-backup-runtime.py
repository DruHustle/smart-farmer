"""Check the archive extraction contract inside the actual backup image."""

import io
import pathlib
import sys
import tarfile
import tempfile


if sys.version_info < (3, 12) or not callable(getattr(tarfile, "data_filter", None)):
    raise SystemExit("Backup restore requires Python 3.12+ with tarfile.data_filter")


def archive(name, content):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as output:
        member = tarfile.TarInfo(name)
        member.size = len(content)
        output.addfile(member, io.BytesIO(content))
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode="r")


with tempfile.TemporaryDirectory(prefix="smart-farmer-runtime-") as temporary:
    root = pathlib.Path(temporary)
    destination = root / "restored"
    destination.mkdir()
    with archive("manifest.json", b'{"scope":"isolated-runtime-check"}') as source:
        source.extractall(destination, filter="data")
    assert (destination / "manifest.json").read_bytes() == b'{"scope":"isolated-runtime-check"}'
    with archive("../outside.txt", b"must not be extracted") as source:
        try:
            source.extractall(destination, filter="data")
        except tarfile.FilterError:
            pass
        else:
            raise AssertionError("Archive extraction allowed a path outside its target")
    assert not (root / "outside.txt").exists()

print("Backup extraction runtime passed: ordinary file restored; traversal refused")
