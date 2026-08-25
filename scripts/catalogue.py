#!/usr/bin/env python3
"""Crawl and normalize the allowlisted BBAW CMG catalogue pages.

This module owns the boundary between the upstream HTML lists and the full
catalogue synchronizer.  It deliberately keeps work-level records separate
from physical-volume seeds: multiple query-sensitive links can point at the
same PHP viewer, while each physical viewer is synchronized only once.

Only the Python standard library is required.  Catalogue responses use the
same cache-first, ``--refresh``, and ``--offline`` semantics as ``sync.py``.
"""

from __future__ import annotations

import argparse
from collections import Counter
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from typing import Any, Iterable
import urllib.error
import urllib.parse
import urllib.request


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "catalogue-sources.json"
DEFAULT_CACHE = PROJECT_ROOT / "data" / "source"

USER_AGENT = (
    "cmg-viewer-sync/0.1 "
    "(+https://github.com/alchemiesofscent/cmg-viewer; static catalogue sync)"
)

COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
YEAR_RE = re.compile(r"(?<!\d)(?:1[5-9]\d{2}|20\d{2})(?!\d)")
SHORT_SERIES_RE = re.compile(
    r"^(?:(?:CMG|CML|SUPPL(?:EMENTUM)?(?:\s+OR(?:IENTALE)?)?)\s*)?"
    r"[IVXLCDM]+(?:\s*[0-9]+(?:[\s.,/-]+[0-9]+)*)?$",
    re.IGNORECASE,
)
NAMED_SERIES_RE = re.compile(
    r"\b(?:CMG|CML|Supplementum(?:\s+Orientale)?|Suppl\.?\s*Or\.?)"
    r"\s*[IVXLCDM0-9]+(?:[\s.,/-]+[IVXLCDM0-9]+)*",
    re.IGNORECASE,
)

# These are evidence terms, not assignments to original/translation roles.
# Role-bearing metadata is intentionally deferred to curated overrides or METS.
LANGUAGE_PATTERNS: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("grc", "Greek", re.compile(r"\b(?:Graec\w*|griech\w*|Greek)\b", re.I)),
    ("lat", "Latin", re.compile(r"\b(?:Latin\w*|latein\w*)\b", re.I)),
    ("ara", "Arabic", re.compile(r"\b(?:Arabic\w*|arabisch\w*)\b", re.I)),
    ("syc", "Syriac", re.compile(r"\b(?:Syriac\w*|syrisch\w*)\b", re.I)),
    ("heb", "Hebrew", re.compile(r"\b(?:Hebr\w*|hebrä\w*)\b", re.I)),
    ("deu", "German", re.compile(r"\b(?:Germanic\w*|deutsch\w*)\b", re.I)),
    ("eng", "English", re.compile(r"\b(?:Anglic\w*|englisch\w*|English)\b", re.I)),
    ("ita", "Italian", re.compile(r"\b(?:Italic\w*|italien\w*)\b", re.I)),
    ("fra", "French", re.compile(r"\b(?:Gallic\w*|französ\w*)\b", re.I)),
    ("hye", "Armenian", re.compile(r"\b(?:Armen\w*|armenisch\w*)\b", re.I)),
    ("fas", "Persian", re.compile(r"\b(?:Persic\w*|persisch\w*)\b", re.I)),
)


class CatalogueError(RuntimeError):
    """A configuration, upstream, or census error that must stop publication."""


def utc_now() -> str:
    """Return a deterministic-shape UTC timestamp for generated envelopes."""

    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def compact_space(value: str) -> str:
    """Decode character references and collapse HTML layout whitespace."""

    return " ".join(html.unescape(value).split())


def strip_html_comments(source: str) -> str:
    """Remove comments before link discovery, including stale viewer examples."""

    return COMMENT_RE.sub("", source)


