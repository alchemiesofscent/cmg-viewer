from __future__ import annotations

import unittest

from scripts import sync


HTML_FIXTURE = """<!doctype html>
<html><body>
<h1>Test volume, CMG X 1, Berlin 2000</h1>
<ul><li>Unrelated navigation <a href="other.php?p=99">Other</a></li></ul>
<ul id="inhaltsverzeichnis">
  <li><a href="javascript:InhaltInFrame(2, true);">Titelei</a></li>
  <li><a href="test.html?p=3=5">Greek text</a></li>
  <li><a href="javascript:InhaltInFrame(4, true);">Translation</a></li>
</ul>
<script>
url="https://digilib.bbaw.de/digitallibrary/servlet/Scaler?fn=/silo10/cmg/test/&pn=";
overhead=0;
ende_real=5;
anf_real=2;
</script>
</body></html>
"""


METS_FIXTURE = b"""<?xml version="1.0" encoding="UTF-8"?>
<mets:mets xmlns:mets="http://www.loc.gov/METS/"
           xmlns:mods="http://www.loc.gov/mods/v3"
           xmlns:xlink="http://www.w3.org/1999/xlink">
  <mets:dmdSec ID="dmd_test"><mets:mdWrap MDTYPE="MODS"><mets:xmlData>
    <mods:mods>
      <mods:titleInfo><mods:title>Test volume. CMG X 1</mods:title></mods:titleInfo>
      <mods:name type="personal"><mods:displayForm>Editor, E.</mods:displayForm></mods:name>
      <mods:originInfo><mods:dateIssued>2000</mods:dateIssued></mods:originInfo>
      <mods:language><mods:languageTerm>grc</mods:languageTerm></mods:language>
    </mods:mods>
  </mets:xmlData></mets:mdWrap></mets:dmdSec>
  <mets:fileSec><mets:fileGrp USE="MAX">
    <mets:file ID="test_file_0002_MAX"><mets:FLocat xlink:href="https://cmg.bbaw.de/test_0002-max.jpg" /></mets:file>
    <mets:file ID="test_file_0003_MAX"><mets:FLocat xlink:href="https://cmg.bbaw.de/test_0003-max.jpg" /></mets:file>
    <mets:file ID="test_file_0004_MAX"><mets:FLocat xlink:href="https://cmg.bbaw.de/test_0004-max.jpg" /></mets:file>
    <mets:file ID="test_file_0005_MAX"><mets:FLocat xlink:href="https://cmg.bbaw.de/test_0005-max.jpg" /></mets:file>
  </mets:fileGrp></mets:fileSec>
  <mets:structMap TYPE="PHYSICAL"><mets:div TYPE="physSequence">
    <mets:div ID="test_div_0002" ORDER="2" ORDERLABEL="II"><mets:fptr FILEID="test_file_0002_MAX" /></mets:div>
    <mets:div ID="test_div_0003" ORDER="3" ORDERLABEL="1"><mets:fptr FILEID="test_file_0003_MAX" /></mets:div>
    <mets:div ID="test_div_0004" ORDER="4" ORDERLABEL="2"><mets:fptr FILEID="test_file_0004_MAX" /></mets:div>
    <mets:div ID="test_div_0005" ORDER="5" ORDERLABEL="3"><mets:fptr FILEID="test_file_0005_MAX" /></mets:div>
  </mets:div></mets:structMap>
  <mets:structMap TYPE="LOGICAL"><mets:div ID="log_test" TYPE="monograph">
    <mets:div ID="test-title" LABEL="Titelei"><mets:fptr FILEID="test_div_0002" /></mets:div>
    <mets:div ID="test-body" LABEL="Body">
      <mets:fptr FILEID="test_div_0003" />
      <mets:fptr FILEID="test_div_0004" />
      <mets:fptr FILEID="test_div_0005" />
    </mets:div>
  </mets:div></mets:structMap>
</mets:mets>
"""


