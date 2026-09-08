from pathlib import Path
import re
import tempfile
import unittest
from scripts.build import version_ui_assets


class AssetVersionTests(unittest.TestCase):
    def test_html_and_imports_share_a_version_that_changes_with_helpers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / 'assets'
            assets.mkdir()
            def write(helper):
                (assets / 'viewer.js').write_text("import { tree } from './viewer-corpus.js';")
                (assets / 'viewer-corpus.js').write_text(helper)
                (assets / 'viewer.css').write_text('button { color: red; }')
                (root / 'index.html').write_text('<script src="assets/viewer.js"></script><link href="assets/viewer.css">')
            def versions():
                return re.findall(r'v=([a-f0-9]+)', (root / 'index.html').read_text() + (assets / 'viewer.js').read_text())
            write('export const tree = 1;')
            version_ui_assets(root)
            first = versions()
            self.assertEqual(len(first), 3)
            self.assertEqual(len(set(first)), 1)
            write('export const tree = 1;')
            version_ui_assets(root)
            self.assertEqual(versions(), first)
            write('export const tree = 2;')
            version_ui_assets(root)
            self.assertNotEqual(versions()[0], first[0])


class ReaderContractTests(unittest.TestCase):
    def test_real_viewer_template_satisfies_deployment_tool_contract(self):
        from scripts.validate import validate_tool_disclosure, ValidationError
        path = Path(__file__).resolve().parents[2] / 'src/templates/viewer.html'
        template = path.read_text()
        validate_tool_disclosure(template, path)
        with self.assertRaises(ValidationError):
            validate_tool_disclosure(template.replace('id="tools-toggle"', 'id="missing-toggle"'), path)
        with self.assertRaises(ValidationError):
            validate_tool_disclosure(template.replace('aria-controls="reader-secondary-tools"', ''), path)
