from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from scripts import sync_marker


def report_fixture() -> dict:
    return {
        "status": "ok",
        "scope": "full",
        "generatedAt": "2026-08-25T16:17:47Z",
        "catalogueItemCount": 218,
        "volumeCount": 143,
        "pageCount": 37756,
        "ingestCounts": {
            "mets-predictable": 99,
            "mets-override": 18,
            "fallback": 26,
        },
    }


class MarkerTests(unittest.TestCase):
    def test_compacts_a_successful_full_report(self) -> None:
        marker = sync_marker.marker_from_report(report_fixture())
        self.assertEqual(marker["schemaVersion"], 1)
        self.assertEqual(marker["catalogueItemCount"], 218)
        self.assertEqual(marker["ingestCounts"]["fallback"], 26)

    def test_partial_or_inconsistent_reports_fail_closed(self) -> None:
        partial = report_fixture()
        partial["scope"] = "partial"
        with self.assertRaisesRegex(sync_marker.MarkerError, "successful full"):
            sync_marker.marker_from_report(partial)

        inconsistent = report_fixture()
        inconsistent["ingestCounts"] = {**inconsistent["ingestCounts"], "fallback": 25}
        with self.assertRaisesRegex(sync_marker.MarkerError, "cover every"):
            sync_marker.marker_from_report(inconsistent)

    def test_writes_a_final_newline_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "marker.json"
            sync_marker.write_marker(output, sync_marker.marker_from_report(report_fixture()))
            text = output.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"))
        self.assertIn('"pageCount": 37756', text)


if __name__ == "__main__":
    unittest.main()
