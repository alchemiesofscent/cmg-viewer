#!/usr/bin/env python3
"""Assemble the static GitHub Pages artifact with reviewed metadata corrections applied to the saved corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import sys
from typing import Any

try:
    from .metadata_corrections import apply_corrections
except ImportError:
    from metadata_corrections import apply_corrections


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "src"
DEFAULT_DIST = PROJECT_ROOT / "dist"
DEFAULT_TIFY = PROJECT_ROOT / "node_modules" / "tify"
TIFY_VERSION = "0.35.0"
VIEWER_TOKEN = "__VOLUME_ID__"


class BuildError(RuntimeError):
    pass


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BuildError(f"Cannot read {path}: {exc}") from exc


def clear_owned_ui(dist: Path) -> None:
    """Remove only UI paths owned by this builder, preserving synced data."""

    for name in ("assets", "viewer"):
        path = dist / name
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    for name in ("index.html", "404.html", ".nojekyll"):
        path = dist / name
        if path.is_file() or path.is_symlink():
            path.unlink()


def copy_source_tree(source: Path, dist: Path) -> None:
    if not source.is_dir():
        raise BuildError(f"Source directory is missing: {source}")
    dist.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        if item.name == "templates":
            continue
        target = dist / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)


def configured_volume_ids(dist: Path) -> list[str]:
    catalogue_path = dist / "data" / "catalogue.json"
    catalogue = read_json(catalogue_path)
    values: list[str] = []
    for item in catalogue.get("items", []):
        volume_id = item.get("volumeId")
        if isinstance(volume_id, str) and volume_id:
            values.append(volume_id)
    ids = list(dict.fromkeys(values))
    if not ids:
        raise BuildError(f"No volume IDs found in {catalogue_path}; run the sync first")
    missing = [
        volume_id
        for volume_id in ids
        if not (dist / "data" / "volumes" / f"{volume_id}.json").is_file()
        or not (dist / "iiif" / volume_id / "manifest.json").is_file()
    ]
    if missing:
        raise BuildError(f"Generated volume data is incomplete: {', '.join(missing)}")
    return ids


def render_viewer_routes(source: Path, dist: Path, volume_ids: list[str]) -> None:
    template_path = source / "templates" / "viewer.html"
    try:
        template = template_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise BuildError(f"Cannot read viewer template {template_path}: {exc}") from exc
    if template.count(VIEWER_TOKEN) != 1:
        raise BuildError(
            f"Viewer template must contain exactly one {VIEWER_TOKEN} token"
        )
    for volume_id in volume_ids:
        if any(character in volume_id for character in ("/", "\\", "..")):
            raise BuildError(f"Unsafe stable volume ID: {volume_id!r}")
        route = dist / "viewer" / volume_id / "index.html"
        route.parent.mkdir(parents=True, exist_ok=True)
        route.write_text(template.replace(VIEWER_TOKEN, volume_id), encoding="utf-8")


def vendor_tify(package_dir: Path, dist: Path) -> None:
    package_json = read_json(package_dir / "package.json")
    version = package_json.get("version")
    if version != TIFY_VERSION:
        raise BuildError(
            f"Expected TIFY {TIFY_VERSION}, found {version or 'an unknown version'}"
        )
    target = dist / "assets" / "vendor" / "tify"
    target.mkdir(parents=True, exist_ok=True)
    required = {
        package_dir / "dist" / "tify.js": target / "tify.js",
        package_dir / "dist" / "tify.css": target / "tify.css",
        package_dir / "LICENSE": target / "LICENSE",
    }
    for source, destination in required.items():
        if not source.is_file():
            raise BuildError(f"TIFY distribution file is missing: {source}")
        shutil.copy2(source, destination)
    translations = package_dir / "dist" / "translations"
    if translations.is_dir():
        shutil.copytree(translations, target / "translations", dirs_exist_ok=True)


def write_pages_support(dist: Path, base_path: str) -> None:
    normalized_base = "/" + base_path.strip("/") + "/"
    (dist / ".nojekyll").write_text("", encoding="utf-8")
    not_found = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Page not found · CMG Viewer</title>
  <link rel="stylesheet" href="{normalized_base}assets/base.css">
</head>
<body>
  <main style="max-width: 42rem; margin: 12vh auto; padding: 2rem;">
    <p>CMG Viewer</p>
    <h1>Page not found</h1>
    <p>The requested catalogue entry or scan route does not exist.</p>
    <p><a href="{normalized_base}">Return to the catalogue</a></p>
  </main>
</body>
</html>
"""
    (dist / "404.html").write_text(not_found, encoding="utf-8")


def build_site(
    source: Path,
    dist: Path,
    tify_package: Path,
    *,
    base_path: str = "/cmg-viewer/",
) -> list[str]:
    clear_owned_ui(dist)
    copy_source_tree(source, dist)
    apply_corrections(dist)
    volume_ids = configured_volume_ids(dist)
    render_viewer_routes(source, dist, volume_ids)
    vendor_tify(tify_package, dist)
    write_pages_support(dist, base_path)
    version_ui_assets(dist)
    return volume_ids


def version_ui_assets(dist: Path) -> None:
    """Give HTML and local module imports one content-derived cache version."""
    assets = sorted(path for path in (dist / "assets").glob("*")
                    if path.suffix in (".js", ".css"))
    digest = hashlib.sha256()
    for path in assets:
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    version = digest.hexdigest()[:16]
    # Include imported helper modules: versioning only viewer.js leaves its
    # dependencies eligible for reuse from an earlier deployment.
    for path in assets:
        if path.suffix == ".js":
            text = path.read_text(encoding="utf-8")
            text = re.sub(r"(['\"])(\./[^'\"]+\.js)\1",
                          lambda m: f"{m[1]}{m[2]}?v={version}{m[1]}", text)
            path.write_text(text, encoding="utf-8")
    for path in dist.rglob("*.html"):
        text = path.read_text(encoding="utf-8")
        text = re.sub(r'((?:src|href)=["\'])([^"\']*assets/[^"\'?]+\.(?:css|js))(["\'])',
                      lambda m: f"{m[1]}{m[2]}?v={version}{m[3]}", text)
        path.write_text(text, encoding="utf-8")


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument("--tify-package", type=Path, default=DEFAULT_TIFY)
    parser.add_argument("--base-path", default="/cmg-viewer/")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    volume_ids = build_site(
        args.source.resolve(),
        args.dist.resolve(),
        args.tify_package.resolve(),
        base_path=args.base_path,
    )
    print(
        f"Built static UI and {len(volume_ids)} viewer routes in {args.dist.resolve()}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as exc:
        print(f"build error: {exc}", file=sys.stderr)
        raise SystemExit(1)
