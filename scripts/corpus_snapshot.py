#!/usr/bin/env python3
"""Pack validated corpus metadata or restore a checksum-pinned release snapshot."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

REPOSITORY = 'alchemiesofscent/cmg-viewer'
MAX_BYTES = 512 * 1024 * 1024


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def valid_pin(pin):
    if pin.get('schemaVersion') != 1 or not re.fullmatch(r'corpus-[0-9]+-[0-9]+', pin.get('tag', '')):
        raise ValueError('Invalid corpus snapshot tag/schema')
    if not re.fullmatch(r'[a-f0-9]{64}', pin.get('sha256', '')):
        raise ValueError('Invalid snapshot checksum')
    return pin


def unpack(archive, dist, pin):
    valid_pin(pin)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != pin['sha256']:
        raise ValueError('Corpus snapshot checksum mismatch')
    # Validate every member before writing anything or replacing existing data.
    with tempfile.TemporaryDirectory() as temporary, tarfile.open(archive, 'r:gz') as tar:
        root = Path(temporary)
        members = tar.getmembers()
        if sum(m.size for m in members) > MAX_BYTES:
            raise ValueError('Corpus snapshot is too large')
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            if (not member.isfile() or path.is_absolute() or '..' in path.parts
                    or not path.parts or path.parts[0] not in ('data', 'iiif')
                    or path.suffix != '.json' or member.name in names):
                raise ValueError('Unsafe or duplicate snapshot member')
            names.add(member.name)
            content = tar.extractfile(member).read()
            json.loads(content)
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        if 'data/catalogue.json' not in names or 'data/sync-report.json' not in names or not (root / 'iiif').is_dir():
            raise ValueError('Incomplete corpus snapshot')
        dist.mkdir(parents=True, exist_ok=True)
        for name in ('data', 'iiif'):
            if (dist / name).exists():
                shutil.rmtree(dist / name)
            shutil.copytree(root / name, dist / name)
    write_json(dist / 'corpus-snapshot.json', pin)
    write_json(dist / 'build-info.json', {
        'uiRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'corpusSnapshot': pin,
    })


def download(tag, name, destination):
    if not re.fullmatch(r'corpus-[0-9]+-[0-9]+', tag):
        raise ValueError('Invalid corpus snapshot tag')
    url = f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'
    with urllib.request.urlopen(url, timeout=120) as response, destination.open('wb') as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_BYTES:
                raise ValueError('Snapshot download is too large')
            output.write(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['pack', 'restore'])
    parser.add_argument('--dist', type=Path, default=Path('dist'))
    parser.add_argument('--pin', type=Path, default=Path('config/corpus-snapshot.json'))
    parser.add_argument('--output', type=Path, default=Path('tmp/corpus-snapshot'))
    parser.add_argument('--tag')
    args = parser.parse_args()
    if args.command == 'pack':
        # A release snapshot must pass the same full validator as a deployment.
        subprocess.run(['node', 'scripts/python.mjs', 'scripts/validate.py', '--dist', str(args.dist)], check=True)
        args.output.mkdir(parents=True, exist_ok=True)
        archive = args.output / 'corpus.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name in ('data', 'iiif'):
                for file in sorted((args.dist / name).rglob('*.json')):
                    tar.add(file, arcname=file.relative_to(args.dist), recursive=False)
        report = json.loads((args.dist / 'data/sync-report.json').read_text())
        pin = valid_pin({'schemaVersion': 1, 'tag': args.tag,
                        'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                        'generatedAt': report['generatedAt'],
                        'volumeCount': report['volumeCount'], 'pageCount': report['pageCount']})
        write_json(args.output / 'snapshot.json', pin)
        write_json(args.pin, pin)
    else:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            if args.tag:
                download(args.tag, 'snapshot.json', root / 'snapshot.json')
                pin = valid_pin(json.loads((root / 'snapshot.json').read_text()))
                if pin['tag'] != args.tag:
                    raise ValueError('Snapshot manifest tag mismatch')
            else:
                pin = valid_pin(json.loads(args.pin.read_text()))
            download(pin['tag'], 'corpus.tar.gz', root / 'corpus.tar.gz')
            unpack(root / 'corpus.tar.gz', args.dist, pin)
            print(f"Restored validated corpus {pin['tag']}")


if __name__ == '__main__':
    main()
