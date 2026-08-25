from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from scripts import sync_full


BASE_URL = "https://alchemiesofscent.github.io/cmg-viewer"


def full_census_fixture() -> tuple[dict, dict]:
    """Build the reviewed 218-work/143-volume shape without network fixtures."""

    volumes = []
    works = []
    for index in range(143):
        volume_id = f"viewer_{index:03d}"
        work_count = 2 if index < 75 else 1
        work_ids = []
        for occurrence in range(1, work_count + 1):
            work_id = f"{volume_id}--pn-{occurrence + 1}--01"
            work_ids.append(work_id)
            works.append(
                {
                    "id": work_id,
                    "volumeId": volume_id,
                    "startPn": occurrence + 1,
                    "label": f"Work {index}.{occurrence}",
                    "rawContext": f"Work {index}.{occurrence}, Berlin 19{index % 100:02d}",
                    "rawLabels": [f"Work {index}.{occurrence}"],
                    "rawContexts": [f"Work {index}.{occurrence}"],
                    "sourceLabels": ["Fixture"],
                    "sourceCollections": ["CMG"],
                    "sourceIds": ["fixture"],
                    "collection": "CMG",
                    "upstreamWorkUrl": (
                        f"https://cmg.bbaw.de/epubl/online/{volume_id}.php"
                        f"?p={occurrence + 1}"
                    ),
                    "hints": {
                        "seriesNumbers": [f"I {index + 1}"],
                        "years": [],
                        "languagesMentioned": [],
                    },
                }
            )
        volumes.append(
            {
                "id": volume_id,
                "volumeId": volume_id,
                "viewerPath": f"{volume_id}.php",
                "upstreamViewerUrl": (
                    f"https://cmg.bbaw.de/epubl/online/{volume_id}.php"
                ),
                "collection": "CMG",
                "sourceIds": ["fixture"],
                "sourceCollections": ["CMG"],
                "workItemIds": work_ids,
                "workCount": work_count,
            }
        )

    overrides = [
        {
            "viewerId": f"viewer_{index:03d}",
            "viewerPath": f"viewer_{index:03d}.php",
            "metsPath": f"mets/custom_{index:03d}.xml",
        }
        for index in range(18)
    ]
    fallbacks = [
        {
            "viewerId": f"viewer_{index:03d}",
            "viewerPath": f"viewer_{index:03d}.php",
        }
        for index in range(18, 44)
    ]
    census = {"schemaVersion": 1, "volumes": volumes, "works": works}
    mets_config = {
        "schemaVersion": 1,
        "defaultPattern": "mets/{viewerStem}.xml",
        "overrides": overrides,
        "fallbacks": fallbacks,
        "expectedCounts": {
            "physicalViewerEndpoints": 143,
            "predictableMets": 99,
            "overrideMets": 18,
            "reliableMets": 117,
            "fallbackViewers": 26,
        },
    }
    return census, mets_config


def volume_fixture() -> dict:
    return {
        "id": "cmg_01",
        "label": "Test volume",
        "collection": "CMG",
        "seriesNumber": "I 1",
        "metadata": {
            "contributors": ["Unroled Contributor"],
            "dateIssued": "1915",
            "languages": ["grc"],
        },
        "source": {
            "viewerUrl": "https://cmg.bbaw.de/epubl/online/cmg_01.php"
        },
        "viewerUrl": f"{BASE_URL}/viewer/cmg_01/",
        "manifestUrl": f"{BASE_URL}/iiif/cmg_01/manifest.json",
        "pageCount": 3,
        "firstOrder": 2,
        "lastOrder": 5,
        "orderToCanvasIndex": {"2": 0, "3": 1, "5": 2},
    }


