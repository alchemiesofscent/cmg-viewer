"""Apply explicitly reviewed corrections to every built corpus snapshot."""
import json
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1] / 'config' / 'metadata-corrections.json'


def correct_record(record, correction):
    evidence = record.setdefault('metadataProvenance', {})
    for field in ('authors', 'years'):
        if field not in correction:
            continue
        record[field] = list(correction[field])
        evidence[field] = [{'value': value, 'source': 'reviewed-catalogue-correction',
                            'evidence': correction['evidence'], 'evidenceField': 'config/metadata-corrections.json'}
                           for value in record[field]]
    if 'years' in correction:
        record['year'] = record['years'][0] if len(record['years']) == 1 else ''
        evidence['year'] = list(evidence['years']) if record['year'] else []


def apply_corrections(dist, config=CONFIG):
    corrections = json.loads(config.read_text(encoding='utf-8'))
    catalogue_path = dist / 'data' / 'catalogue.json'
    catalogue = json.loads(catalogue_path.read_text(encoding='utf-8'))
    for item in catalogue.get('items', []):
        correction = corrections.get(item.get('volumeId'))
        if correction:
            correct_record(item, correction)
    catalogue_path.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for volume_id, correction in corrections.items():
        path = dist / 'data' / 'volumes' / f'{volume_id}.json'
        if path.exists():
            volume = json.loads(path.read_text(encoding='utf-8'))
            correct_record(volume, correction)
            path.write_text(json.dumps(volume, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
