#!/usr/bin/env python3
"""Record a compact marker for the last successful full catalogue sync."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = PROJECT_ROOT / "dist" / "data" / "sync-report.json"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "last-successful-sync.json"
INGEST_KEYS = ("mets-predictable", "mets-override", "fallback")


class MarkerError(RuntimeError):
    """The generated sync report cannot produce a trustworthy marker."""


def read_report(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MarkerError(f"Cannot read synchronization report {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise MarkerError(f"Synchronization report is not an object: {path}")
    return value


def marker_from_report(report: dict[str, Any]) -> dict[str, Any]:
    if report.get("status") != "ok" or report.get("scope") != "full":
        raise MarkerError("Only a successful full-catalogue report can update the marker")
    generated_at = report.get("generatedAt")
    if not isinstance(generated_at, str) or not generated_at:
        raise MarkerError("Synchronization report has no generatedAt timestamp")

    counts: dict[str, int] = {}
    for field in ("catalogueItemCount", "volumeCount", "pageCount"):
        value = report.get(field)
        if not isinstance(value, int) or value <= 0:
            raise MarkerError(f"Synchronization report has invalid {field}: {value!r}")
        counts[field] = value

    ingest = report.get("ingestCounts")
    if not isinstance(ingest, dict):
        raise MarkerError("Synchronization report has no ingestCounts object")
    ingest_counts: dict[str, int] = {}
    for field in INGEST_KEYS:
        value = ingest.get(field)
        if not isinstance(value, int) or value < 0:
            raise MarkerError(f"Synchronization report has invalid ingestCounts.{field}")
        ingest_counts[field] = value
    if sum(ingest_counts.values()) != counts["volumeCount"]:
        raise MarkerError("Ingest counts do not cover every synchronized volume")

    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        **counts,
        "ingestCounts": ingest_counts,
    }


def write_marker(path: Path, marker: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    marker = marker_from_report(read_report(args.report.resolve()))
    write_marker(args.output.resolve(), marker)
    print(f"Recorded successful full sync from {marker['generatedAt']} in {args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MarkerError as exc:
        print(f"sync marker error: {exc}", file=sys.stderr)
        raise SystemExit(1)