def work_fixture(work_id: str, start_pn: int | None, upstream_url: str) -> dict:
    return {
        "id": work_id,
        "volumeId": "cmg_01",
        "label": "De arte",
        "rawContext": "De arte, in linguam Germanicam vertit, Berlin 1915",
        "rawLabels": ["De arte"],
        "rawContexts": ["De arte, Berlin 1915"],
        "sourceLabels": ["CMG editions"],
        "sourceCollections": ["CMG"],
        "sourceIds": ["cmg"],
        "collection": "CMG",
        "startPn": start_pn,
        "upstreamWorkUrl": upstream_url,
        "hints": {
            "seriesNumbers": ["I 1"],
            "years": [1915],
            "languagesMentioned": [
                {"code": "deu", "label": "German", "matchedText": "Germanicam"}
            ],
        },
    }


class PlanTests(unittest.TestCase):
    def test_scope_depends_on_actual_coverage(self) -> None:
        known = {"a", "b"}
        self.assertEqual(sync_full.synchronization_scope(set(), known), "full")
        self.assertEqual(sync_full.synchronization_scope({"a", "b"}, known), "full")
        self.assertEqual(sync_full.synchronization_scope({"a"}, known), "partial")

    def test_reviewed_census_maps_218_works_onto_143_plans(self) -> None:
        census, mets_config = full_census_fixture()
        plans = sync_full.build_plans(census, mets_config)
        self.assertEqual(len(plans), 143)
        self.assertEqual(sum(len(plan["works"]) for plan in plans), 218)
        self.assertEqual(
            {kind: sum(plan["kind"] == kind for plan in plans) for kind in {
                "mets-predictable", "mets-override", "fallback"
            }},
            {"mets-predictable": 99, "mets-override": 18, "fallback": 26},
        )
        self.assertEqual(plans[0]["seed"]["metsPath"], "mets/custom_000.xml")
        self.assertEqual(plans[18]["kind"], "fallback")
        self.assertEqual(plans[44]["seed"]["metsPath"], "mets/viewer_044.xml")
        self.assertEqual(plans[0]["seed"]["seriesNumber"], "I 1")

    def test_orphan_work_and_reviewed_path_drift_fail_closed(self) -> None:
        census, mets_config = full_census_fixture()
        census["works"].append(
            {
                "id": "orphan--pn-2--01",
                "volumeId": "orphan",
                "hints": {"seriesNumbers": []},
            }
        )
        with self.assertRaisesRegex(sync_full.FullSyncError, "absent from the census"):
            sync_full.build_plans(census, mets_config)

        census, mets_config = full_census_fixture()
        mets_config["overrides"][0]["viewerPath"] = "wrong.php"
        with self.assertRaisesRegex(sync_full.FullSyncError, "viewer path mismatch"):
            sync_full.build_plans(census, mets_config)


