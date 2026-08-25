from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest

from scripts import catalogue


CATALOGUE_FIXTURE = """<!doctype html>
<html><body>
<nav>
  <a href="diels_01.php">Navigation is not catalogue content</a>
  <a href="kuehn.php">Tool outside catalogue content</a>
</nav>
<div class="content-plain">
  <!-- <a href="helper.php">Commented stale helper</a> -->
  <table>
    <tr>
      <td><a href="cmg_01.php?p=2">I 1</a></td>
      <td><a href="cmg_01.php?p=2">De arte, edidit A. Editor,
          in linguam Germanicam vertit B. Translator, Berlin 1915</a></td>
    </tr>
    <tr><td></td><td><a href="cmg_01.php?p=7">De medico, 1927</a></td></tr>
    <tr><td><a href="wa_op.php">Opera I</a></td></tr>
    <tr><td><a href="wa_op.php?p=">Opera II</a></td></tr>
    <tr><td><a href="kuehn.php">Excluded tool</a></td></tr>
    <tr><td><a href="https://example.test/outside.php">External PHP</a></td></tr>
  </table>
</div>
</body></html>
"""


def fixture_config() -> dict:
    return {
        "schemaVersion": 1,
        "verifiedAt": "2026-08-25",
        "allowedHosts": ["cmg.bbaw.de"],
        "catalogueSources": [
            {
                "id": "fixture",
                "label": "Fixture source",
                "collection": "CMG",
                "path": "fixture.html",
                "url": "https://cmg.bbaw.de/epubl/online/fixture.html",
            }
        ],
        "explicitViewers": [
            {
                "id": "diels_01",
                "label": "Diels: Vorwort",
                "collection": "Diels",
                "sourceId": "fixture",
                "viewerPath": "diels_01.php",
                "url": "https://cmg.bbaw.de/epubl/online/diels_01.php",
            }
        ],
        "exclusions": [
            {"viewerPath": "kuehn.php", "reason": "Tool"},
            {"viewerPath": "helper.php", "reason": "Auxiliary page"},
        ],
        "expectedCounts": {
            "catalogueSources": 1,
            "catalogueWorkLinks": 4,
            "explicitViewerLinks": 1,
            "searchableWorkEntries": 5,
            "catalogueViewerEndpoints": 2,
            "explicitViewerEndpoints": 1,
            "physicalViewerEndpoints": 3,
            "byCollection": {"CMG": 2, "Diels": 1},
        },
    }


class PageParsingTests(unittest.TestCase):
    def test_comments_navigation_external_links_and_exclusions_are_out_of_scope(self) -> None:
        source = fixture_config()["catalogueSources"][0]
        records = catalogue.parse_catalogue_page(
            CATALOGUE_FIXTURE,
            source,
            excluded_viewer_paths=["kuehn.php", "helper.php"],
        )
        self.assertEqual(len(records), 4)
        self.assertEqual(
            [record["workUrl"] for record in records],
            [
                "https://cmg.bbaw.de/epubl/online/cmg_01.php?p=2",
                "https://cmg.bbaw.de/epubl/online/cmg_01.php?p=7",
                "https://cmg.bbaw.de/epubl/online/wa_op.php",
                "https://cmg.bbaw.de/epubl/online/wa_op.php?p=",
            ],
        )

    def test_duplicate_series_and_title_anchors_become_one_rich_work_record(self) -> None:
        source = fixture_config()["catalogueSources"][0]
        first = catalogue.parse_catalogue_page(
            CATALOGUE_FIXTURE, source, excluded_viewer_paths=["kuehn.php"]
        )[0]
        self.assertEqual(first["volumeId"], "cmg_01")
        self.assertEqual(first["viewerPath"], "cmg_01.php")
        self.assertEqual(first["startPn"], 2)
        self.assertEqual(first["rawLabels"][0], "I 1")
        self.assertIn("De arte", first["label"])
        self.assertIn("I 1 De arte", first["rawContext"])
        self.assertEqual(first["hints"]["seriesNumbers"], ["I 1"])
        self.assertEqual(first["hints"]["years"], [1915])
        self.assertEqual(
            [item["code"] for item in first["hints"]["languagesMentioned"]],
            ["deu"],
        )
        self.assertNotIn("authors", first)
        self.assertNotIn("editors", first)

    def test_page_without_content_region_fails_closed(self) -> None:
        source = fixture_config()["catalogueSources"][0]
        with self.assertRaisesRegex(catalogue.CatalogueError, "content-plain"):
            catalogue.parse_catalogue_page(
                '<a href="cmg_01.php">Not enough</a>', source
            )


