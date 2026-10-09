from pathlib import Path
import json
import re
import tempfile
import unittest
from scripts.build import RELEASE_VERSION_MARKER, release_version, stamp_release_version

ROOT = Path(__file__).resolve().parents[2]


class ReleaseVersionTests(unittest.TestCase):
    def test_package_version_has_the_latest_changelog_entry(self):
        version = json.loads((ROOT / 'package.json').read_text())['version']
        self.assertEqual(release_version(), version)
        headings = re.findall(r'^## (\S+)', (ROOT / 'CHANGELOG.md').read_text(), re.MULTILINE)
        self.assertTrue(headings, 'CHANGELOG.md has no version sections')
        self.assertEqual(headings[0], version, 'Bump package.json and add its CHANGELOG section together')

    def test_about_page_shows_the_stamped_version(self):
        self.assertIn(RELEASE_VERSION_MARKER, (ROOT / 'src/about.html').read_text())
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory) / 'about.html'
            page.write_text(f'<p>Version {RELEASE_VERSION_MARKER}</p>')
            stamp_release_version(Path(directory), '1.2.3')
            self.assertEqual(page.read_text(), '<p>Version 1.2.3</p>')