def decode_html(payload: bytes) -> str:
    """Decode the mixture of UTF-8 and legacy BBAW HTML safely."""

    head = payload[:2048].decode("ascii", errors="ignore")
    match = re.search(r"charset\s*=\s*['\"]?([A-Za-z0-9._-]+)", head, re.I)
    encodings = [match.group(1)] if match else []
    encodings.extend(["utf-8-sig", "windows-1252"])
    for encoding in encodings:
        try:
            return payload.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return payload.decode("utf-8", errors="replace")


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Atomically replace a cache or generated JSON file."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def write_json(path: Path, value: Any) -> None:
    """Write UTF-8 JSON with a stable, reviewable representation."""

    payload = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    atomic_write_bytes(path, payload)


def fetch_cached_bytes(
    url: str,
    cache_path: Path,
    *,
    offline: bool,
    refresh: bool,
    allowed_hosts: Iterable[str],
    attempts: int = 3,
    timeout: float = 40.0,
) -> bytes:
    """Fetch one allowlisted URL using the synchronization cache contract."""

    if offline and refresh:
        raise CatalogueError("offline and refresh modes are mutually exclusive")
    parsed = urllib.parse.urlsplit(url)
    allowed = {item.casefold() for item in allowed_hosts}
    if parsed.scheme != "https" or (parsed.hostname or "").casefold() not in allowed:
        raise CatalogueError(f"Refusing non-allowlisted catalogue URL: {url}")

    if offline:
        if not cache_path.is_file():
            raise CatalogueError(f"Offline cache miss for {url}: {cache_path}")
        return cache_path.read_bytes()
    if cache_path.is_file() and not refresh:
        return cache_path.read_bytes()

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        },
    )
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise CatalogueError(f"GET {url} returned HTTP {response.status}")
                final_url = urllib.parse.urlsplit(response.geturl())
                if (
                    final_url.scheme != "https"
                    or (final_url.hostname or "").casefold() not in allowed
                ):
                    raise CatalogueError(f"GET {url} redirected outside the allowlist")
                payload = response.read()
            if not payload:
                raise CatalogueError(f"GET {url} returned an empty response")
            atomic_write_bytes(cache_path, payload)
            return payload
        except (OSError, urllib.error.URLError, CatalogueError) as exc:
            last_error = exc
            if attempt < attempts:
                time.sleep(0.5 * attempt)
    raise CatalogueError(f"Unable to fetch {url}: {last_error}")


class _TextBlock:
    def __init__(self, tag: str) -> None:
        self.tag = tag
        self.parts: list[str] = []


