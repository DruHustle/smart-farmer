"""Assert a real installed native cache has no SQLite plaintext header or fixture text."""
from pathlib import Path
import sqlite3
import sys

paths = list(Path(sys.argv[1]).rglob('farm-*.db'))
assert paths, 'Native SQLCipher database was not created'
for path in paths:
    data = path.read_bytes()
    assert len(data) >= 4096, 'Native database has no durable page'
    assert not data.startswith(b'SQLite format 3'), 'Plaintext SQLite database found'
    assert b'Native durable offline observation' not in data, 'Private fixture text leaked in database'
    try:
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            db.execute('SELECT name FROM sqlite_master').fetchall()
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError('Database readable without SQLCipher key')
print(f'Verified {len(paths)} native database file(s): encrypted header, inaccessible without key.')
