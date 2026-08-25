from __future__ import annotations

import unittest

from scripts import metadata, sync_full


BASE_URL = "https://alchemiesofscent.github.io/cmg-viewer"


def work_fixture(
    label: str,
    *,
    work_id: str = "work--pn-default--01",
    volume_id: str = "volume",
    collection: str = "CMG",
    series: list[str] | None = None,
    years: list[int | str] | None = None,
    raw_context: str | None = None,
) -> dict:
    return {
        "id": work_id,
        "volumeId": volume_id,
        "label": label,
        "rawContext": raw_context or label,
        "rawLabels": [label],
        "rawContexts": [raw_context or label],
        "collection": collection,
        "hints": {
            "seriesNumbers": series or [],
            "years": years or [],
            "languagesMentioned": [],
        },
    }


class ExplicitRoleTests(unittest.TestCase):
    def test_simple_latin_editor_and_anchored_author_are_extracted(self) -> None:
        value = metadata.extract_work_metadata(
            work_fixture(
                "Hippocratis De arte, edidit J. L. Heiberg, Berlin 1927",
                series=["I 1"],
                years=[1927],
            )
        )
        self.assertEqual(value["authors"], ["Hippocrates"])
        self.assertEqual(value["editors"], ["J. L. Heiberg"])
        self.assertEqual(value["translationLanguages"], [])
        self.assertEqual(
            value["metadataProvenance"]["editors"][0]["source"],
            "catalogue-explicit-editor-role",
        )

    def test_compound_editor_translator_clauses_assign_both_exact_roles(self) -> None:
        cases = (
            (
                "Hippocratis De aere aquis locis, edidit et in linguam "
                "Germanicam vertit H. Diller, Berlin 1970",
                ["H. Diller"],
                ["German"],
            ),
            (
                "Hippocratis De natura hominis, edidit, in linguam "
                "Francogallicam vertit, commentatus est J. Jouanna, Berlin 1975",
                ["J. Jouanna"],
                ["French"],
            ),
            (
                "Ioannis Alexandrini Fragmenta, ediderunt et in linguam Anglicam "
                "verterunt T. A. Bell, D. P. Carpenter et L. G. Westerink, Berlin 1997",
                ["T. A. Bell", "D. P. Carpenter", "L. G. Westerink"],
                ["English"],
            ),
        )
        for citation, editors, languages in cases:
            with self.subTest(citation=citation):
                value = metadata.extract_work_metadata(work_fixture(citation))
                self.assertEqual(value["editors"], editors)
                self.assertEqual(value["translationLanguages"], languages)

    def test_separate_editor_and_translator_people_are_not_conflated(self) -> None:
        citation = (
            "Galeni In Hippocratis Epidemiarum librum I commentaria III, "
            "edidit E. Wenkebach; commentaria V, in Germanicam linguam "
            "transtulit F. Pfaff, Berlin 1934"
        )
        value = metadata.extract_work_metadata(work_fixture(citation))
        self.assertEqual(value["editors"], ["E. Wenkebach"])
        self.assertNotIn("F. Pfaff", value["editors"])
        self.assertEqual(value["translationLanguages"], ["German"])

    def test_explicit_multi_editor_and_german_compound_forms(self) -> None:
        latin = metadata.extract_work_metadata(
            work_fixture(
                "Apollonii Citiensis Commentarius, ediderunt J. Kollesch et "
                "F. Kudlien, in linguam Germanicam transtulerunt J. Kollesch "
                "et D. Nickel, Berlin 1965"
            )
        )
        german = metadata.extract_work_metadata(
            work_fixture(
                "Sieben Bücher Anatomie des Galen, arab. hrsg., übers. u. erl. "
                "v. M. Simon, Bd. I, Leipzig 1906",
                collection="Weitere Ausgaben",
            )
        )
        self.assertEqual(latin["editors"], ["J. Kollesch", "F. Kudlien"])
        self.assertEqual(latin["translationLanguages"], ["German"])
        self.assertEqual(german["editors"], ["M. Simon"])
        # The citation says that it is translated but does not state a target.
        self.assertEqual(german["translationLanguages"], [])

    def test_cached_german_and_english_editor_phrases_are_not_truncated(self) -> None:
        german = metadata.extract_work_metadata(
            work_fixture(
                "Die als sogenannte Simulantenschrift überlieferten Stücke, "
                "hrsg. v. K. Deichgräber u. F. Kudlien, Berlin 1960"
            )
        )
        expanded = metadata.extract_work_metadata(
            work_fixture(
                "Die pseudogalenische Schrift, eingeleitet, herausgegeben und "
                "übersetzt von K. Schubring, Kiel 1963"
            )
        )
        english = metadata.extract_work_metadata(
            work_fixture(
                "Galen, De tumoribus. A critical edition with translation and "
                "indices, by J. Reedy. Michigan 1968"
            )
        )
        self.assertEqual(german["editors"], ["K. Deichgräber", "F. Kudlien"])
        self.assertEqual(expanded["editors"], ["K. Schubring"])
        self.assertEqual(english["editors"], ["J. Reedy"])

    def test_lowercase_non_person_token_is_not_an_editor(self) -> None:
        value = metadata.extract_work_metadata(
            work_fixture("A bacteriological note, edidit E. coli, Berlin 1910")
        )
        self.assertEqual(value["editors"], [])

    def test_role_and_language_negatives_fail_closed(self) -> None:
        cases = (
            (
                "Editio altera lucis ope expressa a H. Diller, Berlin 1999",
                [],
                [],
            ),
            (
                "In Hippocratis De natura hominis commentaria III, Berlin 1914",
                [],
                [],
            ),
            (
                "Die Kräfte der Physis, übersetzt und erläutert von E. Beintker",
                [],
                [],
            ),
            (
                "A critical study with translation by J. Reedy",
                [],
                [],
            ),
        )
        for citation, authors, translation_languages in cases:
            with self.subTest(citation=citation):
                value = metadata.extract_work_metadata(work_fixture(citation))
                self.assertEqual(value["authors"], authors)
                self.assertEqual(value["editors"], [])
                self.assertEqual(
                    value["translationLanguages"], translation_languages
                )


