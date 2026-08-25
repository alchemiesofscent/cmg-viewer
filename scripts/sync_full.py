#!/usr/bin/env python3
"""Synchronize the reviewed CMG catalogue into the static viewer artifact.

The catalogue crawler owns work-level discovery.  This orchestrator resolves
each distinct physical viewer to either its reviewed METS record or the
legacy-HTML fallback adapter, then writes one normalized volume and IIIF
Presentation 3 manifest per viewer plus all searchable work-level entries.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
from pathlib import Path
import re
import sys
from typing import Any
import urllib.parse

if __package__:
    from . import catalogue, fallback, metadata as metadata_enrichment, sync
else:
    import catalogue
    import fallback
    import metadata as metadata_enrichment
    import sync


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOGUE_CONFIG = PROJECT_ROOT / "config" / "catalogue-sources.json"
DEFAULT_METS_CONFIG = PROJECT_ROOT / "config" / "mets-overrides.json"
DEFAULT_CACHE = PROJECT_ROOT / "data" / "source"
DEFAULT_DIST = PROJECT_ROOT / "dist"
DEFAULT_BASE_URL = "https://alchemiesofscent.github.io/cmg-viewer"


class FullSyncError(RuntimeError):
    """A catalogue-wide mapping or publication error."""


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FullSyncError(f"Cannot read JSON configuration {path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise FullSyncError(f"Unsupported or invalid configuration: {path}")
    return value


def unique_strings(values: list[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = sync.compact_space(str(value)) if value is not None else ""
        folded = text.casefold()
        if text and folded not in seen:
            seen.add(folded)
            result.append(text)
    return result


def series_number_for_works(works: list[dict[str, Any]]) -> str:
    enriched = metadata_enrichment.enrich_works(works)
    candidates = unique_strings(
        [work.get("seriesNumber", "") for work in enriched]
    )
    return candidates[0] if len(candidates) == 1 else ""


def build_plans(
    census: dict[str, Any], mets_config: dict[str, Any]
) -> list[dict[str, Any]]:
    volumes = census["volumes"]
    volume_ids_in_order = [item["volumeId"] for item in volumes]
    if len(volume_ids_in_order) != len(set(volume_ids_in_order)):
        raise FullSyncError("Catalogue census contains duplicate physical volume IDs")
    volume_by_id = {item["volumeId"]: item for item in volumes}
    works_by_volume: dict[str, list[dict[str, Any]]] = {}
    for work in metadata_enrichment.enrich_works(census["works"]):
        works_by_volume.setdefault(work["volumeId"], []).append(work)

    override_records = mets_config.get("overrides", [])
    fallback_records = mets_config.get("fallbacks", [])
    override_ids = [item["viewerId"] for item in override_records]
    fallback_ids = [item["viewerId"] for item in fallback_records]
    if len(override_ids) != len(set(override_ids)):
        raise FullSyncError("METS configuration contains duplicate override viewer IDs")
    if len(fallback_ids) != len(set(fallback_ids)):
        raise FullSyncError("METS configuration contains duplicate fallback viewer IDs")
    overrides = {item["viewerId"]: item for item in override_records}
    fallbacks = {item["viewerId"]: item for item in fallback_records}
    volume_ids = set(volume_ids_in_order)
    orphan_work_volumes = set(works_by_volume) - volume_ids
    if orphan_work_volumes:
        raise FullSyncError(
            "Work records name physical viewers absent from the census: "
            + ", ".join(sorted(orphan_work_volumes))
        )
    unknown = (set(overrides) | set(fallbacks)) - volume_ids
    if unknown:
        raise FullSyncError(
            "METS configuration names viewer IDs absent from the live census: "
            + ", ".join(sorted(unknown))
        )
    overlap = set(overrides) & set(fallbacks)
    if overlap:
        raise FullSyncError(
            "Viewer IDs cannot be both METS overrides and fallbacks: "
            + ", ".join(sorted(overlap))
        )
    for viewer_id, reviewed in {**overrides, **fallbacks}.items():
        live_path = volume_by_id[viewer_id]["viewerPath"]
        if reviewed.get("viewerPath") != live_path:
            raise FullSyncError(
                f"Reviewed viewer path mismatch for {viewer_id}: "
                f"expected {reviewed.get('viewerPath')!r}, received {live_path!r}"
            )

    default_pattern = mets_config.get("defaultPattern")
    if default_pattern != "mets/{viewerStem}.xml":
        raise FullSyncError(f"Unsupported METS defaultPattern: {default_pattern!r}")

    plans: list[dict[str, Any]] = []
    for volume in volumes:
        volume_id = volume["volumeId"]
        works = works_by_volume.get(volume_id, [])
        if not works:
            raise FullSyncError(f"Physical viewer has no work records: {volume_id}")
        work_ids = [work["id"] for work in works]
        if volume.get("workItemIds") != work_ids or volume.get("workCount") != len(works):
            raise FullSyncError(
                f"Catalogue work-to-volume mapping drifted for {volume_id}"
            )
        seed = {
            "id": volume_id,
            "viewerPath": volume["viewerPath"],
            "collection": volume.get("collection", ""),
            "seriesNumber": series_number_for_works(works),
        }
        if volume_id in fallbacks:
            plans.append(
                {
                    "kind": "fallback",
                    "seed": seed,
                    "fallback": fallbacks[volume_id],
                    "works": works,
                }
            )
            continue
        override = overrides.get(volume_id)
        seed["metsPath"] = (
            override["metsPath"] if override else default_pattern.format(viewerStem=volume_id)
        )
        plans.append(
            {
                "kind": "mets-override" if override else "mets-predictable",
                "seed": seed,
                "works": works,
            }
        )

    expected = mets_config.get("expectedCounts", {})
    actual = {
        "physicalViewerEndpoints": len(plans),
        "predictableMets": sum(plan["kind"] == "mets-predictable" for plan in plans),
        "overrideMets": sum(plan["kind"] == "mets-override" for plan in plans),
        "reliableMets": sum(plan["kind"].startswith("mets-") for plan in plans),
        "fallbackViewers": sum(plan["kind"] == "fallback" for plan in plans),
    }
    mismatches = [
        f"{name}: expected {expected.get(name)}, received {value}"
        for name, value in actual.items()
        if expected.get(name) != value
    ]
    if mismatches:
        raise FullSyncError("Reviewed METS/fallback census drifted: " + "; ".join(mismatches))
    return plans


def sync_fallback_volume(
    plan: dict[str, Any],
    *,
    base_url: str,
    cache_dir: Path,
    offline: bool,
    refresh: bool,
    workers: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    seed = dict(plan["seed"])
    inputs = fallback.build_fallback_inputs(
        plan["fallback"],
        cache_dir=cache_dir,
        offline=offline,
        refresh=refresh,
        workers=workers,
    )
    viewer_url = inputs["source"]["viewerUrl"]
    seed["samplePn"] = inputs["live"]["firstOrder"]
    manifest = sync.build_manifest(
        seed,
        inputs["title"],
        inputs["metadata"],
        inputs["pages"],
        inputs["logicalRoot"],
        base_url,
        viewer_url,
        None,
    )
    volume = sync.build_volume_record(
        seed,
        inputs["title"],
        inputs["metadata"],
        inputs["pages"],
        inputs["logicalRoot"],
        base_url,
        viewer_url,
        None,
    )
    volume["source"].update(
        {
            key: value
            for key, value in inputs["source"].items()
            if value is not None and key != "metsUrl"
        }
    )
    # The three reviewed fallback page-count overrides intentionally supersede
    # stale legacy `ende_real` values.  The fallback adapter has already
    # validated its selected sequence and every IIIF service; the common
    # validator still checks IDs, deep links, ranges and canvas cardinality.
    safe_live = {
        "firstOrder": inputs["live"]["firstOrder"],
        "lastPhysicalOrder": None,
    }
    sync.validate_output(seed, safe_live, volume, manifest)
    return volume, manifest


def synchronize_plan(
    plan: dict[str, Any],
    *,
    base_url: str,
    cache_dir: Path,
    offline: bool,
    refresh: bool,
    workers: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if plan["kind"] == "fallback":
        return sync_fallback_volume(
            plan,
            base_url=base_url,
            cache_dir=cache_dir,
            offline=offline,
            refresh=refresh,
            workers=workers,
        )
    return sync.sync_volume(
        plan["seed"],
        base_url=base_url,
        cache_dir=cache_dir,
        offline=offline,
        refresh=refresh,
        workers=workers,
    )


def work_label(work: dict[str, Any]) -> str:
    label = sync.compact_space(work.get("label", ""))
    context = sync.compact_space(work.get("rawContext", ""))
    if len(label) < 12 and len(context) > len(label):
        return context
    return label or context or work["volumeId"]


def work_catalogue_item(
    work: dict[str, Any], volume: dict[str, Any]
) -> dict[str, Any]:
    if not work.get("_metadataEnriched"):
        work = metadata_enrichment.enrich_works([work])[0]
    requested = work.get("startPn")
    start_pn = volume["firstOrder"] if requested is None else requested
    if str(start_pn) not in volume["orderToCanvasIndex"]:
        raise FullSyncError(
            f"Work deep link {work['id']} requests missing pn={start_pn} in {volume['id']}"
        )
    hints = work.get("hints", {})
    language_hints = [
        item
        for item in hints.get("languagesMentioned", [])
        if isinstance(item, dict) and item.get("label")
    ]
    metadata = volume.get("metadata", {})
    languages = unique_strings(
        [*work.get("languages", []), *metadata.get("languages", [])]
    )
    translation_languages = unique_strings(work.get("translationLanguages", []))
    years = unique_strings(work.get("years", []))
    year = sync.compact_space(work.get("year", ""))
    series_numbers = unique_strings(work.get("seriesNumbers", []))
    series_number = sync.compact_space(work.get("seriesNumber", ""))
    contributors = unique_strings(metadata.get("contributors", []))
    authors = unique_strings(work.get("authors", []))
    editors = unique_strings(work.get("editors", []))
    edition_year = metadata_enrichment.normalize_edition_year(
        metadata.get("dateIssued", "")
    )
    field_provenance = {
        field: [dict(record) for record in records]
        for field, records in work.get("metadataProvenance", {}).items()
        if records
    }
    if edition_year:
        edition_source = (
            "mets-date-issued"
            if volume.get("source", {}).get("metsUrl")
            else "volume-metadata-date-issued"
        )
        field_provenance["editionYear"] = [
            metadata_enrichment.provenance(
                edition_year,
                source=edition_source,
                evidence=edition_year,
                evidence_field="volume.metadata.dateIssued",
            )
        ]
    search_terms = unique_strings(
        [
            *work.get("rawLabels", []),
            *work.get("rawContexts", []),
            *work.get("sourceLabels", []),
            *work.get("sourceCollections", []),
            *[
                value
                for item in language_hints
                for value in (item.get("label"), item.get("code"), item.get("matchedText"))
            ],
        ]
    )
    label = work_label(work)
    return {
        "id": work["id"],
        "volumeId": volume["id"],
        "label": label,
        "work": label,
        "collection": work.get("collection") or volume.get("collection", ""),
        "seriesNumber": series_number,
        "seriesNumbers": series_numbers,
        "authors": authors,
        "editors": editors,
        "contributors": contributors,
        "years": years,
        "year": year,
        "editionYear": edition_year,
        "languages": languages,
        "translationLanguages": translation_languages,
        "languageHints": language_hints,
        "metadataProvenance": field_provenance,
        "searchTerms": search_terms,
        "startPn": start_pn,
        "viewerUrl": volume["viewerUrl"],
        "viewerDeepLink": f"{volume['viewerUrl']}?pn={start_pn}",
        "manifestUrl": volume["manifestUrl"],
        "sourceUrl": work.get("upstreamWorkUrl") or volume["source"]["viewerUrl"],
        "sourceViewerUrl": volume["source"]["viewerUrl"],
        "sourceIds": work.get("sourceIds", []),
        "sourceCollections": work.get("sourceCollections", []),
    }


def write_outputs(
    *,
    census: dict[str, Any],
    plans: list[dict[str, Any]],
    results: dict[str, tuple[dict[str, Any], dict[str, Any]]],
    dist_dir: Path,
    base_url: str,
    generated_at: str,
    mode: str,
    scope: str,
) -> None:
    if scope not in {"full", "partial"}:
        raise FullSyncError(f"Unsupported synchronization report scope: {scope!r}")
    plan_ids = [plan["seed"]["id"] for plan in plans]
    if len(plan_ids) != len(set(plan_ids)):
        raise FullSyncError("Synchronization plans contain duplicate volume IDs")
    missing_results = set(plan_ids) - set(results)
    orphan_results = set(results) - set(plan_ids)
    if missing_results or orphan_results:
        raise FullSyncError(
            "Synchronization result coverage mismatch: "
            f"missing={sorted(missing_results)}, orphaned={sorted(orphan_results)}"
        )
    work_volume_ids = {work["volumeId"] for work in census["works"]}
    missing_work_volumes = work_volume_ids - set(plan_ids)
    if missing_work_volumes:
        raise FullSyncError(
            "Work records have no synchronized volume result: "
            + ", ".join(sorted(missing_work_volumes))
        )

    ordered_volumes: list[dict[str, Any]] = []
    ordered_manifests: list[dict[str, Any]] = []
    plan_by_id = {plan["seed"]["id"]: plan for plan in plans}
    for plan in plans:
        volume_id = plan["seed"]["id"]
        volume, manifest = results[volume_id]
        if volume.get("id") != volume_id:
            raise FullSyncError(
                f"Synchronization result ID mismatch for plan {volume_id}: "
                f"received {volume.get('id')!r}"
            )
        ordered_volumes.append(volume)
        ordered_manifests.append(manifest)

    volume_by_id = {volume["id"]: volume for volume in ordered_volumes}
    enriched_works = metadata_enrichment.enrich_works(census["works"])
    items = [
        work_catalogue_item(work, volume_by_id[work["volumeId"]])
        for work in enriched_works
    ]
    if len(items) != len(census["works"]):
        raise FullSyncError("Not every work record produced a catalogue item")

    # Do not disturb the last locally generated records until the complete
    # work-to-page mapping has passed validation.
    sync.clear_generated_records(dist_dir)
    for volume, manifest in zip(ordered_volumes, ordered_manifests, strict=True):
        sync.write_json(
            dist_dir / "data" / "volumes" / f"{volume['id']}.json", volume
        )
        sync.write_json(dist_dir / "iiif" / volume["id"] / "manifest.json", manifest)
    catalogue_data = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "verifiedAgainst": census.get("verifiedAgainst", ""),
        "scope": scope,
        "itemCount": len(items),
        "volumeCount": len(ordered_volumes),
        "sources": census.get("sources", []),
        "items": items,
    }
    sync.write_json(dist_dir / "data" / "catalogue.json", catalogue_data)
    sync.write_json(
        dist_dir / "data" / "source-census.json",
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "verifiedAgainst": census.get("verifiedAgainst", ""),
            "scope": "full-upstream-census",
            "outputScope": scope,
            "selectedCatalogueItemCount": len(items),
            "selectedVolumeCount": len(ordered_volumes),
            "counts": census["counts"],
            "sources": census.get("sources", []),
        },
    )

    collection = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        "id": f"{base_url}/iiif/collection.json",
        "type": "Collection",
        "label": sync.language_map("CMG digital catalogue", "en"),
        "items": [
            {
                "id": volume["manifestUrl"],
                "type": "Manifest",
                "label": sync.language_map(volume["label"]),
                "thumbnail": [manifest["thumbnail"][0]],
            }
            for volume, manifest in zip(
                ordered_volumes, ordered_manifests, strict=True
            )
        ],
    }
    sync.write_json(dist_dir / "iiif" / "collection.json", collection)

    kind_counts = {
        kind: sum(plan["kind"] == kind for plan in plans)
        for kind in ("mets-predictable", "mets-override", "fallback")
    }
    upstream_warnings: list[dict[str, Any]] = []
    for volume in ordered_volumes:
        messages = list(volume.get("source", {}).get("metsWarnings", []))
        legacy_bounds = volume.get("source", {}).get("legacyBounds")
        if isinstance(legacy_bounds, dict) and not legacy_bounds.get(
            "matchesMetsPhysicalSequence", True
        ):
            messages.append(
                "Legacy last physical order "
                f"{legacy_bounds.get('lastPhysicalOrder')} differs from generated "
                f"last order {volume['lastOrder']}"
            )
        if messages:
            upstream_warnings.append({"id": volume["id"], "messages": messages})
    report = {
        "schemaVersion": 1,
        "status": "ok",
        "generatedAt": generated_at,
        "mode": mode,
        "scope": scope,
        "catalogueItemCount": len(items),
        "volumeCount": len(ordered_volumes),
        "pageCount": sum(volume["pageCount"] for volume in ordered_volumes),
        "sourceCountsScope": "full-upstream-census",
        "sourceCounts": census["counts"],
        "ingestCounts": kind_counts,
        "upstreamWarningCount": sum(
            len(item["messages"]) for item in upstream_warnings
        ),
        "upstreamWarnings": upstream_warnings,
        "volumes": [
            {
                "id": volume["id"],
                "ingest": plan_by_id[volume["id"]]["kind"],
                "pageCount": volume["pageCount"],
                "firstOrder": volume["firstOrder"],
                "lastOrder": volume["lastOrder"],
            }
            for volume in ordered_volumes
        ],
    }
    sync.write_json(dist_dir / "data" / "sync-report.json", report)


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue-config", type=Path, default=DEFAULT_CATALOGUE_CONFIG)
    parser.add_argument("--mets-config", type=Path, default=DEFAULT_METS_CONFIG)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--volume", action="append", dest="volumes")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--refresh", action="store_true")
    mode.add_argument("--offline", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--volume-workers", type=int, default=3)
    return parser.parse_args(argv)


def synchronization_scope(selected: set[str], known_ids: set[str]) -> str:
    """Classify output by actual coverage, not merely by CLI option presence."""

    return "full" if not selected or selected == known_ids else "partial"


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    if not 1 <= args.workers <= 32:
        raise FullSyncError("--workers must be between 1 and 32")
    if not 1 <= args.volume_workers <= 8:
        raise FullSyncError("--volume-workers must be between 1 and 8")
    base_url = args.base_url.rstrip("/")
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise FullSyncError(f"--base-url must be an absolute HTTPS URL: {base_url}")

    cache_dir = args.cache.resolve()
    dist_dir = args.dist.resolve()
    census = catalogue.crawl_catalogue(
        args.catalogue_config.resolve(),
        cache_dir=cache_dir,
        offline=args.offline,
        refresh=args.refresh,
    )
    plans = build_plans(census, read_json(args.mets_config.resolve()))
    selected = set(args.volumes or [])
    known_ids = {plan["seed"]["id"] for plan in plans}
    unknown = selected - known_ids
    if unknown:
        raise FullSyncError("Unknown --volume ID(s): " + ", ".join(sorted(unknown)))
    scope = synchronization_scope(selected, known_ids)
    if scope == "partial" and dist_dir == DEFAULT_DIST.resolve():
        raise FullSyncError(
            "A partial --volume synchronization requires an explicit --dist "
            "directory so it cannot replace the full local artifact"
        )
    if scope == "partial":
        plans = [plan for plan in plans if plan["seed"]["id"] in selected]
        census = {
            **census,
            "works": [work for work in census["works"] if work["volumeId"] in selected],
        }
    if not plans:
        raise FullSyncError("No physical viewers selected")

    mode = "offline" if args.offline else "refresh" if args.refresh else "cache-first"
    print(
        f"Synchronizing {len(plans)} physical viewers ({len(census['works'])} works, {mode})...",
        flush=True,
    )
    results: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.volume_workers
    ) as executor:
        futures = {
            executor.submit(
                synchronize_plan,
                plan,
                base_url=base_url,
                cache_dir=cache_dir,
                offline=args.offline,
                refresh=args.refresh,
                workers=args.workers,
            ): plan
            for plan in plans
        }
        for future in concurrent.futures.as_completed(futures):
            plan = futures[future]
            volume_id = plan["seed"]["id"]
            try:
                volume, manifest = future.result()
                results[volume_id] = (volume, manifest)
                print(
                    f"[{len(results):3d}/{len(plans)}] {volume_id}: "
                    f"{volume['pageCount']} pages ({plan['kind']})",
                    flush=True,
                )
            except BaseException as exc:
                errors.append(f"{volume_id}: {exc}")
                print(f"[failed] {volume_id}: {exc}", file=sys.stderr, flush=True)
    if errors:
        detail = "\n  - ".join(errors[:20])
        suffix = "" if len(errors) <= 20 else f"\n  - ...and {len(errors) - 20} more"
        raise FullSyncError(f"Full synchronization failed:\n  - {detail}{suffix}")

    generated_at = sync.utc_now()
    write_outputs(
        census=census,
        plans=plans,
        results=results,
        dist_dir=dist_dir,
        base_url=base_url,
        generated_at=generated_at,
        mode=mode,
        scope=scope,
    )
    page_count = sum(volume[0]["pageCount"] for volume in results.values())
    print(
        f"Wrote {len(plans)} volumes, {len(census['works'])} work entries, "
        f"and {page_count} canvases to {dist_dir}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        FullSyncError,
        catalogue.CatalogueError,
        fallback.FallbackError,
        sync.SyncError,
    ) as exc:
        print(f"full sync error: {exc}", file=sys.stderr)
        raise SystemExit(1)
