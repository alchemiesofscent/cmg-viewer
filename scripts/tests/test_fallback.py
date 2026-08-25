from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
import urllib.parse

from scripts import fallback


VIEWER_ID = "fallback_test"
VIEWER_PATH = "fallback_test.php"
FN_DIRECTORY = "/silo10/cmg/fallback_test/"

HTML_FIXTURE = """<!doctype html>
<html><head><title>Short fallback title</title></head><body>
<h1><a href="fallback_test.php">A fallback volume,<br>edited for testing</a></h1>
<ul><li><a href="elsewhere.php?p=99">Unrelated navigation</a></li></ul>
<ul id="inhaltsverzeichnis">
  <li><a href="javascript:InhaltInFrame(1, true);">Titelei</a>
    <ul><li><a href="javascript:InhaltInFrame(3, true);">Text</a></li></ul>
  </li>
  <li><a href="fallback_test.php?p=2=4">Facing transcription</a></li>
</ul>
<script>
url="https://digilib.bbaw.de/digitallibrary/servlet/Scaler?fn=/silo10/cmg/fallback_test/&pn=";
urlx="http://cmg.bbaw.de/epubl/online/PDF/fallback_test/fallback_test_";
overhead=2;
ende_real=3;
anf_real=1;
</script>
</body></html>
"""


def identifier(basename: str) -> str:
    return f"silo10!cmg!fallback_test!{basename}"


def service(basename: str) -> str:
    return f"{fallback.IMAGE_API_ROOT}/{identifier(basename)}"


def info_payload(basename: str, order: int) -> bytes:
    return json.dumps(
        {
            "@context": "http://iiif.io/api/image/2/context.json",
            "@id": service(basename),
            "protocol": "http://iiif.io/api/image",
            "width": 1600 + order,
            "height": 2400 + order,
            "profile": ["http://iiif.io/api/image/2/level2.json"],
        }
    ).encode("utf-8")


def manifester_payload(basenames: list[str], *, host: str = "digilib.bbaw.de") -> bytes:
    canvases = []
    for index, basename in enumerate(basenames, start=1):
        encoded = urllib.parse.quote(identifier(basename), safe="")
        # BBAW currently emits this proxy-root form without `/digilib`.  The
        # fallback parser must use it only as identifier evidence.
        service_id = f"https://{host}/Scaler/IIIF/3/{encoded}"
        canvases.append(
            {
                "id": f"https://{host}/Manifester/IIIF/3/test/canvas/p{index}",
                "type": "Canvas",
                "label": {"none": [basename]},
                "width": 1600 + index,
                "height": 2400 + index,
                "items": [
                    {
                        "id": f"https://{host}/canvas/p{index}/page",
                        "type": "AnnotationPage",
                        "items": [
                            {
                                "id": f"https://{host}/canvas/p{index}/painting",
                                "type": "Annotation",
                                "motivation": "painting",
                                "body": {
                                    "id": f"{service_id}/full/1000,/0/default.jpg",
                                    "type": "Image",
                                    "service": [
                                        {
                                            "id": service_id,
                                            "type": "ImageService3",
                                            "profile": "level2",
                                        }
                                    ],
                                },
                            }
                        ],
                    }
                ],
            }
        )
    return json.dumps(
        {
            "@context": "http://iiif.io/api/presentation/3/context.json",
            "id": "https://digilib.bbaw.de/Manifester/IIIF/3/test",
            "type": "Manifest",
            "label": {"none": ["Test"]},
            "items": canvases,
        }
    ).encode("utf-8")


class HTMLParsingTests(unittest.TestCase):
    def test_parses_active_bounds_toc_directory_and_prefix_signals(self) -> None:
        value = fallback.parse_fallback_html(
            HTML_FIXTURE, viewer_id=VIEWER_ID, viewer_path=VIEWER_PATH
        )
        self.assertEqual(value["title"], "A fallback volume, edited for testing")
        self.assertEqual(value["fnDirectory"], FN_DIRECTORY)
        self.assertEqual(value["anfReal"], 1)
        self.assertEqual(value["endeReal"], 3)
        self.assertEqual(value["overhead"], 2)
        self.assertEqual(value["physicalCountCandidates"], [5, 3])
        self.assertEqual(value["pdfUrlPrefix"], (
            "https://cmg.bbaw.de/epubl/online/PDF/fallback_test/fallback_test_"
        ))
        prefixes = {item["prefix"] for item in value["basenameSignals"]}
        self.assertIn("fallback_test_", prefixes)
        self.assertEqual([item["label"] for item in value["toc"]], [
            "Titelei", "Text", "Facing transcription"
        ])
        self.assertEqual(value["toc"][1]["depth"], 1)
        self.assertEqual(value["toc"][2]["orders"], [2, 4])

    def test_rejects_non_bbaw_scaler(self) -> None:
        source = HTML_FIXTURE.replace("digilib.bbaw.de", "images.example.test")
        with self.assertRaisesRegex(fallback.FallbackError, "Unexpected legacy URL"):
            fallback.parse_fallback_html(source)


class ManifesterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.live = fallback.parse_fallback_html(
            HTML_FIXTURE, viewer_id=VIEWER_ID, viewer_path=VIEWER_PATH
        )

    def test_normalizes_broken_proxy_root_to_versionless_v2_service(self) -> None:
        pages = fallback.parse_manifester(
            manifester_payload(["fallback_test_0001"]), FN_DIRECTORY
        )
        self.assertEqual(pages[0]["directoryOrder"], 1)
        self.assertEqual(pages[0]["imageBasename"], "fallback_test_0001")
        self.assertEqual(pages[0]["imageServiceId"], service("fallback_test_0001"))

    def test_rejects_non_allowlisted_image_service(self) -> None:
        payload = manifester_payload(["fallback_test_0001"], host="evil.example")
        with self.assertRaisesRegex(fallback.FallbackError, "allowlisted HTTPS"):
            fallback.parse_manifester(payload, FN_DIRECTORY)

    def test_selects_unique_signalled_prefix_and_excludes_stray_file(self) -> None:
        basenames = [f"fallback_test_{number:04d}" for number in range(2, 7)]
        basenames.append("xfallback_test_0001")
        inventory = fallback.parse_manifester(
            manifester_payload(basenames), FN_DIRECTORY
        )
        pages, audit = fallback.select_manifester_pages(
            inventory, self.live, {"viewerId": VIEWER_ID}
        )
        self.assertEqual(len(pages), 5)
        self.assertEqual(pages[0]["imageBasename"], "fallback_test_0002")
        self.assertEqual(pages[-1]["imageBasename"], "fallback_test_0006")
        self.assertEqual(audit["mode"], "signalled-prefix:fallback_test_")
        self.assertEqual(audit["directoryImageCount"], 6)

    def test_stale_count_requires_explicit_override(self) -> None:
        inventory = fallback.parse_manifester(
            manifester_payload([f"fallback_test_{number:04d}" for number in range(1, 5)]),
            FN_DIRECTORY,
        )
        with self.assertRaisesRegex(fallback.FallbackError, "fallbackPageCount"):
            fallback.select_manifester_pages(
                inventory, self.live, {"viewerId": VIEWER_ID}
            )
        pages, audit = fallback.select_manifester_pages(
            inventory,
            self.live,
            {"viewerId": VIEWER_ID, "fallbackPageCount": 4},
        )
        self.assertEqual(len(pages), 4)
        self.assertTrue(audit["overridden"])