class AuthorTests(unittest.TestCase):
    def test_series_prefixed_controlled_author_form_is_evidence(self) -> None:
        value = metadata.extract_work_metadata(
            work_fixture(
                "III 1",
                raw_context="III 1 Rufi Ephesii De renum et vesicae morbis",
                series=["III 1"],
            )
        )
        self.assertEqual(value["authors"], ["Rufus of Ephesus"])
        record = value["metadataProvenance"]["authors"][0]
        self.assertEqual(record["evidence"], "Rufi Ephesii")
        self.assertEqual(record["evidenceField"], "rawContext")

    def test_uncertain_or_subject_only_author_forms_are_not_promoted(self) -> None:
        uncertain = metadata.extract_work_metadata(
            work_fixture("[Galeni] Definitiones medicas")
        )
        subject = metadata.extract_work_metadata(
            work_fixture("De Galeni libro qui Synopsis inscribitur")
        )
        self.assertEqual(uncertain["authors"], [])
        self.assertEqual(subject["authors"], [])

    def test_cached_alexander_and_attributed_pliny_forms_are_canonicalized(self) -> None:
        alexander = metadata.extract_work_metadata(
            work_fixture(
                "Alexander von Tralles, ed. Th. Puschmann, Bd. I, Wien 1878",
                collection="Weitere Ausgaben",
            )
        )
        pliny = metadata.extract_work_metadata(
            work_fixture(
                "Plinii Secundi Iunioris qui feruntur De medicina libri tres, "
                "edidit A. Önnerfors, Berlin 1964",
                collection="CML",
            )
        )
        self.assertEqual(alexander["authors"], ["Alexander of Tralles"])
        self.assertEqual(pliny["authors"], ["Pseudo-Pliny"])

    def test_uncertain_hippocratic_opera_and_spurium_work_remain_unassigned(self) -> None:
        opera = metadata.extract_work_metadata(
            work_fixture(
                "Hippocratis Opera quae feruntur omnia, hrsg. v. H. Kühlewein, "
                "Bd. I, Leipzig 1894",
                collection="Weitere Ausgaben",
            )
        )
        spurium = metadata.extract_work_metadata(
            work_fixture("De victu acutorum (spurium)", collection="Weitere Ausgaben")
        )
        self.assertEqual(opera["authors"], [])
        self.assertEqual(spurium["authors"], [])

    def test_conflicting_general_and_pseudo_author_sources_fail_closed(self) -> None:
        value = metadata.extract_work_metadata(
            work_fixture(
                "Galeni",
                raw_context="Galeni qui fertur De partibus philosophiae libellus",
            )
        )
        self.assertEqual(value["authors"], [])


