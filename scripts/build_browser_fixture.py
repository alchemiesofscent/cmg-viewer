#!/usr/bin/env python3
"""Build a tiny, explicitly synthetic corpus; never fetch scholarly data or images."""
import json
from pathlib import Path
import shutil
from build import build_site, DEFAULT_SOURCE, DEFAULT_TIFY

ROOT = Path('tmp/browser-site')
BASE = 'http://127.0.0.1:8000/cmg-viewer/'


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


if ROOT.exists():
    shutil.rmtree(ROOT)
items = []
for volume_id, number in [('fixture_a', 'I 1'), ('fixture_b', 'I 2'), ('fixture_c', 'V 1')]:
    label = f'Synthetic browser test volume {number} with a deliberately long interface title'
    manifest_url = f'{BASE}iiif/{volume_id}/manifest.json'
    pages, canvases = [], []
    for index, printed in enumerate(['I', 'II', '1', '2', '3', '4', '5', '6']):
        order = index + 1
        canvas = f'{BASE}iiif/{volume_id}/canvas/p{order}'
        image = f'{BASE}fixture-page.svg?page={order}'
        pages.append({'index': index, 'order': order, 'label': printed, 'width': 600, 'height': 900,
                      'canvasId': canvas, 'imageUrl': image, 'thumbnailUrl': image,
                      'sourcePageUrl': 'https://cmg.bbaw.de/'})
        canvases.append({'id': canvas, 'type': 'Canvas', 'label': {'none': [printed]},
                         'width': 600, 'height': 900, 'items': [{'id': canvas+'/annotations',
                         'type': 'AnnotationPage', 'items': [{'id': canvas+'/painting',
                         'type': 'Annotation', 'motivation': 'painting', 'target': canvas,
                         'body': {'id': image, 'type': 'Image', 'format': 'image/svg+xml', 'width': 600, 'height': 900}}]}]})
    item = {'id': volume_id, 'volumeId': volume_id, 'label': label, 'collection': 'CMG',
            'seriesNumber': number, 'startPn': 1, 'viewerUrl': f'{BASE}viewer/{volume_id}/',
            'manifestUrl': manifest_url, 'sourceUrl': 'https://cmg.bbaw.de/', 'authors': [], 'editors': [], 'languages': []}
    items.append(item)
    volume = {**item, 'schemaVersion': 1, 'type': 'Volume', 'metadata': {'title': label},
              'source': {'viewerUrl': 'https://cmg.bbaw.de/'}, 'defaultPn': 1,
              'pageCount': 8, 'firstOrder': 1, 'lastOrder': 8, 'pages': pages,
              'orderToCanvasIndex': {str(p['order']): p['index'] for p in pages},
              'structures': {'id': 'root', 'label': 'Contents', 'orders': [], 'items': [
                  {'id': 'title', 'label': 'Title pages', 'orders': [1, 2], 'items': []},
                  {'id': 'text', 'label': 'Text', 'orders': list(range(3, 9)), 'items': []}]}}
    save(ROOT / f'data/volumes/{volume_id}.json', volume)
    save(ROOT / f'iiif/{volume_id}/manifest.json', {'@context': 'http://iiif.io/api/presentation/3/context.json',
         'id': manifest_url, 'type': 'Manifest', 'label': {'none': [label]}, 'behavior': ['paged'],
         'viewingDirection': 'left-to-right', 'items': canvases,
         'metadata': [{'label': {'en': ['Fixture']}, 'value': {'en': ['Synthetic test data']}}]})
save(ROOT / 'data/catalogue.json', {'schemaVersion': 1, 'itemCount': 3, 'volumeCount': 3, 'items': items})
build_site(DEFAULT_SOURCE, ROOT.resolve(), DEFAULT_TIFY)
(ROOT / 'fixture-page.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><text x="50" y="100" font-size="32">Synthetic test page</text></svg>')
