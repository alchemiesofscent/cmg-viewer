import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corpus_snapshot import unpack, valid_pin


class SnapshotTests(unittest.TestCase):
    def archive(self, root, extra=None):
        path = root / 'corpus.tar.gz'
        with tarfile.open(path, 'w:gz') as tar:
            for name in ['data/catalogue.json', 'data/sync-report.json', 'iiif/example/manifest.json']:
                entry = tarfile.TarInfo(name)
                entry.size = 2
                tar.addfile(entry, io.BytesIO(b'{}'))
            if extra:
                tar.addfile(extra, io.BytesIO(b'{}') if extra.isfile() else None)
        pin = {'schemaVersion': 1, 'tag': 'corpus-123-1', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        return path, pin

    def test_restore_preserves_ui_and_records_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); dist = root / 'dist'; dist.mkdir()
            (dist / 'index.html').write_text('existing UI')
            archive, pin = self.archive(root)
            unpack(archive, dist, pin)
            self.assertEqual((dist / 'index.html').read_text(), 'existing UI')
            self.assertEqual(json.loads((dist / 'corpus-snapshot.json').read_text()), pin)

    def test_corrupt_archive_cannot_replace_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); archive, pin = self.archive(root)
            archive.write_bytes(archive.read_bytes() + b'corrupt')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                unpack(archive, root / 'dist', pin)
            self.assertFalse((root / 'dist').exists())

    def test_traversal_and_links_rejected_before_extraction(self):
        for name, kind in [('../escape.json', tarfile.REGTYPE), ('data/link.json', tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); entry = tarfile.TarInfo(name); entry.type = kind
                entry.size = 2 if kind == tarfile.REGTYPE else 0; entry.linkname = '/etc/passwd'
                archive, pin = self.archive(root, entry)
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    unpack(archive, root / 'dist', pin)
                self.assertFalse((root / 'dist').exists())

    def test_only_versioned_tags_allowed(self):
        with self.assertRaises(ValueError):
            valid_pin({'schemaVersion': 1, 'tag': '../main', 'sha256': 'a'*64})
