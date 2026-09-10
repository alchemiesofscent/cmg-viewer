import json
import unittest
from scripts.metadata_corrections import CONFIG, correct_record
from scripts.validate import validate_catalogue_metadata

class CorrectionTests(unittest.TestCase):
    def test_reviewed_roles_dates_and_provenance(self):
        corrections = json.loads(CONFIG.read_text())
        for key, expected in [('diels_01', '1906'), ('diels_02', '1905'), ('diels_03', '1906'), ('diels_04', '1908')]:
            record = {'id': key, 'languages': [], 'authors': [], 'editors': [], 'translationLanguages': [], 'seriesNumbers': [], 'seriesNumber': '', 'years': [], 'year': '', 'metadataProvenance': {}}
            correct_record(record, corrections[key])
            self.assertEqual(record['authors'], ['Diels'])
            self.assertEqual(record['years'], [expected])
            validate_catalogue_metadata(record)
            before = json.dumps(record, sort_keys=True)
            correct_record(record, corrections[key])
            self.assertEqual(json.dumps(record, sort_keys=True), before)
        self.assertEqual(corrections['cmg_05_13_02']['authors'], ['[Galen]'])
        self.assertEqual(corrections['suppl_06']['authors'], ['Kollesch'])