class VolumeConsensusTests(unittest.TestCase):
    def test_unanimous_series_and_year_propagate_with_provenance(self) -> None:
        works = [
            work_fixture(
                "V 4,2",
                work_id="volume--pn-2--01",
                raw_context="V 4,2 Galeni",
                series=["V 4,2"],
            ),
            work_fixture(
                "De sanitate tuenda, edidit K. Koch, Berlin 1923",
                work_id="volume--pn-67--01",
                years=[1923],
            ),
            work_fixture(
                "De alimentorum facultatibus, edidit G. Helmreich, Berlin 1923",
                work_id="volume--pn-265--01",
                years=[1923],
            ),
        ]
        values = metadata.enrich_works(works)
        self.assertEqual([item["seriesNumber"] for item in values], ["V 4,2"] * 3)
        self.assertEqual([item["year"] for item in values], ["1923"] * 3)
        self.assertEqual(
            values[0]["metadataProvenance"]["year"][0]["source"],
            "catalogue-volume-unanimous",
        )
        self.assertEqual(
            values[1]["metadataProvenance"]["seriesNumber"][0]["source"],
            "catalogue-volume-unanimous",
        )

    def test_conflicts_do_not_propagate_and_multi_year_evidence_is_preserved(self) -> None:
        conflicting = metadata.enrich_works(
            [
                work_fixture(
                    "Header", work_id="conflict--pn-2--01", volume_id="conflict"
                ),
                work_fixture(
                    "First", work_id="conflict--pn-3--01", volume_id="conflict", years=[1900]
                ),
                work_fixture(
                    "Second", work_id="conflict--pn-4--01", volume_id="conflict", years=[1901]
                ),
            ]
        )
        multi = metadata.enrich_works(
            [
                work_fixture(
                    "Reprint",
                    work_id="reprint--pn-default--01",
                    volume_id="reprint",
                    years=[1970, 1999],
                )
            ]
        )[0]
        self.assertEqual(conflicting[0]["years"], [])
        self.assertEqual(conflicting[0]["year"], "")
        self.assertEqual([item["year"] for item in conflicting[1:]], ["1900", "1901"])
        self.assertEqual(multi["years"], ["1970", "1999"])
        self.assertEqual(multi["year"], "")

    def test_conflicting_series_values_do_not_create_a_volume_series(self) -> None:
        works = [
            work_fixture(
                "First", work_id="series--pn-2--01", volume_id="series", series=["I 1"]
            ),
            work_fixture(
                "Second", work_id="series--pn-3--01", volume_id="series", series=["I 2"]
            ),
            work_fixture(
                "Unlabelled", work_id="series--pn-4--01", volume_id="series"
            ),
        ]
        values = metadata.enrich_works(works)
        self.assertEqual(values[2]["seriesNumber"], "")
        self.assertEqual(sync_full.series_number_for_works(works), "")


class FullSyncIntegrationTests(unittest.TestCase):
    def test_edition_year_is_separate_and_roleless_mods_name_stays_contributor(self) -> None:
        work = work_fixture(
            "Hippocratis De aere aquis locis, edidit et in linguam Germanicam "
            "vertit H. Diller, Berlin 1970; editio altera, Berlin 1999",
            volume_id="cmg_01_01_02",
            series=["I 1,2"],
            years=[1970, 1999],
        )
        work.update(
            {
                "startPn": 2,
                "sourceIds": ["cmg"],
                "sourceCollections": ["CMG"],
                "upstreamWorkUrl": "https://cmg.bbaw.de/example",
            }
        )
        volume = {
            "id": "cmg_01_01_02",
            "collection": "CMG",
            "metadata": {
                "contributors": ["Diller, H."],
                "dateIssued": "1999",
                "languages": [],
            },
            "source": {
                "viewerUrl": "https://cmg.bbaw.de/viewer",
                "metsUrl": "https://cmg.bbaw.de/mets/cmg_01_01_02.xml",
            },
            "viewerUrl": f"{BASE_URL}/viewer/cmg_01_01_02/",
            "manifestUrl": f"{BASE_URL}/iiif/cmg_01_01_02/manifest.json",
            "firstOrder": 2,
            "orderToCanvasIndex": {"2": 0},
        }
        item = sync_full.work_catalogue_item(work, volume)
        self.assertEqual(item["editors"], ["H. Diller"])
        self.assertEqual(item["contributors"], ["Diller, H."])
        self.assertNotIn("Diller, H.", item["editors"])
        self.assertEqual(item["years"], ["1970", "1999"])
        self.assertEqual(item["year"], "")
        self.assertEqual(item["editionYear"], "1999")
        self.assertEqual(
            item["metadataProvenance"]["editionYear"][0]["source"],
            "mets-date-issued",
        )


if __name__ == "__main__":
    unittest.main()