class LiveHTMLTests(unittest.TestCase):
    def test_extracts_only_volume_toc_and_legacy_bounds(self) -> None:
        parsed = sync.parse_live_html(HTML_FIXTURE)
        self.assertEqual(parsed["title"], "Test volume, CMG X 1, Berlin 2000")
        self.assertEqual(parsed["fnDirectory"], "/silo10/cmg/test/")
        self.assertEqual(parsed["firstOrder"], 2)
        self.assertEqual(parsed["lastOrder"], 5)
        self.assertEqual(parsed["lastPhysicalOrder"], 5)
        self.assertEqual([item["label"] for item in parsed["toc"]], [
            "Titelei",
            "Greek text",
            "Translation",
        ])
        self.assertEqual(parsed["toc"][1]["orders"], [3, 5])
        self.assertEqual(parsed["toc"][1]["selection"], "alternating")

    def test_ignores_commented_legacy_assignments(self) -> None:
        source = HTML_FIXTURE.replace(
            "<script>",
            """<!--
<script>
url=\"https://digilib.bbaw.de/digitallibrary/servlet/Scaler?fn=/stale/commented/&pn=\";
ende_real=999;
</script>
-->
<script>""",
            1,
        )
        parsed = sync.parse_live_html(source)
        self.assertEqual(parsed["fnDirectory"], "/silo10/cmg/test/")
        self.assertEqual(parsed["lastOrder"], 5)

    def test_rejects_non_https_scaler_origin(self) -> None:
        source = HTML_FIXTURE.replace(
            "https://digilib.bbaw.de/digitallibrary/servlet/Scaler",
            "http://digilib.bbaw.de/digitallibrary/servlet/Scaler",
        )
        with self.assertRaisesRegex(sync.SyncError, "must use HTTPS"):
            sync.parse_live_html(source)


class METSTests(unittest.TestCase):
    def test_preserves_physical_order_and_printed_label(self) -> None:
        parsed = sync.parse_mets(METS_FIXTURE)
        self.assertEqual([page["order"] for page in parsed["pages"]], [2, 3, 4, 5])
        self.assertEqual([page["label"] for page in parsed["pages"]], ["II", "1", "2", "3"])
        self.assertEqual(parsed["metadata"]["title"], "Test volume. CMG X 1")
        self.assertEqual(parsed["metadata"]["contributors"], ["Editor, E."])
        self.assertEqual(parsed["logicalRoot"]["items"][1]["orders"], [3, 4, 5])

    def test_derives_native_iiif_service_from_fn_directory_and_max_basename(self) -> None:
        service = sync.image_service_id(
            "/silo10/cmg/test/", "https://cmg.bbaw.de/test_0040-max.jpg"
        )
        self.assertEqual(
            service,
            "https://digilib.bbaw.de/digilib/Scaler/IIIF/silo10!cmg!test!test_0040",
        )

    def test_uses_directory_manifester_as_filename_dimension_index(self) -> None:
        payload = b'''{
          "type": "Manifest",
          "items": [
            {"type": "Canvas", "label": {"none": ["test_0001"]}, "width": 1200, "height": 1800},
            {"type": "Canvas", "label": {"none": ["test_0002"]}, "width": 1602, "height": 2402}
          ]
        }'''
        pages = [{"order": 2, "maxHref": "https://example.test/test_0002-max.jpg"}]
        missing = sync.enrich_pages_from_manifester(pages, payload)
        self.assertEqual(missing, [])
        self.assertEqual((pages[0]["width"], pages[0]["height"]), (1602, 2402))
        self.assertEqual(
            sync.manifester_url("/silo10/cmg/test/"),
            "https://digilib.bbaw.de/digilib/Manifester/IIIF/3/silo10!cmg!test",
        )

    def test_verified_directory_position_repairs_stale_derivative_names(self) -> None:
        payload = b'''{
          "type": "Manifest",
          "items": [
            {"type": "Canvas", "label": {"none": ["part_01_0000"]}, "width": 1200, "height": 1800},
            {"type": "Canvas", "label": {"none": ["part_01_0002"]}, "width": 1300, "height": 1900},
            {"type": "Canvas", "label": {"none": ["x_part_01_0001"]}, "width": 300, "height": 400}
          ]
        }'''
        pages = [{
            "order": 1,
            "maxHref": "https://example.test/stale_0001-max.jpg",
            "imageBasename": "stale_0001",
            "imageServiceId": "https://digilib.bbaw.de/digilib/Scaler/IIIF/stale",
        }]
        missing = sync.enrich_pages_from_manifester(
            pages,
            payload,
            fn_directory="/silo10/cmg/multipart/",
            directory_page_count=2,
        )
        self.assertEqual(missing, [])
        self.assertEqual(pages[0]["imageBasename"], "part_01_0000")
        self.assertEqual((pages[0]["width"], pages[0]["height"]), (1200, 1800))
        self.assertTrue(pages[0]["imageServiceId"].endswith("!part_01_0000"))

    def test_repairs_single_duplicate_physical_order_from_stable_ids(self) -> None:
        payload = METS_FIXTURE
        for old, temporary in (
            (b"test_div_0002", b"test_div_TMP1"),
            (b"test_div_0003", b"test_div_TMP2"),
            (b"test_div_0004", b"test_div_TMP3"),
            (b"test_div_0005", b"test_div_TMP4"),
        ):
            payload = payload.replace(old, temporary)
        for temporary, new in (
            (b"test_div_TMP1", b"test_div_0001"),
            (b"test_div_TMP2", b"test_div_0002"),
            (b"test_div_TMP3", b"test_div_0003"),
            (b"test_div_TMP4", b"test_div_0004"),
        ):
            payload = payload.replace(temporary, new)
        payload = payload.replace(b'ID="test_div_0002" ORDER="3"', b'ID="test_div_0002" ORDER="2"')
        payload = payload.replace(b'ID="test_div_0003" ORDER="4"', b'ID="test_div_0003" ORDER="3"')
        payload = payload.replace(b'ID="test_div_0004" ORDER="5"', b'ID="test_div_0004" ORDER="4"')

        parsed = sync.parse_mets(payload)
        self.assertEqual([page["order"] for page in parsed["pages"]], [1, 2, 3, 4])
        self.assertEqual(parsed["logicalRoot"]["items"][0]["orders"], [1])

    def test_missing_derivative_and_duplicate_logical_id_become_warnings(self) -> None:
        missing_file = (
            b'    <mets:file ID="test_file_0002_MAX"><mets:FLocat '
            b'xlink:href="https://cmg.bbaw.de/test_0002-max.jpg" /></mets:file>\n'
        )
        payload = METS_FIXTURE.replace(missing_file, b"")
        payload = payload.replace(b'ID="test-body" LABEL="Body"', b'ID="test-title" LABEL="Body"')

        parsed = sync.parse_mets(payload)
        self.assertEqual(parsed["pages"][0]["maxHref"], "")
        self.assertEqual(len({node["id"] for node in sync.walk_ranges(parsed["logicalRoot"])}), 3)
        self.assertTrue(any("no resolvable METS image" in item for item in parsed["warnings"]))
        self.assertTrue(any("Duplicate METS logical range ID" in item for item in parsed["warnings"]))


class GenerationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.live = sync.parse_live_html(HTML_FIXTURE)
        self.mets = sync.parse_mets(METS_FIXTURE)
        for page in self.mets["pages"]:
            page["imageServiceId"] = sync.image_service_id(
                self.live["fnDirectory"], page["maxHref"]
            )
            page["width"] = 1600 + page["order"]
            page["height"] = 2400 + page["order"]
        self.seed = {
            "id": "test",
            "collection": "CMG",
            "seriesNumber": "X 1",
            "samplePn": 3,
            "expected": {"pageCount": 4, "firstOrder": 2, "lastOrder": 5},
        }

    def test_merged_contents_keep_provenance_and_alternating_pages(self) -> None:
        structures = sync.merge_structures(
            "test",
            self.mets["logicalRoot"],
            self.live["toc"],
            {2, 3, 4, 5},
            "Test",
        )
        title = next(item for item in structures["items"] if item["label"] == "Titelei")
        greek = next(item for item in structures["items"] if item["label"] == "Greek text")
        self.assertEqual(title["provenance"], ["mets", "html"])
        self.assertEqual(greek["orders"], [3, 5])
        self.assertEqual(greek["provenance"], ["html"])

    def test_volume_map_does_not_treat_pn_as_array_index(self) -> None:
        structures = sync.merge_structures(
            "test",
            self.mets["logicalRoot"],
            self.live["toc"],
            {2, 3, 4, 5},
            "Test",
        )
        volume = sync.build_volume_record(
            self.seed,
            self.live["title"],
            self.mets["metadata"],
            self.mets["pages"],
            structures,
            "https://example.test/cmg-viewer",
            "https://cmg.bbaw.de/epubl/online/test.php",
            "https://cmg.bbaw.de/epubl/online/mets/test.xml",
        )
        self.assertEqual(volume["orderToCanvasIndex"], {"2": 0, "3": 1, "4": 2, "5": 3})
        self.assertEqual(volume["pages"][1]["label"], "1")
        self.assertIn("pn=3", volume["pages"][1]["sourcePageUrl"])
        self.assertEqual(
            volume["pages"][1]["thumbnailUrl"],
            f"{volume['pages'][1]['imageServiceId']}/full/200,/0/default.jpg",
        )


if __name__ == "__main__":
    unittest.main()