class GenerationTests(unittest.TestCase):
    def _transport(self, mapping: dict[str, bytes]):
        def fetch(url: str) -> bytes:
            try:
                return mapping[url]
            except KeyError as exc:
                raise fallback.FetchError(
                    f"fixture has no {url}", status=404
                ) from exc

        return fetch

    def test_builds_sync_compatible_inputs_and_reuses_cache_offline(self) -> None:
        basenames = [f"fallback_test_{number:04d}" for number in range(1, 6)]
        viewer_url = urllib.parse.urljoin(fallback.CMG_ONLINE, VIEWER_PATH)
        manifest_url = fallback.manifester_url(FN_DIRECTORY)
        mapping = {
            viewer_url: HTML_FIXTURE.encode("utf-8"),
            manifest_url: manifester_payload(basenames),
        }
        for order, basename in enumerate(basenames, start=1):
            mapping[f"{service(basename)}/info.json"] = info_payload(basename, order)

        entry = {"viewerId": VIEWER_ID, "viewerPath": VIEWER_PATH}
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            value = fallback.build_fallback_inputs(
                entry,
                cache_dir=cache,
                offline=False,
                refresh=True,
                workers=3,
                transport=self._transport(mapping),
            )
            offline_value = fallback.build_fallback_inputs(
                entry,
                cache_dir=cache,
                offline=True,
                refresh=False,
                workers=2,
                transport=lambda _url: self.fail("offline mode used the transport"),
            )

        self.assertEqual(value["title"], "A fallback volume, edited for testing")
        self.assertEqual(value["metadata"]["contributors"], [])
        self.assertEqual([page["order"] for page in value["pages"]], [1, 2, 3, 4, 5])
        self.assertEqual([page["label"] for page in value["pages"]], [
            "I", "II", "1", "2", "3"
        ])
        self.assertEqual(value["pages"][2]["width"], 1603)
        self.assertEqual(value["pages"][2]["physicalId"], "fallback_phys_000003")
        self.assertEqual(value["pages"][2]["maxFileId"], "fallback_max_000003")
        self.assertTrue(value["pages"][2]["maxHref"].endswith(
            "/full/full/0/default.jpg"
        ))
        root = value["logicalRoot"]
        self.assertEqual(root["provenance"], ["html"])
        self.assertEqual(root["items"][0]["items"][0]["label"], "Text")
        self.assertEqual(value["source"]["metsUrl"], None)
        self.assertEqual(
            [page["imageServiceId"] for page in offline_value["pages"]],
            [page["imageServiceId"] for page in value["pages"]],
        )

    def test_numbered_pattern_discovery_is_bounded_and_unique(self) -> None:
        live = fallback.parse_fallback_html(
            HTML_FIXTURE.replace("overhead=2;", "overhead=0;"),
            viewer_id=VIEWER_ID,
            viewer_path=VIEWER_PATH,
        )
        entry = {
            "viewerId": VIEWER_ID,
            "fallbackImagePrefix": "fallback_test_",
            "fallbackNumberWidths": [4],
            "fallbackImageNumberOffsets": [1],
        }
        mapping = {
            f"{service(f'fallback_test_{number:04d}')}/info.json": info_payload(
                f"fallback_test_{number:04d}", number - 1
            )
            for number in range(2, 5)
        }
        with tempfile.TemporaryDirectory() as directory:
            pages, audit = fallback.discover_pattern_pages(
                live,
                entry,
                page_count=3,
                cache_dir=Path(directory),
                offline=False,
                refresh=True,
                transport=self._transport(mapping),
            )
        self.assertEqual([page["imageBasename"] for page in pages], [
            "fallback_test_0002", "fallback_test_0003", "fallback_test_0004"
        ])
        self.assertEqual(audit["mode"], "numbered-pattern")
        self.assertEqual(audit["offset"], 1)


class ConfigurationTests(unittest.TestCase):
    def test_repository_declares_reviewed_26_fallbacks(self) -> None:
        project_root = Path(__file__).resolve().parents[2]
        config_path = project_root / "config" / "mets-overrides.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        entries = fallback.load_fallback_config(config_path)
        self.assertEqual(len(entries), 26)
        self.assertEqual(len({entry["viewerId"] for entry in entries}), 26)
        self.assertEqual(config["expectedCounts"], {
            "physicalViewerEndpoints": 143,
            "predictableMets": 99,
            "overrideMets": 18,
            "reliableMets": 117,
            "fallbackViewers": 26,
        })
        self.assertEqual(config["verifiedPredictableWithoutActiveLink"], [
            "wa_prisc_eupor"
        ])
        reclassified = {
            entry["viewerId"]
            for entry in entries
            if entry.get("reason") == "predictable-mets-path-returned-non-mets-content"
        }
        self.assertEqual(reclassified, {
            "wu_Gal_allgemeineTherapie_Beek",
            "wu_Gal_allgemeineTherapie_Carney",
            "wu_Gal_DiaetetPhysikTherapie_Beck",
            "wu_Gal_Therapie_Meyer",
            "wu_Gal_WunduGeschwuersheilung_Glaser",
        })
        overrides = {
            entry["viewerId"]: entry.get("fallbackPageCount")
            for entry in entries
            if "fallbackPageCount" in entry
        }
        self.assertEqual(overrides, {
            "wa_Physici_Medici_Graeci_Ideler_01": 446,
            "wu_Gal_Geschwuer_Pruesmann": 31,
            "wu_Werke_des_Galenos_Bd_IV": 164,
        })


if __name__ == "__main__":
    unittest.main()
