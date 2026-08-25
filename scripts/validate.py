#!/usr/bin/env python3
"""Validate a built CMG Viewer artifact before local use or deployment."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable
import urllib.parse


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = PROJECT_ROOT / "dist"
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "sample-volumes.json"
DEFAULT_CATALOGUE_CONFIG = PROJECT_ROOT / "config" / "catalogue-sources.json"
DEFAULT_METS_CONFIG = PROJECT_ROOT / "config" / "mets-overrides.json"
DEFAULT_BASE_URL = "https://alchemiesofscent.github.io/cmg-viewer"
DEFAULT_MAX_BYTES = 250 * 1024 * 1024


class ValidationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"Cannot read JSON {path}: {exc}") from exc


def validate_expected_counts(
    actual: dict[str, Any], expected: dict[str, Any], *, label: str
) -> None:
    """Require every reviewed census value while allowing additive fields."""

    for field, expected_value in expected.items():
        actual_value = actual.get(field)
        if isinstance(expected_value, dict):
            require(
                isinstance(actual_value, dict),
                f"{label}.{field} must be an object",
            )
            validate_expected_counts(
                actual_value, expected_value, label=f"{label}.{field}"
            )
        else:
            require(
                actual_value == expected_value,
                f"{label}.{field} expected {expected_value!r}, found {actual_value!r}",
            )


def validate_catalogue_metadata(record: dict[str, Any]) -> None:
    """Ensure assigned bibliographic roles and dates retain their evidence."""

    record_id = record.get("id", "<unknown>")
    field_provenance = record.get("metadataProvenance")
    require(
        isinstance(field_provenance, dict),
        f"Catalogue metadata provenance is missing: {record_id}",
    )

    for field in (
        "languages",
        "authors",
        "editors",
        "translationLanguages",
        "seriesNumbers",
        "years",
    ):
        values = record.get(field)
        require(isinstance(values, list), f"Catalogue {field} is not a list: {record_id}")
        evidence = field_provenance.get(field, [])
        require(
            isinstance(evidence, list),
            f"Catalogue {field} provenance is not a list: {record_id}",
        )
        evidenced_values = {
            item.get("value") for item in evidence if isinstance(item, dict)
        }
        require(
            set(values) <= evidenced_values,
            f"Catalogue {field} contains an unsupported assignment: {record_id}",
        )

    for evidence in field_provenance.get("languages", []):
        require(
            isinstance(evidence, dict),
            f"Catalogue language evidence is not an object: {record_id}",
        )
        if evidence.get("source") != "reviewed-source-language-default":
            continue
        require(
            bool(evidence.get("evidence")),
            f"Reviewed language evidence is empty: {record_id}",
        )
        require(
            str(evidence.get("evidenceField", "")).startswith(
                "config.languageDefaults."
            ),
            f"Reviewed language rule path is invalid: {record_id}",
        )
        require(
            evidence.get("rule")
            in {
                "bySourceId-default",
                "byCollection-default",
                "byVolumeId-default",
                "byWorkId-default",
            },
            f"Reviewed language rule scope is invalid: {record_id}",
        )
        validate_url(evidence.get("evidenceUrl", ""), host="cmg.bbaw.de")

    for field in ("seriesNumber", "year", "editionYear"):
        value = record.get(field, "")
        require(isinstance(value, str), f"Catalogue {field} is not text: {record_id}")
        if not value:
            continue
        evidence = field_provenance.get(field, [])
        require(
            isinstance(evidence, list)
            and any(
                isinstance(item, dict) and item.get("value") == value
                for item in evidence
            ),
            f"Catalogue {field} contains an unsupported assignment: {record_id}",
        )

    years = record["years"]
    year = record.get("year", "")
    require(
        (len(years) == 1 and year == years[0])
        or (len(years) != 1 and not year),
        f"Catalogue singular year is ambiguous or inconsistent: {record_id}",
    )


def all_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from all_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from all_strings(item)


def walk_normalized_ranges(node: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield node
    for child in node.get("items", []):
        yield from walk_normalized_ranges(child)


def walk_manifest_ranges(node: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield node
    for child in node.get("items", []):
        if child.get("type") == "Range":
            yield from walk_manifest_ranges(child)


def validate_url(url: str, *, host: str | None = None) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https", f"URL is not HTTPS: {url}")
    require(bool(parsed.netloc), f"URL is not absolute: {url}")
    if host is not None:
        require(parsed.hostname == host, f"URL host must be {host}: {url}")
    return parsed


def validate_volume(
    dist: Path,
    volume_id: str,
    catalogue_record: dict[str, Any],
    base_url: str,
) -> tuple[int, set[str]]:
    volume_path = dist / "data" / "volumes" / f"{volume_id}.json"
    manifest_path = dist / "iiif" / volume_id / "manifest.json"
    route_path = dist / "viewer" / volume_id / "index.html"
    require(volume_path.is_file(), f"Missing normalized volume: {volume_path}")
    require(manifest_path.is_file(), f"Missing IIIF manifest: {manifest_path}")
    require(route_path.is_file(), f"Missing static viewer route: {route_path}")
    route_text = route_path.read_text(encoding="utf-8")
    require("__VOLUME_ID__" not in route_text, f"Unrendered viewer token: {route_path}")
    require(
        f'data-volume-id="{volume_id}"' in route_text,
        f"Viewer route does not identify {volume_id}: {route_path}",
    )
    require(
        'id="thumbnail-strip"' in route_text
        and 'id="thumbnail-list"' in route_text,
        f"Viewer route has no thumbnail rail: {route_path}",
    )
    require(
        'aria-label="Page thumbnails"' in route_text
        and 'thumbnail-summary' not in route_text
        and '<strong>Scans</strong>' not in route_text,
        f"Viewer thumbnail rail is not page-first: {route_path}",
    )
    require(
        'id="info-toggle"' in route_text
        and 'id="export-toggle"' in route_text,
        f"Viewer route has no unified Info/Export controls: {route_path}",
    )

    volume = read_json(volume_path)
    manifest = read_json(manifest_path)
    require(volume.get("id") == volume_id, f"Volume ID mismatch in {volume_path}")
    require(manifest.get("type") == "Manifest", f"Not a IIIF Manifest: {manifest_path}")
    expected_manifest_url = f"{base_url}/iiif/{volume_id}/manifest.json"
    require(manifest.get("id") == expected_manifest_url, f"Manifest ID mismatch: {volume_id}")
    require(volume.get("manifestUrl") == expected_manifest_url, f"Volume manifest URL mismatch: {volume_id}")
    require(
        catalogue_record.get("manifestUrl") == expected_manifest_url,
        f"Catalogue manifest URL mismatch: {volume_id}",
    )
    expected_viewer_url = f"{base_url}/viewer/{volume_id}/"
    require(volume.get("viewerUrl") == expected_viewer_url, f"Volume viewer URL mismatch: {volume_id}")
    require(
        catalogue_record.get("viewerUrl") == expected_viewer_url,
        f"Catalogue viewer URL mismatch: {volume_id}",
    )

    pages = volume.get("pages")
    require(isinstance(pages, list) and pages, f"Volume has no pages: {volume_id}")
    require(volume.get("pageCount") == len(pages), f"pageCount mismatch: {volume_id}")
    orders = [page.get("order") for page in pages]
    require(all(isinstance(order, int) for order in orders), f"Non-integer ORDER: {volume_id}")
    require(orders == sorted(set(orders)), f"ORDER values are duplicate or unsorted: {volume_id}")
    require(volume.get("firstOrder") == orders[0], f"firstOrder mismatch: {volume_id}")
    require(volume.get("lastOrder") == orders[-1], f"lastOrder mismatch: {volume_id}")
    expected_map = {str(order): index for index, order in enumerate(orders)}
    require(
        volume.get("orderToCanvasIndex") == expected_map,
        f"ORDER-to-canvas map is not bijective: {volume_id}",
    )
    start_pn = catalogue_record.get("startPn")
    require(str(start_pn) in expected_map, f"Catalogue startPn is absent: {volume_id} pn={start_pn}")

    manifest_items = manifest.get("items")
    require(
        isinstance(manifest_items, list) and len(manifest_items) == len(pages),
        f"Manifest canvas count mismatch: {volume_id}",
    )
    canvas_ids: set[str] = set()
    for index, (page, canvas) in enumerate(zip(pages, manifest_items, strict=True)):
        order = orders[index]
        expected_canvas = f"{base_url}/iiif/{volume_id}/canvas/p{order}"
        require(page.get("index") == index, f"Page index mismatch: {volume_id} ORDER {order}")
        require(page.get("canvasId") == expected_canvas, f"Page canvas ID mismatch: {volume_id} ORDER {order}")
        require(canvas.get("id") == expected_canvas, f"Manifest canvas ID mismatch: {volume_id} ORDER {order}")
        require(canvas.get("type") == "Canvas", f"Invalid canvas type: {volume_id} ORDER {order}")
        require(
            canvas.get("width") == page.get("width")
            and canvas.get("height") == page.get("height")
            and isinstance(page.get("width"), int)
            and isinstance(page.get("height"), int),
            f"Canvas dimensions mismatch: {volume_id} ORDER {order}",
        )
        service = page.get("imageServiceId", "")
        validate_url(service, host="digilib.bbaw.de")
        require("/digilib/Scaler/IIIF/" in service, f"Unexpected IIIF path: {service}")
        validate_url(page.get("imageUrl", ""), host="digilib.bbaw.de")
        thumbnail = page.get("thumbnailUrl", "")
        validate_url(thumbnail, host="digilib.bbaw.de")
        require(
            thumbnail == f"{service}/full/200,/0/default.jpg",
            f"Page thumbnail does not match its IIIF service: {volume_id} ORDER {order}",
        )
        validate_url(page.get("sourcePageUrl", ""), host="cmg.bbaw.de")
        parsed_source = urllib.parse.urlsplit(page["sourcePageUrl"])
        query = urllib.parse.parse_qs(parsed_source.query)
        require(query.get("pn") == [str(order)], f"CMG backlink pn mismatch: {volume_id} ORDER {order}")
        body = canvas.get("items", [{}])[0].get("items", [{}])[0].get("body", {})
        body_services = body.get("service", [])
        require(
            body_services
            and body_services[0].get("id") == service
            and body_services[0].get("type") == "ImageService2"
            and body_services[0].get("profile") == "level2",
            f"Canvas IIIF Image API service mismatch: {volume_id} ORDER {order}",
        )
        canvas_ids.add(expected_canvas)

    structures = volume.get("structures")
    require(isinstance(structures, dict), f"Normalized contents are missing: {volume_id}")
    range_ids: set[str] = set()
    valid_orders = set(orders)
    for node in walk_normalized_ranges(structures):
        node_id = node.get("id")
        require(isinstance(node_id, str) and node_id, f"Range ID missing: {volume_id}")
        require(node_id not in range_ids, f"Duplicate range ID {node_id}: {volume_id}")
        range_ids.add(node_id)
        invalid = set(node.get("orders", [])) - valid_orders
        require(not invalid, f"Range {node_id} references invalid ORDER values: {invalid}")
        provenance = set(node.get("provenance", []))
        require(provenance <= {"mets", "html"}, f"Invalid range provenance {provenance}: {volume_id}")

    manifest_ranges = manifest.get("structures")
    require(isinstance(manifest_ranges, list) and manifest_ranges, f"Manifest structures missing: {volume_id}")
    manifest_range_ids: set[str] = set()
    for root_range in manifest_ranges:
        for node in walk_manifest_ranges(root_range):
            node_id = node.get("id")
            require(node_id not in manifest_range_ids, f"Duplicate manifest range ID: {node_id}")
            manifest_range_ids.add(node_id)
            for child in node.get("items", []):
                if child.get("type") == "Canvas":
                    require(child.get("id") in canvas_ids, f"Range references unknown canvas: {child.get('id')}")
                else:
                    require(child.get("type") == "Range", f"Range has unsupported item type: {child}")

    for value in all_strings(volume):
        require("localhost" not in value and "blob:" not in value, f"Local-only URL in {volume_id}: {value}")
    for value in all_strings(manifest):
        require("localhost" not in value and "blob:" not in value, f"Local-only URL in manifest {volume_id}: {value}")
        if value.startswith("http://"):
            require(
                value.startswith("http://iiif.io/api/"),
                f"Insecure manifest URL in {volume_id}: {value}",
            )
    return len(pages), canvas_ids


def validate_sample_contracts(dist: Path, config_path: Path) -> None:
    if not config_path.is_file():
        return
    config = read_json(config_path)
    for seed in config.get("volumes", []):
        volume_path = dist / "data" / "volumes" / f"{seed['id']}.json"
        if not volume_path.is_file():
            continue
        volume = read_json(volume_path)
        expected = seed.get("expected", {})
        for field in ("pageCount", "firstOrder", "lastOrder"):
            if field in expected:
                require(
                    volume.get(field) == expected[field],
                    f"Sample contract failed for {seed['id']} {field}",
                )
        pn = str(seed["samplePn"])
        index = volume.get("orderToCanvasIndex", {}).get(pn)
        require(index is not None, f"Sample deep link is absent: {seed['id']} pn={pn}")
        if "sampleCanvasIndex" in expected:
            require(index == expected["sampleCanvasIndex"], f"Sample canvas index changed: {seed['id']} pn={pn}")
        if "sampleLabel" in expected:
            require(volume["pages"][index]["label"] == expected["sampleLabel"], f"Sample page label changed: {seed['id']} pn={pn}")


def validate_artifact(
    dist: Path,
    *,
    config_path: Path = DEFAULT_CONFIG,
    catalogue_config_path: Path = DEFAULT_CATALOGUE_CONFIG,
    mets_config_path: Path = DEFAULT_METS_CONFIG,
    base_url: str = DEFAULT_BASE_URL,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> dict[str, int]:
    base_url = base_url.rstrip("/")
    require(dist.is_dir(), f"Distribution directory is missing: {dist}")
    for path in (
        dist / "index.html",
        dist / "404.html",
        dist / ".nojekyll",
        dist / "data" / "catalogue.json",
        dist / "data" / "source-census.json",
        dist / "data" / "sync-report.json",
        dist / "iiif" / "collection.json",
        dist / "assets" / "viewer.js",
        dist / "assets" / "viewer.css",
        dist / "assets" / "vendor" / "tify" / "tify.js",
        dist / "assets" / "vendor" / "tify" / "tify.css",
        dist / "assets" / "vendor" / "tify" / "LICENSE",
    ):
        require(path.is_file(), f"Required artifact file is missing: {path}")

    catalogue_route_text = (dist / "index.html").read_text(encoding="utf-8")
    header_start = catalogue_route_text.find('<header class="site-header">')
    header_end = catalogue_route_text.find("</header>", header_start)
    search_position = catalogue_route_text.find('id="search-form"')
    require(
        header_start >= 0 and header_start < search_position < header_end,
        "Catalogue search is not in the site header",
    )
    require(
        'id="authors-menu-toggle"' in catalogue_route_text
        and 'id="authors-menu"' in catalogue_route_text,
        "Catalogue has no author browse menu",
    )
    require(
        "catalogue-hero" not in catalogue_route_text,
        "Obsolete catalogue hero is still present",
    )

    files = [path for path in dist.rglob("*") if path.is_file()]
    total_bytes = sum(path.stat().st_size for path in files)
    require(total_bytes <= max_bytes, f"Artifact is too large: {total_bytes} bytes (limit {max_bytes})")
    page_image_suffixes = {".jpg", ".jpeg", ".jp2", ".tif", ".tiff"}
    local_page_images = [path for path in files if path.suffix.casefold() in page_image_suffixes]
    if local_page_images:
        raise ValidationError(
            f"Page images must remain remote; found {local_page_images[0]}"
        )

    own_text_files = [
        path
        for path in files
        if path.suffix.casefold() in {".html", ".js", ".css", ".json"}
        and "vendor" not in path.parts
    ]
    forbidden = re.compile(r"__BASE__|__VOLUME_ID__|\bblob:|\blocalhost\b", re.I)
    for path in own_text_files:
        match = forbidden.search(path.read_text(encoding="utf-8"))
        require(not match, f"Unresolved/local-only marker {match.group(0)!r} in {path}" if match else "")

    catalogue = read_json(dist / "data" / "catalogue.json")
    source_census = read_json(dist / "data" / "source-census.json")
    report = read_json(dist / "data" / "sync-report.json")
    collection = read_json(dist / "iiif" / "collection.json")
    catalogue_config = read_json(catalogue_config_path)
    mets_config = read_json(mets_config_path)
    items = catalogue.get("items")
    require(isinstance(items, list) and items, "Catalogue has no records")
    item_ids = [item.get("id") for item in items]
    require(len(item_ids) == len(set(item_ids)), "Catalogue item IDs are not unique")
    volume_ids = [item.get("volumeId") for item in items]
    require(all(isinstance(item, str) and item for item in volume_ids), "Catalogue volume ID is missing")
    unique_volume_ids = list(dict.fromkeys(volume_ids))
    require(catalogue.get("itemCount") == len(items), "Catalogue itemCount mismatch")
    require(catalogue.get("volumeCount") == len(unique_volume_ids), "Catalogue volumeCount mismatch")
    require(catalogue.get("scope") == "full", "Catalogue output scope is not full")
    require(report.get("status") == "ok", "Sync report status is not ok")
    require(report.get("scope") == "full", "Sync report is not a full-catalogue synchronization")
    require(
        report.get("sourceCountsScope") == "full-upstream-census",
        "Sync report source-count scope is missing or ambiguous",
    )
    require(
        source_census.get("scope") == "full-upstream-census"
        and source_census.get("outputScope") == "full",
        "Source census scope is not a full production output",
    )
    require(
        report.get("catalogueItemCount") == len(items),
        "Sync report catalogueItemCount mismatch",
    )
    require(report.get("volumeCount") == len(unique_volume_ids), "Sync report volumeCount mismatch")
    expected_source_counts = catalogue_config.get("expectedCounts")
    require(
        isinstance(expected_source_counts, dict),
        "Catalogue configuration has no expectedCounts contract",
    )
    actual_source_counts = report.get("sourceCounts")
    require(isinstance(actual_source_counts, dict), "Sync report sourceCounts is missing")
    require(
        source_census.get("counts") == actual_source_counts,
        "Source census and sync report counts differ",
    )
    validate_expected_counts(
        actual_source_counts, expected_source_counts, label="sourceCounts"
    )
    require(
        len(items) == expected_source_counts.get("searchableWorkEntries"),
        "Built catalogue does not contain the reviewed work census",
    )
    require(
        len(unique_volume_ids) == expected_source_counts.get("physicalViewerEndpoints"),
        "Built catalogue does not contain the reviewed physical-viewer census",
    )
    expected_ingest = mets_config.get("expectedCounts")
    require(
        isinstance(expected_ingest, dict),
        "METS configuration has no expectedCounts contract",
    )
    actual_ingest = report.get("ingestCounts")
    require(isinstance(actual_ingest, dict), "Sync report ingestCounts is missing")
    ingest_contract = {
        "mets-predictable": expected_ingest.get("predictableMets"),
        "mets-override": expected_ingest.get("overrideMets"),
        "fallback": expected_ingest.get("fallbackViewers"),
    }
    validate_expected_counts(actual_ingest, ingest_contract, label="ingestCounts")
    require(
        actual_ingest.get("mets-predictable", 0)
        + actual_ingest.get("mets-override", 0)
        == expected_ingest.get("reliableMets"),
        "Built catalogue does not contain the reviewed reliable-METS census",
    )
    require(collection.get("type") == "Collection", "IIIF collection type is invalid")
    require(
        collection.get("id") == f"{base_url}/iiif/collection.json",
        "IIIF collection ID does not match the configured Pages URL",
    )
    require(len(collection.get("items", [])) == len(unique_volume_ids), "IIIF collection count mismatch")

    expected_volume_files = {f"{volume_id}.json" for volume_id in unique_volume_ids}
    actual_volume_files = {
        path.name for path in (dist / "data" / "volumes").glob("*.json") if path.is_file()
    }
    require(
        actual_volume_files == expected_volume_files,
        "Generated volume records contain missing or orphaned files",
    )
    actual_manifest_dirs = {
        path.name
        for path in (dist / "iiif").iterdir()
        if path.is_dir() and (path / "manifest.json").is_file()
    }
    require(
        actual_manifest_dirs == set(unique_volume_ids),
        "IIIF output contains missing or orphaned volume manifests",
    )
    actual_route_dirs = {
        path.name
        for path in (dist / "viewer").iterdir()
        if path.is_dir() and (path / "index.html").is_file()
    }
    require(
        actual_route_dirs == set(unique_volume_ids),
        "Viewer output contains missing or orphaned routes",
    )

    # Every work-level entry must carry its own valid deep link, not only the
    # first record encountered for a shared physical volume.
    volume_maps = {
        volume_id: read_json(dist / "data" / "volumes" / f"{volume_id}.json")[
            "orderToCanvasIndex"
        ]
        for volume_id in unique_volume_ids
    }
    for record in items:
        volume_id = record["volumeId"]
        validate_catalogue_metadata(record)
        require(
            bool(record.get("languages")),
            f"Catalogue source language is unreviewed: {record.get('id')}",
        )
        require(
            str(record.get("startPn")) in volume_maps[volume_id],
            f"Catalogue deep link is absent: {record.get('id')} pn={record.get('startPn')}",
        )
        require(
            record.get("viewerUrl") == f"{base_url}/viewer/{volume_id}/",
            f"Catalogue viewer URL mismatch: {record.get('id')}",
        )

    records_by_volume: dict[str, dict[str, Any]] = {}
    for record in items:
        records_by_volume.setdefault(record["volumeId"], record)
    total_pages = 0
    all_canvas_ids: set[str] = set()
    for volume_id in unique_volume_ids:
        page_count, canvas_ids = validate_volume(
            dist, volume_id, records_by_volume[volume_id], base_url
        )
        require(not (canvas_ids & all_canvas_ids), f"Canvas IDs collide across volumes: {volume_id}")
        all_canvas_ids.update(canvas_ids)
        total_pages += page_count
    require(report.get("pageCount") == total_pages, "Sync report pageCount mismatch")
    validate_sample_contracts(dist, config_path)
    return {
        "files": len(files),
        "bytes": total_bytes,
        "catalogueItems": len(items),
        "volumes": len(unique_volume_ids),
        "canvases": total_pages,
    }


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--catalogue-config", type=Path, default=DEFAULT_CATALOGUE_CONFIG
    )
    parser.add_argument("--mets-config", type=Path, default=DEFAULT_METS_CONFIG)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    result = validate_artifact(
        args.dist.resolve(),
        config_path=args.config.resolve(),
        catalogue_config_path=args.catalogue_config.resolve(),
        mets_config_path=args.mets_config.resolve(),
        base_url=args.base_url,
        max_bytes=args.max_bytes,
    )
    print(
        "Validated {volumes} volumes, {catalogueItems} catalogue records, "
        "{canvases} canvases, and {files} files ({bytes} bytes)".format(**result)
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValidationError as exc:
        print(f"validation error: {exc}", file=sys.stderr)
        raise SystemExit(1)