class CatalogueHTMLParser(HTMLParser):
    """Collect anchors and their nearest useful context inside ``content-plain``."""

    BLOCK_TAGS = frozenset({"tr", "li", "p", "dt", "dd"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.div_depth = 0
        self.content_depth: int | None = None
        self.saw_content = False
        self.blocks: list[_TextBlock] = []
        self.current_anchor: dict[str, Any] | None = None
        self.anchors: list[dict[str, Any]] = []

    @property
    def in_content(self) -> bool:
        return self.content_depth is not None

    def _append_text(self, value: str) -> None:
        if not self.in_content:
            return
        for block in self.blocks:
            block.parts.append(value)
        if self.current_anchor is not None:
            self.current_anchor["parts"].append(value)

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        tag = tag.casefold()
        attributes = {key.casefold(): value or "" for key, value in attrs}
        if tag == "div":
            self.div_depth += 1
            classes = attributes.get("class", "").casefold().split()
            if self.content_depth is None and "content-plain" in classes:
                self.content_depth = self.div_depth
                self.saw_content = True

        if not self.in_content:
            return
        if tag in self.BLOCK_TAGS:
            self.blocks.append(_TextBlock(tag))
        elif tag == "a":
            self.current_anchor = {
                "href": attributes.get("href", ""),
                "parts": [],
                "block": self.blocks[-1] if self.blocks else None,
            }
        elif tag == "img":
            alternate = attributes.get("alt", "")
            if alternate:
                self._append_text(f" {alternate} ")
        elif tag in {"br", "hr"}:
            self._append_text(" ")

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.handle_starttag(tag, attrs)
        if tag.casefold() == "div":
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if self.in_content and tag == "a" and self.current_anchor is not None:
            anchor = self.current_anchor
            self.current_anchor = None
            self.anchors.append(anchor)

        if self.in_content and tag in self.BLOCK_TAGS:
            for index in range(len(self.blocks) - 1, -1, -1):
                if self.blocks[index].tag == tag:
                    del self.blocks[index:]
                    break

        if tag == "div":
            if self.content_depth == self.div_depth:
                self.content_depth = None
                self.blocks.clear()
                self.current_anchor = None
            self.div_depth = max(0, self.div_depth - 1)

    def handle_data(self, data: str) -> None:
        self._append_text(data)


def _unique_strings(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = compact_space(value)
        if value and value not in seen:
            result.append(value)
            seen.add(value)
    return result


def _canonical_link(source_url: str, href: str) -> dict[str, Any] | None:
    """Normalize one same-origin PHP href while preserving its query identity."""

    absolute = urllib.parse.urljoin(source_url, html.unescape(href.strip()))
    parsed = urllib.parse.urlsplit(absolute)
    source = urllib.parse.urlsplit(source_url)
    if parsed.scheme.casefold() != "https" or parsed.hostname != source.hostname:
        return None
    if not parsed.path.casefold().endswith(".php"):
        return None
    source_directory = source.path.rsplit("/", 1)[0] + "/"
    if not parsed.path.startswith(source_directory):
        return None
    relative_path = urllib.parse.unquote(parsed.path[len(source_directory) :])
    if not relative_path or "/" in relative_path or "\\" in relative_path:
        return None
    stem = relative_path[:-4]
    if not re.fullmatch(r"[A-Za-z0-9._-]+", stem):
        raise CatalogueError(f"Unsafe viewer path in catalogue: {relative_path!r}")

    netloc = (parsed.hostname or "").casefold()
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    work_url = urllib.parse.urlunsplit(("https", netloc, parsed.path, parsed.query, ""))
    viewer_url = urllib.parse.urlunsplit(("https", netloc, parsed.path, "", ""))
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    p_values = query.get("p", [])
    start_raw = p_values[0] if len(p_values) == 1 else None
    start_pn = int(start_raw) if start_raw is not None and start_raw.isdigit() else None
    return {
        "workUrl": work_url,
        "viewerUrl": viewer_url,
        "viewerPath": relative_path,
        "volumeId": stem,
        "startPn": start_pn,
        "startPnRaw": start_raw,
        "query": parsed.query,
    }


def _best_text(values: Iterable[str]) -> str:
    """Prefer descriptive text over a short series-number anchor."""

    candidates = _unique_strings(values)
    if not candidates:
        return ""
    return max(
        candidates,
        key=lambda value: (
            not bool(SHORT_SERIES_RE.fullmatch(value)),
            sum(character.isalpha() for character in value),
            len(value),
        ),
    )


def _metadata_hints(labels: list[str], contexts: list[str]) -> dict[str, Any]:
    evidence = _unique_strings([*labels, *contexts])
    years = sorted({int(match.group(0)) for text in evidence for match in YEAR_RE.finditer(text)})

    series: list[str] = []
    for label in labels:
        if len(label) <= 32 and SHORT_SERIES_RE.fullmatch(label):
            series.append(label)
    for text in evidence:
        series.extend(match.group(0) for match in NAMED_SERIES_RE.finditer(text))
    series = _unique_strings(series)

    languages: list[dict[str, str]] = []
    seen_codes: set[str] = set()
    joined = " ".join(evidence)
    for code, name, pattern in LANGUAGE_PATTERNS:
        match = pattern.search(joined)
        if match is not None and code not in seen_codes:
            languages.append(
                {"code": code, "label": name, "matchedText": match.group(0)}
            )
            seen_codes.add(code)
    return {
        "seriesNumbers": series,
        "years": years,
        "languagesMentioned": languages,
    }


def parse_catalogue_page(
    source_html: str,
    source: dict[str, Any],
    *,
    excluded_viewer_paths: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """Return distinct, query-sensitive publication links from one source page."""

    required = ("id", "label", "collection", "url")
    missing = [name for name in required if not source.get(name)]
    if missing:
        raise CatalogueError(
            f"Catalogue source is missing required field(s): {', '.join(missing)}"
        )
    parser = CatalogueHTMLParser()
    parser.feed(strip_html_comments(source_html))
    parser.close()
    if not parser.saw_content:
        raise CatalogueError(f"{source['id']} has no div.content-plain catalogue region")

    excluded = {item.casefold() for item in excluded_viewer_paths}
    records: dict[str, dict[str, Any]] = {}
    for source_order, anchor in enumerate(parser.anchors, start=1):
        link = _canonical_link(source["url"], anchor["href"])
        if link is None or link["viewerPath"].casefold() in excluded:
            continue
        label = compact_space("".join(anchor["parts"]))
        block = anchor.get("block")
        context = compact_space("".join(block.parts)) if block is not None else label
        record = records.get(link["workUrl"])
        if record is None:
            record = {
                **link,
                "sourceOrder": source_order,
                "sourceHrefs": [],
                "rawLabels": [],
                "rawContexts": [],
            }
            records[link["workUrl"]] = record
        record["sourceHrefs"].append(anchor["href"])
        if label:
            record["rawLabels"].append(label)
        if context:
            record["rawContexts"].append(context)

    normalized: list[dict[str, Any]] = []
    for record in records.values():
        labels = _unique_strings(record.pop("rawLabels"))
        contexts = _unique_strings(record.pop("rawContexts"))
        hrefs = _unique_strings(record.pop("sourceHrefs"))
        normalized.append(
            {
                **record,
                "label": _best_text(labels) or _best_text(contexts) or record["volumeId"],
                "rawLabels": labels,
                "rawContexts": contexts,
                "rawContext": _best_text(contexts),
                "sourceHrefs": hrefs,
                "sourceId": source["id"],
                "sourceLabel": source["label"],
                "sourceCollection": source["collection"],
                "sourceUrl": source["url"],
                "hints": _metadata_hints(labels, contexts),
                "isExplicit": False,
            }
        )
    normalized.sort(key=lambda item: item["sourceOrder"])
    if not normalized:
        raise CatalogueError(f"{source['id']} yielded no in-scope publication links")
    return normalized


def load_catalogue_config(path: Path = DEFAULT_CONFIG) -> dict[str, Any]:
    """Load and structurally validate the allowlisted catalogue configuration."""

    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CatalogueError(f"Cannot read catalogue configuration {path}: {exc}") from exc
    if config.get("schemaVersion") != 1:
        raise CatalogueError(f"Unsupported catalogue configuration schema: {path}")
    for field in ("catalogueSources", "explicitViewers", "exclusions"):
        if not isinstance(config.get(field), list):
            raise CatalogueError(f"Catalogue configuration field {field!r} must be a list")
    if not isinstance(config.get("expectedCounts"), dict):
        raise CatalogueError("Catalogue configuration must define expectedCounts")
    if not isinstance(config.get("allowedHosts"), list) or not config["allowedHosts"]:
        raise CatalogueError("Catalogue configuration must define allowedHosts")

    source_ids = [source.get("id") for source in config["catalogueSources"]]
    if any(not item or not re.fullmatch(r"[a-z0-9-]+", item) for item in source_ids):
        raise CatalogueError("Catalogue source IDs must be non-empty lower-case slugs")
    if len(source_ids) != len(set(source_ids)):
        raise CatalogueError("Catalogue source IDs must be unique")
    configured_sources = set(source_ids)
    for explicit in config["explicitViewers"]:
        if explicit.get("sourceId") not in configured_sources:
            raise CatalogueError(
                f"Explicit viewer {explicit.get('id')!r} names an unknown sourceId"
            )
    return config


def _merge_source_record(target: dict[str, Any], incoming: dict[str, Any]) -> None:
    for plural, singular in (
        ("sourceIds", "sourceId"),
        ("sourceLabels", "sourceLabel"),
        ("sourceCollections", "sourceCollection"),
        ("sourceUrls", "sourceUrl"),
    ):
        value = incoming[singular]
        if value not in target[plural]:
            target[plural].append(value)
    for field in ("rawLabels", "rawContexts", "sourceHrefs"):
        target[field] = _unique_strings([*target[field], *incoming[field]])
    target["label"] = _best_text([target["label"], incoming["label"]])
    target["rawContext"] = _best_text(target["rawContexts"])
    target["hints"] = _metadata_hints(target["rawLabels"], target["rawContexts"])
    target["isExplicit"] = target["isExplicit"] or incoming["isExplicit"]


def _work_record_from_source(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "volumeId": record["volumeId"],
        "viewerPath": record["viewerPath"],
        "upstreamViewerUrl": record["viewerUrl"],
        "upstreamWorkUrl": record["workUrl"],
        "startPn": record["startPn"],
        "startPnRaw": record["startPnRaw"],
        "query": record["query"],
        "label": record["label"],
        "rawLabels": record["rawLabels"],
        "rawContexts": record["rawContexts"],
        "rawContext": record["rawContext"],
        "sourceHrefs": record["sourceHrefs"],
        "sourceIds": [record["sourceId"]],
        "sourceLabels": [record["sourceLabel"]],
        "sourceCollections": [record["sourceCollection"]],
        "sourceUrls": [record["sourceUrl"]],
        "collection": record["sourceCollection"],
        "hints": record["hints"],
        "isExplicit": record["isExplicit"],
        "_sort": (record.get("sourceIndex", 0), record.get("sourceOrder", 0)),
    }


def _explicit_record(
    explicit: dict[str, Any], source_by_id: dict[str, dict[str, Any]], source_index: int
) -> dict[str, Any]:
    source = source_by_id[explicit["sourceId"]]
    link = _canonical_link(source["url"], explicit.get("url") or explicit["viewerPath"])
    if link is None:
        raise CatalogueError(f"Explicit viewer is not an in-scope PHP URL: {explicit!r}")
    configured_path = explicit.get("viewerPath")
    if configured_path != link["viewerPath"]:
        raise CatalogueError(
            f"Explicit viewer path mismatch: {configured_path!r} != {link['viewerPath']!r}"
        )
    label = compact_space(explicit.get("label", "")) or link["volumeId"]
    collection = compact_space(explicit.get("collection", "")) or source["collection"]
    return {
        **link,
        "sourceOrder": source_index + 1,
        "sourceIndex": len(source_by_id) + source_index,
        "label": label,
        "rawLabels": [label],
        "rawContexts": [label],
        "rawContext": label,
        "sourceHrefs": [configured_path],
        "sourceId": explicit["sourceId"],
        "sourceLabel": source["label"],
        "sourceCollection": collection,
        "sourceUrl": source["url"],
        "hints": _metadata_hints([label], [label]),
        "isExplicit": True,
    }


def _assign_work_ids(works: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for work in works:
        start_token = str(work["startPn"]) if work["startPn"] is not None else "default"
        groups.setdefault((work["volumeId"], start_token), []).append(work)
    for (volume_id, start_token), group in groups.items():
        group.sort(key=lambda item: (item["upstreamWorkUrl"], item["_sort"]))
        for occurrence, work in enumerate(group, start=1):
            work["occurrence"] = occurrence
            work["id"] = f"{volume_id}--pn-{start_token}--{occurrence:02d}"


def _endpoint_group(volume_id: str, collection: str) -> str:
    # The audited config retains this historical singleton as its own census
    # bucket while sourceCollections continues to preserve its real list page.
    if volume_id.casefold() == "diss_schubring":
        return "Diss_Schubring"
    return collection


def normalize_catalogue(
    config: dict[str, Any], pages_by_source: dict[str, str]
) -> dict[str, Any]:
    """Normalize already-decoded source pages into works and volume seeds."""

    excluded = [item.get("viewerPath", "") for item in config.get("exclusions", [])]
    source_by_id = {source["id"]: source for source in config["catalogueSources"]}
    source_reports: list[dict[str, Any]] = []
    catalogue_records: list[dict[str, Any]] = []
    for source_index, source in enumerate(config["catalogueSources"]):
        if source["id"] not in pages_by_source:
            raise CatalogueError(f"Missing fetched catalogue page for {source['id']}")
        records = parse_catalogue_page(
            pages_by_source[source["id"]],
            source,
            excluded_viewer_paths=excluded,
        )
        for record in records:
            record["sourceIndex"] = source_index
        catalogue_records.extend(records)
        source_reports.append(
            {
                "id": source["id"],
                "label": source["label"],
                "collection": source["collection"],
                "url": source["url"],
                "workLinkCount": len(records),
                "viewerEndpointCount": len({item["viewerUrl"] for item in records}),
            }
        )

    works_by_url: dict[str, dict[str, Any]] = {}
    for record in catalogue_records:
        work = _work_record_from_source(record)
        existing = works_by_url.get(record["workUrl"])
        if existing is None:
            works_by_url[record["workUrl"]] = work
        else:
            _merge_source_record(existing, record)
    catalogue_work_count = len(works_by_url)

    explicit_urls: set[str] = set()
    for explicit_index, explicit in enumerate(config["explicitViewers"]):
        record = _explicit_record(explicit, source_by_id, explicit_index)
        if record["workUrl"] in explicit_urls:
            raise CatalogueError(f"Duplicate explicit viewer URL: {record['workUrl']}")
        explicit_urls.add(record["workUrl"])
        incoming = _work_record_from_source(record)
        existing = works_by_url.get(record["workUrl"])
        if existing is None:
            works_by_url[record["workUrl"]] = incoming
        else:
            _merge_source_record(existing, record)

    works = list(works_by_url.values())
    _assign_work_ids(works)
    works.sort(key=lambda item: (item["_sort"], item["upstreamWorkUrl"]))
    for work in works:
        work.pop("_sort", None)

    volumes_by_url: dict[str, dict[str, Any]] = {}
    for work in works:
        viewer_url = work["upstreamViewerUrl"]
        volume = volumes_by_url.get(viewer_url)
        if volume is None:
            volume = {
                "id": work["volumeId"],
                "volumeId": work["volumeId"],
                "viewerPath": work["viewerPath"],
                "upstreamViewerUrl": viewer_url,
                "collection": work["collection"],
                "sourceIds": [],
                "sourceCollections": [],
                "workItemIds": [],
            }
            volumes_by_url[viewer_url] = volume
        elif volume["volumeId"] != work["volumeId"]:
            raise CatalogueError(f"Viewer URL maps to conflicting IDs: {viewer_url}")
        for field in ("sourceIds", "sourceCollections"):
            for value in work[field]:
                if value not in volume[field]:
                    volume[field].append(value)
        volume["workItemIds"].append(work["id"])

    volumes = list(volumes_by_url.values())
    for volume in volumes:
        volume["workCount"] = len(volume["workItemIds"])
        volume["endpointGroup"] = _endpoint_group(
            volume["volumeId"], volume["collection"]
        )
    volumes.sort(key=lambda item: item["upstreamViewerUrl"])

    folded_ids: dict[str, str] = {}
    for volume in volumes:
        folded = volume["volumeId"].casefold()
        previous = folded_ids.setdefault(folded, volume["volumeId"])
        if previous != volume["volumeId"]:
            raise CatalogueError(
                f"Case-insensitive volume ID collision: {previous!r} and {volume['volumeId']!r}"
            )
    work_ids = [work["id"] for work in works]
    if len(work_ids) != len(set(work_ids)):
        raise CatalogueError("Derived work item IDs are not unique")

    catalogue_viewers = {
        record["viewerUrl"] for record in catalogue_records
    }
    explicit_viewers = {
        _canonical_link(source_by_id[item["sourceId"]]["url"], item["url"])[
            "viewerUrl"
        ]
        for item in config["explicitViewers"]
    }
    counts = {
        "catalogueSources": len(source_reports),
        "catalogueWorkLinks": catalogue_work_count,
        "explicitViewerLinks": len(explicit_urls),
        "searchableWorkEntries": len(works),
        "catalogueViewerEndpoints": len(catalogue_viewers),
        "explicitViewerEndpoints": len(explicit_viewers),
        "physicalViewerEndpoints": len(volumes),
        "byCollection": dict(
            sorted(Counter(volume["endpointGroup"] for volume in volumes).items())
        ),
    }
    validate_expected_counts(counts, config["expectedCounts"])
    return {
        "schemaVersion": 1,
        "verifiedAgainst": config.get("verifiedAt", ""),
        "counts": counts,
        "sources": source_reports,
        "volumes": volumes,
        "works": works,
    }


def validate_expected_counts(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    """Fail closed when the live catalogue drifts from the reviewed census."""

    scalar_fields = (
        "catalogueSources",
        "catalogueWorkLinks",
        "explicitViewerLinks",
        "searchableWorkEntries",
        "catalogueViewerEndpoints",
        "explicitViewerEndpoints",
        "physicalViewerEndpoints",
    )
    mismatches: list[str] = []
    for field in scalar_fields:
        if field not in expected:
            mismatches.append(f"expectedCounts.{field} is missing")
        elif actual.get(field) != expected[field]:
            mismatches.append(f"{field}: expected {expected[field]}, received {actual.get(field)}")
    expected_collections = expected.get("byCollection")
    if not isinstance(expected_collections, dict):
        mismatches.append("expectedCounts.byCollection is missing")
    elif actual.get("byCollection") != dict(sorted(expected_collections.items())):
        mismatches.append(
            "byCollection: expected "
            f"{dict(sorted(expected_collections.items()))}, received {actual.get('byCollection')}"
        )
    if mismatches:
        raise CatalogueError("Catalogue census failed closed: " + "; ".join(mismatches))


def crawl_catalogue(
    config_path: Path = DEFAULT_CONFIG,
    *,
    cache_dir: Path = DEFAULT_CACHE,
    offline: bool = False,
    refresh: bool = False,
) -> dict[str, Any]:
    """Fetch/cache every allowlisted page and return normalized catalogue data."""

    config = load_catalogue_config(config_path)
    allowed_hosts = config["allowedHosts"]
    pages_by_source: dict[str, str] = {}
    for source in config["catalogueSources"]:
        payload = fetch_cached_bytes(
            source["url"],
            cache_dir / "catalogues" / f"{source['id']}.html",
            offline=offline,
            refresh=refresh,
            allowed_hosts=allowed_hosts,
        )
        pages_by_source[source["id"]] = decode_html(payload)
    return normalize_catalogue(config, pages_by_source)


def write_catalogue_outputs(
    result: dict[str, Any], output_dir: Path, *, generated_at: str | None = None
) -> tuple[Path, Path]:
    """Write separate orchestrator-ready volume-seed and work-item envelopes."""

    timestamp = generated_at or utc_now()
    common = {
        "schemaVersion": result["schemaVersion"],
        "generatedAt": timestamp,
        "verifiedAgainst": result.get("verifiedAgainst", ""),
        "counts": result["counts"],
        "sources": result["sources"],
    }
    seed_path = output_dir / "volume-seeds.json"
    work_path = output_dir / "work-items.json"
    write_json(
        seed_path,
        {**common, "volumeCount": len(result["volumes"]), "volumes": result["volumes"]},
    )
    write_json(
        work_path,
        {**common, "itemCount": len(result["works"]), "items": result["works"]},
    )
    return seed_path, work_path


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Directory that will receive volume-seeds.json and work-items.json",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--refresh", action="store_true", help="Require fresh upstream catalogue pages"
    )
    mode.add_argument(
        "--offline", action="store_true", help="Require all catalogue pages from cache"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    result = crawl_catalogue(
        args.config.resolve(),
        cache_dir=args.cache.resolve(),
        offline=args.offline,
        refresh=args.refresh,
    )
    seed_path, work_path = write_catalogue_outputs(result, args.output.resolve())
    counts = result["counts"]
    print(
        f"Wrote {counts['physicalViewerEndpoints']} volume seeds to {seed_path}",
        flush=True,
    )
    print(
        f"Wrote {counts['searchableWorkEntries']} work items to {work_path}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CatalogueError as exc:
        print(f"catalogue error: {exc}", file=sys.stderr)
        raise SystemExit(1)