class WorkOutputTests(unittest.TestCase):
    def test_default_and_explicit_starts_produce_stable_work_deep_links(self) -> None:
        volume = volume_fixture()
        default = sync_full.work_catalogue_item(
            work_fixture(
                "cmg_01--pn-default--01",
                None,
                "https://cmg.bbaw.de/epubl/online/cmg_01.php",
            ),
            volume,
        )
        deep = sync_full.work_catalogue_item(
            work_fixture(
                "cmg_01--pn-5--01",
                5,
                "https://cmg.bbaw.de/epubl/online/cmg_01.php?p=5",
            ),
            volume,
        )
        self.assertEqual(default["startPn"], 2)
        self.assertEqual(default["viewerDeepLink"], f"{BASE_URL}/viewer/cmg_01/?pn=2")
        self.assertEqual(deep["startPn"], 5)
        self.assertEqual(deep["viewerDeepLink"], f"{BASE_URL}/viewer/cmg_01/?pn=5")
        self.assertEqual(
            deep["sourceUrl"],
            "https://cmg.bbaw.de/epubl/online/cmg_01.php?p=5",
        )

    def test_language_and_contributor_hints_are_not_promoted_to_uncertain_roles(self) -> None:
        item = sync_full.work_catalogue_item(
            work_fixture(
                "cmg_01--pn-5--01",
                5,
                "https://cmg.bbaw.de/epubl/online/cmg_01.php?p=5",
            ),
            volume_fixture(),
        )
        self.assertEqual(item["languages"], ["grc"])
        self.assertEqual(item["languageHints"][0]["code"], "deu")
        self.assertEqual(item["editors"], [])
        self.assertEqual(item["contributors"], ["Unroled Contributor"])
        self.assertIn("German", item["searchTerms"])

    def test_missing_physical_start_fails_before_existing_outputs_are_cleared(self) -> None:
        volume = volume_fixture()
        invalid_work = work_fixture(
            "cmg_01--pn-99--01",
            99,
            "https://cmg.bbaw.de/epubl/online/cmg_01.php?p=99",
        )
        census = {
            "schemaVersion": 1,
            "verifiedAgainst": "fixture",
            "counts": {},
            "sources": [],
            "works": [invalid_work],
        }
        plans = [{"kind": "mets-predictable", "seed": {"id": "cmg_01"}}]
        manifest = {
            "id": f"{BASE_URL}/iiif/cmg_01/manifest.json",
            "type": "Manifest",
            "thumbnail": [{"id": "https://example.test/thumb.jpg"}],
        }
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary)
            marker = dist / "data" / "volumes" / "existing.json"
            marker.parent.mkdir(parents=True)
            marker.write_text("existing", encoding="utf-8")
            with self.assertRaisesRegex(sync_full.FullSyncError, "missing pn=99"):
                sync_full.write_outputs(
                    census=census,
                    plans=plans,
                    results={"cmg_01": (volume, manifest)},
                    dist_dir=dist,
                    base_url=BASE_URL,
                    generated_at="2026-08-25T12:00:00Z",
                    mode="offline",
                    scope="full",
                )
            self.assertEqual(marker.read_text(encoding="utf-8"), "existing")

    def test_write_outputs_preserves_both_work_level_starts(self) -> None:
        volume = volume_fixture()
        works = [
            work_fixture(
                "cmg_01--pn-default--01",
                None,
                "https://cmg.bbaw.de/epubl/online/cmg_01.php",
            ),
            work_fixture(
                "cmg_01--pn-5--01",
                5,
                "https://cmg.bbaw.de/epubl/online/cmg_01.php?p=5",
            ),
        ]
        census = {
            "schemaVersion": 1,
            "verifiedAgainst": "fixture",
            "counts": {"searchableWorkEntries": 2, "physicalViewerEndpoints": 1},
            "sources": [],
            "works": works,
        }
        plans = [{"kind": "mets-predictable", "seed": {"id": "cmg_01"}}]
        manifest = {
            "id": f"{BASE_URL}/iiif/cmg_01/manifest.json",
            "type": "Manifest",
            "thumbnail": [{"id": "https://example.test/thumb.jpg"}],
        }
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary)
            sync_full.write_outputs(
                census=census,
                plans=plans,
                results={"cmg_01": (volume, manifest)},
                dist_dir=dist,
                base_url=BASE_URL,
                generated_at="2026-08-25T12:00:00Z",
                mode="offline",
                scope="partial",
            )
            catalogue_data = json.loads(
                (dist / "data" / "catalogue.json").read_text(encoding="utf-8")
            )
            report_data = json.loads(
                (dist / "data" / "sync-report.json").read_text(encoding="utf-8")
            )
        self.assertEqual(catalogue_data["itemCount"], 2)
        self.assertEqual(
            [item["startPn"] for item in catalogue_data["items"]], [2, 5]
        )
        self.assertEqual(catalogue_data["volumeCount"], 1)
        self.assertEqual(catalogue_data["scope"], "partial")
        self.assertEqual(report_data["scope"], "partial")
        self.assertEqual(report_data["sourceCountsScope"], "full-upstream-census")


if __name__ == "__main__":
    unittest.main()