class NormalizationTests(unittest.TestCase):
    def test_separates_work_items_from_physical_viewers_and_assigns_stable_ids(self) -> None:
        result = catalogue.normalize_catalogue(
            fixture_config(), {"fixture": CATALOGUE_FIXTURE}
        )
        self.assertEqual(result["counts"]["searchableWorkEntries"], 5)
        self.assertEqual(result["counts"]["physicalViewerEndpoints"], 3)
        by_url = {item["upstreamWorkUrl"]: item for item in result["works"]}
        self.assertEqual(
            by_url["https://cmg.bbaw.de/epubl/online/cmg_01.php?p=2"]["id"],
            "cmg_01--pn-2--01",
        )
        self.assertEqual(
            by_url["https://cmg.bbaw.de/epubl/online/wa_op.php"]["id"],
            "wa_op--pn-default--01",
        )
        self.assertEqual(
            by_url["https://cmg.bbaw.de/epubl/online/wa_op.php?p="]["id"],
            "wa_op--pn-default--02",
        )
        volume = next(item for item in result["volumes"] if item["id"] == "cmg_01")
        self.assertEqual(volume["collection"], "CMG")
        self.assertEqual(volume["sourceCollections"], ["CMG"])
        self.assertEqual(volume["workCount"], 2)

    def test_exact_census_drift_fails_closed(self) -> None:
        config = fixture_config()
        config["expectedCounts"]["catalogueWorkLinks"] = 99
        with self.assertRaisesRegex(catalogue.CatalogueError, "expected 99, received 4"):
            catalogue.normalize_catalogue(config, {"fixture": CATALOGUE_FIXTURE})

    def test_writes_separate_seed_and_work_envelopes(self) -> None:
        result = catalogue.normalize_catalogue(
            fixture_config(), {"fixture": CATALOGUE_FIXTURE}
        )
        with tempfile.TemporaryDirectory() as temporary:
            seed_path, work_path = catalogue.write_catalogue_outputs(
                result, Path(temporary), generated_at="2026-08-25T12:00:00Z"
            )
            seeds = json.loads(seed_path.read_text(encoding="utf-8"))
            works = json.loads(work_path.read_text(encoding="utf-8"))
        self.assertEqual(seeds["volumeCount"], 3)
        self.assertEqual(len(seeds["volumes"]), 3)
        self.assertEqual(works["itemCount"], 5)
        self.assertEqual(len(works["items"]), 5)
        self.assertEqual(works["generatedAt"], "2026-08-25T12:00:00Z")


class CacheTests(unittest.TestCase):
    def test_offline_cache_is_used_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cache_path = Path(temporary) / "fixture.html"
            cache_path.write_bytes(b"cached")
            self.assertEqual(
                catalogue.fetch_cached_bytes(
                    "https://cmg.bbaw.de/epubl/online/fixture.html",
                    cache_path,
                    offline=True,
                    refresh=False,
                    allowed_hosts=["cmg.bbaw.de"],
                ),
                b"cached",
            )

    def test_offline_cache_miss_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(catalogue.CatalogueError, "Offline cache miss"):
                catalogue.fetch_cached_bytes(
                    "https://cmg.bbaw.de/epubl/online/fixture.html",
                    Path(temporary) / "missing.html",
                    offline=True,
                    refresh=False,
                    allowed_hosts=["cmg.bbaw.de"],
                )


@unittest.skipUnless(
    os.environ.get("CMG_LIVE_TESTS") == "1",
    "set CMG_LIVE_TESTS=1 to exercise the public BBAW catalogue",
)
class LiveCatalogueTests(unittest.TestCase):
    def test_live_catalogue_matches_reviewed_218_work_143_volume_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            result = catalogue.crawl_catalogue(
                catalogue.DEFAULT_CONFIG,
                cache_dir=Path(temporary),
                refresh=True,
            )
        self.assertEqual(result["counts"]["catalogueWorkLinks"], 214)
        self.assertEqual(result["counts"]["searchableWorkEntries"], 218)
        self.assertEqual(result["counts"]["catalogueViewerEndpoints"], 139)
        self.assertEqual(result["counts"]["physicalViewerEndpoints"], 143)
        self.assertEqual(len({item["id"] for item in result["works"]}), 218)
        self.assertEqual(len({item["id"] for item in result["volumes"]}), 143)


if __name__ == "__main__":
    unittest.main()
