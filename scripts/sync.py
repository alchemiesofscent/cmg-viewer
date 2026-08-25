#!/usr/bin/env python3
"""Build static CMG volume records and IIIF Presentation 3 manifests.

The first implementation deliberately targets the four reference volumes in
``config/sample-volumes.json``.  It uses only the Python standard library so
the same command can run locally and in GitHub Actions without an additional
Python dependency install.

Live responses are cached below ``data/source``.  A normal run reuses cached
responses, ``--refresh`` requires fresh upstream responses, and ``--offline``
requires a complete cache and performs no network requests.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import sys
import tempfile
import time
from typing import Any, Iterable
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "sample-volumes.json"
DEFAULT_CACHE = PROJECT_ROOT / "data" / "source"
DEFAULT_DIST = PROJECT_ROOT / "dist"

CMG_ORIGIN = "https://cmg.bbaw.de"
CMG_ONLINE = f"{CMG_ORIGIN}/epubl/online/"
IMAGE_API_ROOT = "https://digilib.bbaw.de/digilib/Scaler/IIIF"
MANIFESTER_API_ROOT = "https://digilib.bbaw.de/digilib/Manifester/IIIF/3"
DEFAULT_BASE_URL = "https://alchemiesofscent.github.io/cmg-viewer"
USER_AGENT = (
    "cmg-viewer-sync/0.1 "
    "(+https://github.com/alchemiesofscent/cmg-viewer; static catalogue sync)"
)

METS_NS = "http://www.loc.gov/METS/"
MODS_NS = "http://www.loc.gov/mods/v3"
XLINK_NS = "http://www.w3.org/1999/xlink"
NS = {"mets": METS_NS, "mods": MODS_NS}
XLINK_HREF = f"{{{XLINK_NS}}}href"


class SyncError(RuntimeError):
    """An upstream or validation error which must stop publication."""


def strip_html_comments(source: str) -> str:
    """Remove inactive markup before extracting legacy JavaScript values."""

    return re.sub(r"<!--.*?-->", "", source, flags=re.DOTALL)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def compact_space(value: str) -> str:
    return " ".join(html.unescape(value).split())


def language_map(value: str, language: str = "none") -> dict[str, list[str]]:
    return {language: [value]}


def stable_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    if slug:
        return slug
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def decode_html(payload: bytes) -> str:
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
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def write_json(path: Path, value: Any) -> None:
    payload = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    atomic_write_bytes(path, payload)


def clear_generated_records(dist_dir: Path) -> None:
    """Remove only synchronized outputs after a complete successful fetch."""

    targets = (dist_dir / "data" / "volumes", dist_dir / "iiif")
    for target in targets:
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()


def fetch_bytes(
    url: str,
    cache_path: Path,
    *,
    offline: bool,
    refresh: bool,
    attempts: int = 3,
    timeout: float = 40.0,
) -> bytes:
    if offline:
        if not cache_path.is_file():
            raise SyncError(f"Offline cache miss for {url}: {cache_path}")
        return cache_path.read_bytes()

    if cache_path.is_file() and not refresh:
        return cache_path.read_bytes()

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json, application/xml, text/xml, text/html;q=0.9, */*;q=0.5",
        },
    )
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise SyncError(f"GET {url} returned HTTP {response.status}")
                payload = response.read()
            atomic_write_bytes(cache_path, payload)
            return payload
        except (OSError, urllib.error.URLError, SyncError) as exc:
            last_error = exc
            if attempt < attempts:
                time.sleep(0.5 * attempt)
    raise SyncError(f"Unable to fetch {url}: {last_error}")


class ViewerHTMLParser(HTMLParser):
    """Extract the title and the dedicated volume contents list."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ul_depth = 0
        self.toc_root_depth: int | None = None
        self.current_anchor: dict[str, Any] | None = None
        self.toc_anchors: list[dict[str, Any]] = []
        self.in_h1 = False
        self.h1_parts: list[str] = []
        self._first_h1_complete = False

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attr = {key.casefold(): value or "" for key, value in attrs}
        tag = tag.casefold()
        if tag == "ul":
            self.ul_depth += 1
            if attr.get("id", "").casefold() == "inhaltsverzeichnis":
                self.toc_root_depth = self.ul_depth
        elif (
            tag == "a"
            and self.toc_root_depth is not None
            and self.ul_depth >= self.toc_root_depth
        ):
            self.current_anchor = {
                "href": attr.get("href", ""),
                "parts": [],
                "depth": self.ul_depth - self.toc_root_depth,
            }
        elif tag == "h1" and not self._first_h1_complete:
            self.in_h1 = True

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag == "a" and self.current_anchor is not None:
            label = compact_space("".join(self.current_anchor.pop("parts")))
            if label:
                self.current_anchor["label"] = label
                self.toc_anchors.append(self.current_anchor)
            self.current_anchor = None
        elif tag == "ul":
            if self.toc_root_depth == self.ul_depth:
                self.toc_root_depth = None
            self.ul_depth = max(0, self.ul_depth - 1)
        elif tag == "h1" and self.in_h1:
            self.in_h1 = False
            self._first_h1_complete = True

    def handle_data(self, data: str) -> None:
        if self.current_anchor is not None:
            self.current_anchor["parts"].append(data)
        if self.in_h1:
            self.h1_parts.append(data)


def parse_live_html(source: str) -> dict[str, Any]:
    active_source = strip_html_comments(source)
    parser = ViewerHTMLParser()
    parser.feed(active_source)

    scaler_match = re.search(
        r"\burl\s*=\s*['\"]([^'\"]*digilib\.bbaw\.de[^'\"]*/Scaler\?[^'\"]*\bfn=[^'\"]+?)['\"]",
        active_source,
        re.I,
    )
    if scaler_match is None:
        raise SyncError("Live viewer HTML does not expose a Digilib Scaler fn URL")
    scaler_url = html.unescape(scaler_match.group(1))
    parsed_scaler = urllib.parse.urlsplit(scaler_url)
    if parsed_scaler.scheme != "https" or parsed_scaler.hostname != "digilib.bbaw.de":
        raise SyncError(
            "Live Scaler URL must use HTTPS on digilib.bbaw.de: "
            f"{scaler_url}"
        )
    query = urllib.parse.parse_qs(parsed_scaler.query, keep_blank_values=True)
    fn_values = query.get("fn")
    if not fn_values:
        raise SyncError(f"Live Scaler URL has no fn parameter: {scaler_url}")
    fn_value = urllib.parse.unquote(fn_values[0]).replace("\\", "/")
    if fn_value.endswith("/"):
        fn_directory = fn_value
    else:
        fn_directory = posixpath.dirname(fn_value).rstrip("/") + "/"
    if not fn_directory.startswith("/"):
        raise SyncError(f"Unexpected non-absolute Digilib fn path: {fn_value}")

    def integer_assignment(name: str) -> int | None:
        match = re.search(
            rf"\b{re.escape(name)}\s*=\s*(\d+)\s*;", active_source
        )
        return int(match.group(1)) if match else None

    toc: list[dict[str, Any]] = []
    for anchor in parser.toc_anchors:
        href = html.unescape(anchor["href"])
        js_match = re.search(r"InhaltInFrame\(\s*(\d+)", href, re.I)
        page_match = re.search(r"(?:\?|&)p=(\d+)(?:=(\d+))?", href, re.I)
        if js_match:
            start = int(js_match.group(1))
            orders = [start]
            selection = "start"
        elif page_match:
            start = int(page_match.group(1))
            end = int(page_match.group(2)) if page_match.group(2) else None
            if end is not None and end >= start:
                orders = list(range(start, end + 1, 2))
                selection = "alternating"
            else:
                orders = [start]
                selection = "start"
        else:
            continue
        toc.append(
            {
                "label": anchor["label"],
                "depth": anchor["depth"],
                "orders": orders,
                "selection": selection,
                "href": href,
            }
        )

    overhead = integer_assignment("overhead") or 0
    legacy_last = integer_assignment("ende_real")
    return {
        "title": compact_space("".join(parser.h1_parts)),
        "fnDirectory": fn_directory,
        "scalerUrl": scaler_url,
        "firstOrder": integer_assignment("anf_real"),
        "lastOrder": legacy_last,
        "overhead": overhead,
        "lastPhysicalOrder": legacy_last + overhead if legacy_last is not None else None,
        "toc": toc,
    }


def first_text(element: ET.Element, path: str) -> str:
    found = element.find(path, NS)
    return compact_space(found.text or "") if found is not None else ""


def unique_in_order(values: Iterable[int], order_index: dict[int, int]) -> list[int]:
    return sorted(set(values), key=lambda value: order_index[value])


def parse_mets(payload: bytes) -> dict[str, Any]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise SyncError(f"Invalid METS XML: {exc}") from exc

    max_file_ids: set[str] = set()
    file_hrefs: dict[str, str] = {}
    for group in root.findall(".//mets:fileGrp", NS):
        is_max = group.get("USE", "").upper() == "MAX"
        for file_element in group.findall("mets:file", NS):
            file_id = file_element.get("ID")
            location = file_element.find("mets:FLocat", NS)
            href = location.get(XLINK_HREF) if location is not None else None
            if file_id and href:
                file_hrefs[file_id] = href
                if is_max:
                    max_file_ids.add(file_id)
    if not max_file_ids:
        raise SyncError("METS has no MAX file group")

    physical_map = next(
        (
            item
            for item in root.findall("mets:structMap", NS)
            if item.get("TYPE", "").upper() == "PHYSICAL"
        ),
        None,
    )
    if physical_map is None:
        raise SyncError("METS has no PHYSICAL structMap")

    pages: list[dict[str, Any]] = []
    warnings: list[str] = []
    physical_id_to_order: dict[str, int] = {}
    file_id_to_order: dict[str, int] = {}
    for div in physical_map.iterfind(".//mets:div", NS):
        raw_order = div.get("ORDER")
        if raw_order is None or not raw_order.isdigit():
            continue
        order = int(raw_order)
        pointers = [
            pointer.get("FILEID")
            for pointer in div.findall("mets:fptr", NS)
            if pointer.get("FILEID")
        ]
        max_pointer = next(
            (
                item
                for item in pointers
                if item in max_file_ids and item in file_hrefs
            ),
            None,
        )
        if max_pointer is None:
            # A handful of otherwise complete BBAW records point at a missing
            # MAX file for one scan while their DEFAULT derivative and native
            # Digilib image remain live.  The derivative is used only to recover
            # the basename; native dimensions and the service are still verified
            # against Digilib below.
            max_pointer = next((item for item in pointers if item in file_hrefs), None)
        if max_pointer is None:
            max_pointer = pointers[0] if pointers else f"unresolved_ORDER_{order}"
            warnings.append(
                f"Physical ORDER {order} has no resolvable METS image derivative; "
                "the live Digilib directory position must supply its image"
            )
        physical_id = div.get("ID")
        if not physical_id:
            raise SyncError(f"Physical ORDER {order} has no ID")
        pages.append(
            {
                "order": order,
                "label": div.get("ORDERLABEL") or str(order),
                "physicalId": physical_id,
                "maxFileId": max_pointer,
                "maxHref": file_hrefs.get(max_pointer, ""),
                "_fileIds": pointers,
            }
        )

    raw_orders = [page["order"] for page in pages]
    if len(raw_orders) != len(set(raw_orders)):
        id_orders: list[int] = []
        for page in pages:
            suffix = re.search(r"(\d+)$", page["physicalId"])
            if suffix is None:
                break
            id_orders.append(int(suffix.group(1)))
        repairable = (
            len(id_orders) == len(pages)
            and len(id_orders) == len(set(id_orders))
            and id_orders == sorted(id_orders)
            and id_orders == list(range(id_orders[0], id_orders[-1] + 1))
            and all(
                raw == derived or raw_orders.count(raw) > 1
                for raw, derived in zip(raw_orders, id_orders, strict=True)
            )
        )
        if not repairable:
            duplicates = sorted(
                {order for order in raw_orders if raw_orders.count(order) > 1}
            )
            raise SyncError(
                "Duplicate METS physical ORDER value(s) cannot be repaired from "
                f"the physical IDs: {duplicates}"
            )
        for page, derived in zip(pages, id_orders, strict=True):
            page["order"] = derived

    for page in pages:
        order = page["order"]
        physical_id_to_order[page["physicalId"]] = order
        for pointer in page.pop("_fileIds"):
            file_id_to_order[pointer] = order
    pages.sort(key=lambda page: page["order"])
    if not pages:
        raise SyncError("METS PHYSICAL structMap contains no pages")
    order_index = {page["order"]: index for index, page in enumerate(pages)}

    mods = root.find(".//mods:mods", NS)
    metadata: dict[str, Any] = {
        "title": "",
        "contributors": [],
        "dateIssued": "",
        "languages": [],
    }
    if mods is not None:
        metadata["title"] = first_text(mods, "mods:titleInfo/mods:title")
        metadata["contributors"] = [
            compact_space(item.text or "")
            for item in mods.findall("mods:name/mods:displayForm", NS)
            if compact_space(item.text or "")
        ]
        metadata["dateIssued"] = first_text(mods, "mods:originInfo/mods:dateIssued")
        metadata["languages"] = list(
            dict.fromkeys(
                compact_space(item.text or "")
                for item in mods.findall("mods:language/mods:languageTerm", NS)
                if compact_space(item.text or "")
            )
        )

    logical_map = next(
        (
            item
            for item in root.findall("mets:structMap", NS)
            if item.get("TYPE", "").upper() == "LOGICAL"
        ),
        None,
    )
    unresolved_logical_pointers: list[str] = []
    logical_ids: set[str] = set()

    def parse_logical_div(div: ET.Element, position: str) -> dict[str, Any]:
        orders: list[int] = []
        for pointer in div.findall("mets:fptr", NS):
            file_id = pointer.get("FILEID")
            if not file_id:
                continue
            if file_id in physical_id_to_order:
                orders.append(physical_id_to_order[file_id])
            elif file_id in file_id_to_order:
                orders.append(file_id_to_order[file_id])
            else:
                unresolved_logical_pointers.append(file_id)
        children = [
            parse_logical_div(child, f"{position}-{index}")
            for index, child in enumerate(div.findall("mets:div", NS), start=1)
        ]
        label = compact_space(div.get("LABEL") or div.get("TYPE") or "Contents")
        raw_id = div.get("ID") or f"mets-range-{position}"
        node_id = raw_id
        if node_id in logical_ids:
            node_id = f"{raw_id}--duplicate-{position}"
            warnings.append(
                f"Duplicate METS logical range ID {raw_id!r} was normalized as {node_id!r}"
            )
        logical_ids.add(node_id)
        return {
            "id": node_id,
            "label": label,
            "type": div.get("TYPE") or "section",
            "orders": unique_in_order(orders, order_index),
            "items": children,
            "provenance": ["mets"],
        }

    logical_root_element = (
        logical_map.find("mets:div", NS) if logical_map is not None else None
    )
    logical_root = (
        parse_logical_div(logical_root_element, "1")
        if logical_root_element is not None
        else None
    )
    if unresolved_logical_pointers:
        examples = ", ".join(unresolved_logical_pointers[:5])
        warnings.append(
            f"METS contains {len(unresolved_logical_pointers)} unresolved logical fptr(s): {examples}"
        )

    return {
        "metadata": metadata,
        "pages": pages,
        "logicalRoot": logical_root,
        "warnings": warnings,
    }


def max_basename(max_href: str) -> str:
    filename = posixpath.basename(urllib.parse.unquote(urllib.parse.urlsplit(max_href).path))
    stem, _extension = posixpath.splitext(filename)
    stem = re.sub(r"(?:[-_](?:max|default|min|thumbs?))$", "", stem, flags=re.I)
    if not stem:
        raise SyncError(f"Cannot derive a Digilib page basename from {max_href}")
    return stem


def image_service_id(
    fn_directory: str, max_href: str, image_basename: str | None = None
) -> str:
    source_path = posixpath.join(fn_directory, image_basename or max_basename(max_href))
    identifier = source_path.lstrip("/").replace("/", "!")
    return f"{IMAGE_API_ROOT}/{urllib.parse.quote(identifier, safe='!')}"


def manifester_url(fn_directory: str) -> str:
    """Return the one-request Digilib directory manifest endpoint.

    Digilib's generated Presentation manifest contains broken public roots, so
    it is never republished directly. It is only used as an efficient filename
    and native-dimension index; our own IDs and working Image API v2 service
    roots remain authoritative.
    """

    directory = fn_directory.strip("/")
    if not directory or any(part in {"", ".", ".."} for part in directory.split("/")):
        raise SyncError(f"Unexpected Digilib fn directory: {fn_directory}")
    identifier = directory.replace("/", "!")
    return f"{MANIFESTER_API_ROOT}/{urllib.parse.quote(identifier, safe='!')}"


def localized_first(value: Any) -> str:
    if isinstance(value, str):
        return compact_space(value)
    if isinstance(value, list):
        for item in value:
            result = localized_first(item)
            if result:
                return result
    if isinstance(value, dict):
        for key in ("none", "en", "de"):
            result = localized_first(value.get(key))
            if result:
                return result
        for item in value.values():
            result = localized_first(item)
            if result:
                return result
    return ""


def parse_manifester(payload: bytes) -> dict[str, dict[str, int]]:
    """Index a Digilib directory manifest by its page filename label."""

    try:
        manifest = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SyncError(f"Invalid Digilib Manifester JSON: {exc}") from exc
    items = manifest.get("items")
    if not isinstance(items, list) or not items:
        raise SyncError("Digilib Manifester response contains no canvases")
    result: dict[str, dict[str, int]] = {}
    for canvas in items:
        if not isinstance(canvas, dict):
            continue
        label = localized_first(canvas.get("label"))
        width = canvas.get("width")
        height = canvas.get("height")
        if not label or not isinstance(width, int) or not isinstance(height, int):
            continue
        if width < 1 or height < 1:
            continue
        if label in result:
            raise SyncError(f"Digilib Manifester has duplicate filename label: {label}")
        result[label] = {"width": width, "height": height}
    if not result:
        raise SyncError("Digilib Manifester response has no labelled dimensions")
    return result


def enrich_pages_from_manifester(
    pages: list[dict[str, Any]],
    payload: bytes,
    *,
    fn_directory: str | None = None,
    directory_page_count: int | None = None,
) -> list[dict[str, Any]]:
    """Apply directory-manifest dimensions and return unmatched METS pages.

    Most METS MAX filenames match the Digilib canvas labels exactly.  A small
    number of reviewed legacy records contain a stale derivative filename even
    though their physical ORDER and live Digilib directory are correct.  For
    those only, use an unambiguous trailing page number in the one-directory
    inventory and update the service basename as well as its dimensions.
    """

    dimensions = parse_manifester(payload)
    directory_labels = [
        label
        for label in dimensions
        if not label.casefold().startswith(("x_", "x-"))
    ]
    tolerated_extras = (
        max(5, (directory_page_count + 99) // 100)
        if isinstance(directory_page_count, int) and directory_page_count > 0
        else 0
    )
    positionally_indexed = (
        isinstance(directory_page_count, int)
        and directory_page_count > 0
        and directory_page_count <= len(directory_labels)
        and len(directory_labels) - directory_page_count <= tolerated_extras
    )
    if positionally_indexed:
        directory_labels = directory_labels[:directory_page_count]
    missing: list[dict[str, Any]] = []
    for page in pages:
        basename = page.get("imageBasename") or max_basename(page["maxHref"])
        matched_basename = basename
        if positionally_indexed and 1 <= page["order"] <= len(directory_labels):
            # The legacy Scaler's pn is the one-based position in its directory
            # sequence.  When that reviewed sequence count exactly matches the
            # active viewer bounds (allowing only a few inaccessible trailing
            # auxiliaries), this is a stronger join than a stale METS derivative
            # filename (notably multi-part CML and the Diels preliminaries).
            matched_basename = directory_labels[page["order"] - 1]
            match = dimensions[matched_basename]
        else:
            match = dimensions.get(basename)
        if match is None:
            numbered = [
                candidate
                for candidate in dimensions
                if (suffix := re.search(r"(?:^|[_-])(\d+)$", candidate))
                and int(suffix.group(1)) == page["order"]
            ]
            if len(numbered) == 1:
                matched_basename = numbered[0]
                match = dimensions[matched_basename]
        if match is None:
            missing.append(page)
            continue
        if matched_basename != basename:
            page["imageBasename"] = matched_basename
            if fn_directory is not None:
                page["imageServiceId"] = image_service_id(
                    fn_directory, page["maxHref"], matched_basename
                )
        page["width"] = match["width"]
        page["height"] = match["height"]
    return missing


def walk_ranges(root: dict[str, Any] | None) -> Iterable[dict[str, Any]]:
    if root is None:
        return
    yield root
    for child in root.get("items", []):
        yield from walk_ranges(child)


def filter_range_orders(
    root: dict[str, Any] | None, valid_orders: set[int]
) -> None:
    """Remove unavailable physical ORDER references while retaining TOC labels."""

    if root is None:
        return
    root["orders"] = [
        order for order in root.get("orders", []) if order in valid_orders
    ]
    for child in root.get("items", []):
        filter_range_orders(child, valid_orders)


def range_first_order(node: dict[str, Any]) -> int | None:
    candidates = list(node.get("orders", []))
    for child in node.get("items", []):
        value = range_first_order(child)
        if value is not None:
            candidates.append(value)
    return min(candidates) if candidates else None


def normalized_label(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def merge_structures(
    volume_id: str,
    logical_root: dict[str, Any] | None,
    html_toc: list[dict[str, Any]],
    valid_orders: set[int],
    fallback_label: str,
) -> dict[str, Any]:
    if logical_root is None:
        logical_root = {
            "id": f"{volume_id}-contents",
            "label": fallback_label,
            "type": "monograph",
            "orders": [],
            "items": [],
            "provenance": [],
        }

    existing = list(walk_ranges(logical_root))
    additions: list[dict[str, Any]] = []
    seen_html: set[tuple[str, tuple[int, ...]]] = set()
    for index, item in enumerate(html_toc, start=1):
        orders = [order for order in item["orders"] if order in valid_orders]
        if not orders:
            continue
        key = (normalized_label(item["label"]), tuple(orders))
        if key in seen_html:
            continue
        seen_html.add(key)
        first_order = orders[0]
        match = next(
            (
                node
                for node in existing
                if normalized_label(node["label"]) == key[0]
                and range_first_order(node) == first_order
            ),
            None,
        )
        if match is not None and item["selection"] == "start":
            if "html" not in match["provenance"]:
                match["provenance"].append("html")
            continue
        additions.append(
            {
                "id": f"html-{volume_id}-{stable_slug(item['label'])}-{first_order}-{index}",
                "label": item["label"],
                "type": "section",
                "orders": orders,
                "items": [],
                "provenance": ["html"],
                "selection": item["selection"],
            }
        )

    logical_root["items"].extend(additions)
    logical_root["items"].sort(
        key=lambda node: (
            range_first_order(node) is None,
            range_first_order(node) or 0,
            normalized_label(node["label"]),
        )
    )
    return logical_root


def fetch_page_info(
    page: dict[str, Any],
    cache_dir: Path,
    *,
    offline: bool,
    refresh: bool,
) -> dict[str, Any]:
    info_url = f"{page['imageServiceId']}/info.json"
    cache_path = cache_dir / f"{page['order']:06d}.json"
    payload = fetch_bytes(info_url, cache_path, offline=offline, refresh=refresh)
    try:
        info = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SyncError(f"Invalid IIIF info.json for ORDER {page['order']}: {exc}") from exc
    width = info.get("width")
    height = info.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1:
        raise SyncError(f"IIIF info.json has invalid dimensions: {info_url}")
    advertised_id = info.get("@id") or info.get("id")
    if advertised_id and advertised_id.rstrip("/") != page["imageServiceId"]:
        raise SyncError(
            f"IIIF service ID mismatch for ORDER {page['order']}: {advertised_id}"
        )
    return {
        "order": page["order"],
        "width": width,
        "height": height,
        "profile": info.get("profile"),
    }


def enrich_pages_with_iiif(
    pages: list[dict[str, Any]],
    cache_dir: Path,
    *,
    offline: bool,
    refresh: bool,
    workers: int,
) -> None:
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_page = {
            executor.submit(
                fetch_page_info,
                page,
                cache_dir,
                offline=offline,
                refresh=refresh,
            ): page
            for page in pages
        }
        errors: list[str] = []
        for future in concurrent.futures.as_completed(future_to_page):
            page = future_to_page[future]
            try:
                info = future.result()
                page["width"] = info["width"]
                page["height"] = info["height"]
            except BaseException as exc:
                errors.append(f"ORDER {page['order']}: {exc}")
        if errors:
            joined = "\n  - ".join(errors[:12])
            remainder = "" if len(errors) <= 12 else f"\n  - …and {len(errors) - 12} more"
            raise SyncError(f"IIIF validation failed:\n  - {joined}{remainder}")


def source_metadata_items(seed: dict[str, Any], metadata: dict[str, Any]) -> list[dict[str, Any]]:
    pairs: list[tuple[str, str]] = []
    if seed.get("collection"):
        pairs.append(("Collection", seed["collection"]))
    if seed.get("seriesNumber"):
        pairs.append(("Series number", seed["seriesNumber"]))
    if metadata.get("contributors"):
        pairs.append(("Contributors", "; ".join(metadata["contributors"])))
    if metadata.get("dateIssued"):
        pairs.append(("Date issued", metadata["dateIssued"]))
    if metadata.get("languages"):
        pairs.append(("Language", "; ".join(metadata["languages"])))
    return [
        {"label": language_map(label, "en"), "value": language_map(value)}
        for label, value in pairs
    ]


def manifest_range(
    node: dict[str, Any], base_url: str, volume_id: str
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": f"{base_url}/iiif/{volume_id}/range/{urllib.parse.quote(node['id'], safe='-_~')}",
        "type": "Range",
        "label": language_map(node["label"]),
        "items": [
            {
                "id": f"{base_url}/iiif/{volume_id}/canvas/p{order}",
                "type": "Canvas",
            }
            for order in node.get("orders", [])
        ],
    }
    result["items"].extend(
        manifest_range(child, base_url, volume_id) for child in node.get("items", [])
    )
    provenance = node.get("provenance", [])
    if provenance:
        source_labels = {"mets": "METS", "html": "live HTML"}
        value = " + ".join(source_labels.get(item, item) for item in provenance)
        result["metadata"] = [
            {
                "label": language_map("Contents source", "en"),
                "value": language_map(value, "en"),
            }
        ]
    return result


def build_manifest(
    seed: dict[str, Any],
    title: str,
    metadata: dict[str, Any],
    pages: list[dict[str, Any]],
    structures: dict[str, Any],
    base_url: str,
    viewer_url: str,
    mets_url: str | None,
) -> dict[str, Any]:
    volume_id = seed["id"]
    manifest_id = f"{base_url}/iiif/{volume_id}/manifest.json"
    canvases: list[dict[str, Any]] = []
    for page in pages:
        order = page["order"]
        canvas_id = f"{base_url}/iiif/{volume_id}/canvas/p{order}"
        annotation_page_id = f"{canvas_id}/page"
        annotation_id = f"{annotation_page_id}/painting"
        image_id = f"{page['imageServiceId']}/full/full/0/default.jpg"
        canvases.append(
            {
                "id": canvas_id,
                "type": "Canvas",
                "label": language_map(page["label"]),
                "width": page["width"],
                "height": page["height"],
                "metadata": [
                    {
                        "label": language_map("Physical order", "en"),
                        "value": language_map(str(order)),
                    }
                ],
                "items": [
                    {
                        "id": annotation_page_id,
                        "type": "AnnotationPage",
                        "items": [
                            {
                                "id": annotation_id,
                                "type": "Annotation",
                                "motivation": "painting",
                                "target": canvas_id,
                                "body": {
                                    "id": image_id,
                                    "type": "Image",
                                    "format": "image/jpeg",
                                    "width": page["width"],
                                    "height": page["height"],
                                    "service": [
                                        {
                                            "id": page["imageServiceId"],
                                            "type": "ImageService2",
                                            "profile": "level2",
                                        }
                                    ],
                                },
                            }
                        ],
                    }
                ],
            }
        )

    first_page = pages[0]
    top_range = manifest_range(structures, base_url, volume_id)
    top_range["behavior"] = ["top"]
    result: dict[str, Any] = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        "id": manifest_id,
        "type": "Manifest",
        "label": language_map(title),
        "metadata": source_metadata_items(seed, metadata),
        "behavior": ["paged"],
        "viewingDirection": seed.get("viewingDirection", "left-to-right"),
        "requiredStatement": {
            "label": language_map("Attribution", "en"),
            "value": language_map(
                "Page images are served by the Berlin-Brandenburg Academy of Sciences and Humanities (BBAW).",
                "en",
            ),
        },
        "provider": [
            {
                "id": "https://www.bbaw.de/",
                "type": "Agent",
                "label": language_map(
                    "Berlin-Brandenburg Academy of Sciences and Humanities", "en"
                ),
            }
        ],
        "homepage": [
            {
                "id": viewer_url,
                "type": "Text",
                "label": language_map("Original CMG viewer", "en"),
                "format": "text/html",
            }
        ],
        "thumbnail": [
            {
                "id": f"{first_page['imageServiceId']}/full/200,/0/default.jpg",
                "type": "Image",
                "format": "image/jpeg",
                "service": [
                    {
                        "id": first_page["imageServiceId"],
                        "type": "ImageService2",
                        "profile": "level2",
                    }
                ],
            }
        ],
        "items": canvases,
        "structures": [top_range],
    }
    if mets_url:
        result["seeAlso"] = [
            {
                "id": mets_url,
                "type": "Dataset",
                "label": language_map("BBAW METS record", "en"),
                "format": "application/xml",
            }
        ]
    return result


def build_volume_record(
    seed: dict[str, Any],
    title: str,
    metadata: dict[str, Any],
    pages: list[dict[str, Any]],
    structures: dict[str, Any],
    base_url: str,
    viewer_url: str,
    mets_url: str | None,
) -> dict[str, Any]:
    volume_id = seed["id"]
    first_order = pages[0]["order"]
    normalized_pages: list[dict[str, Any]] = []
    for index, page in enumerate(pages):
        order = page["order"]
        source_page = f"{viewer_url}?custom=1&pn={order}&AnzFrames=1"
        normalized_pages.append(
            {
                "index": index,
                "order": order,
                "label": page["label"],
                "width": page["width"],
                "height": page["height"],
                "canvasId": f"{base_url}/iiif/{volume_id}/canvas/p{order}",
                "imageServiceId": page["imageServiceId"],
                "imageUrl": f"{page['imageServiceId']}/full/full/0/default.jpg",
                "thumbnailUrl": f"{page['imageServiceId']}/full/200,/0/default.jpg",
                "sourcePageUrl": source_page,
                "maxDerivativeUrl": page["maxHref"],
            }
        )
    source = {
        "viewerUrl": viewer_url,
        "imageProvider": "https://digilib.bbaw.de/",
    }
    if mets_url:
        source["metsUrl"] = mets_url
    return {
        "schemaVersion": 1,
        "id": volume_id,
        "type": "Volume",
        "label": title,
        "collection": seed.get("collection", ""),
        "seriesNumber": seed.get("seriesNumber", ""),
        "metadata": metadata,
        "source": source,
        "viewerUrl": f"{base_url}/viewer/{volume_id}/",
        "manifestUrl": f"{base_url}/iiif/{volume_id}/manifest.json",
        "defaultPn": seed.get("samplePn", first_order),
        "pageCount": len(pages),
        "firstOrder": first_order,
        "lastOrder": pages[-1]["order"],
        "orderToCanvasIndex": {
            str(page["order"]): index for index, page in enumerate(pages)
        },
        "pages": normalized_pages,
        "structures": structures,
    }


def validate_output(
    seed: dict[str, Any],
    live: dict[str, Any],
    volume: dict[str, Any],
    manifest: dict[str, Any],
) -> None:
    expected = seed.get("expected", {})
    for name, actual in (
        ("pageCount", volume["pageCount"]),
        ("firstOrder", volume["firstOrder"]),
        ("lastOrder", volume["lastOrder"]),
    ):
        if name in expected and expected[name] != actual:
            raise SyncError(
                f"{seed['id']} {name}: expected {expected[name]}, received {actual}"
            )
    sample_order = seed.get("samplePn", volume["firstOrder"])
    sample_pn = str(sample_order)
    if sample_pn not in volume["orderToCanvasIndex"]:
        raise SyncError(f"{seed['id']} sample pn={sample_pn} is missing")
    sample_index = volume["orderToCanvasIndex"][sample_pn]
    if (
        "sampleCanvasIndex" in expected
        and sample_index != expected["sampleCanvasIndex"]
    ):
        raise SyncError(
            f"{seed['id']} pn={sample_pn}: expected canvas index "
            f"{expected['sampleCanvasIndex']}, received {sample_index}"
        )
    if (
        "sampleLabel" in expected
        and volume["pages"][sample_index]["label"] != expected["sampleLabel"]
    ):
        raise SyncError(
            f"{seed['id']} pn={sample_pn}: expected printed label "
            f"{expected['sampleLabel']!r}, received "
            f"{volume['pages'][sample_index]['label']!r}"
        )
    indexes = sorted(volume["orderToCanvasIndex"].values())
    if indexes != list(range(volume["pageCount"])):
        raise SyncError(f"{seed['id']} ORDER-to-index mapping is not bijective")
    if len(manifest["items"]) != volume["pageCount"]:
        raise SyncError(f"{seed['id']} manifest canvas count does not match volume")
    valid_orders = {page["order"] for page in volume["pages"]}
    for node in walk_ranges(volume["structures"]):
        invalid = set(node.get("orders", [])) - valid_orders
        if invalid:
            raise SyncError(f"{seed['id']} range {node['id']} has invalid ORDER(s): {invalid}")
    for page in volume["pages"]:
        parsed = urllib.parse.urlsplit(page["imageServiceId"])
        if parsed.scheme != "https" or parsed.hostname != "digilib.bbaw.de":
            raise SyncError(
                f"{seed['id']} has a non-allowlisted image service: {page['imageServiceId']}"
            )


def catalogue_item(volume: dict[str, Any], seed: dict[str, Any]) -> dict[str, Any]:
    metadata = volume["metadata"]
    contributors = metadata.get("contributors", [])
    languages = seed.get("languages") or metadata.get("languages", [])
    return {
        "id": seed.get("catalogueItemId", volume["id"]),
        "volumeId": volume["id"],
        "label": volume["label"],
        "collection": volume["collection"],
        "seriesNumber": volume["seriesNumber"],
        "authors": seed.get("authors", []),
        "editors": seed.get("editors") or contributors,
        "contributors": contributors,
        "year": metadata.get("dateIssued", ""),
        "languages": languages,
        "translationLanguages": seed.get("translationLanguages", []),
        "startPn": seed.get("samplePn", volume["firstOrder"]),
        "viewerUrl": volume["viewerUrl"],
        "manifestUrl": volume["manifestUrl"],
        "sourceUrl": volume["source"]["viewerUrl"],
    }


def sync_volume(
    seed: dict[str, Any],
    *,
    base_url: str,
    cache_dir: Path,
    offline: bool,
    refresh: bool,
    workers: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    volume_id = seed["id"]
    viewer_url = urllib.parse.urljoin(CMG_ONLINE, seed["viewerPath"])
    mets_url = urllib.parse.urljoin(CMG_ONLINE, seed["metsPath"])
    html_payload = fetch_bytes(
        viewer_url,
        cache_dir / "viewers" / f"{volume_id}.html",
        offline=offline,
        refresh=refresh,
    )
    mets_payload = fetch_bytes(
        mets_url,
        cache_dir / "mets" / f"{volume_id}.xml",
        offline=offline,
        refresh=refresh,
    )
    live = parse_live_html(decode_html(html_payload))
    mets = parse_mets(mets_payload)
    title = live["title"] or mets["metadata"]["title"] or volume_id

    pages = mets["pages"]
    for page in pages:
        basename_template = seed.get("imageBasenameTemplate")
        image_basename = (
            basename_template.format(order=page["order"]) if basename_template else None
        )
        page["imageBasename"] = (
            image_basename
            or (max_basename(page["maxHref"]) if page["maxHref"] else None)
            or f"__unresolved_order_{page['order']:06d}"
        )
        page["imageServiceId"] = image_service_id(
            live["fnDirectory"], page["maxHref"], page["imageBasename"]
        )
    manifester_cache = cache_dir / "manifester" / f"{volume_id}.json"
    unmatched = pages
    try:
        directory_manifest = fetch_bytes(
            manifester_url(live["fnDirectory"]),
            manifester_cache,
            offline=offline,
            refresh=refresh,
        )
        unmatched = enrich_pages_from_manifester(
            pages,
            directory_manifest,
            fn_directory=live["fnDirectory"],
            directory_page_count=live.get("lastPhysicalOrder"),
        )
        if unmatched and isinstance(live.get("lastPhysicalOrder"), int):
            inventory = parse_manifester(directory_manifest)
            primary_inventory = [
                label
                for label in inventory
                if not label.casefold().startswith(("x_", "x-"))
            ]
            live_last = live["lastPhysicalOrder"]
            unavailable_tail = [
                page for page in unmatched if page["order"] > live_last
            ]
            if (
                len(primary_inventory) == live_last
                and unavailable_tail
                and len(unavailable_tail) == len(unmatched)
            ):
                first_omitted = min(page["order"] for page in unavailable_tail)
                last_omitted = max(page["order"] for page in unavailable_tail)
                pages[:] = [page for page in pages if page["order"] <= live_last]
                valid_available_orders = {page["order"] for page in pages}
                filter_range_orders(mets["logicalRoot"], valid_available_orders)
                mets.setdefault("warnings", []).append(
                    "METS physical sequence includes unavailable Digilib tail "
                    f"ORDER {first_omitted}..{last_omitted}; omitted after the "
                    f"live viewer and directory inventory both ended at {live_last}"
                )
                unmatched = []
    except SyncError:
        # Old/offline caches may predate the directory-manifest optimization.
        # The verified page-level info.json path remains the fail-closed fallback.
        unmatched = pages
    if unmatched:
        enrich_pages_with_iiif(
            unmatched,
            cache_dir / "iiif" / volume_id,
            offline=offline,
            refresh=refresh,
            workers=workers,
        )
    valid_orders = {page["order"] for page in pages}
    effective_seed = dict(seed)
    effective_seed.setdefault(
        "samplePn",
        live["firstOrder"] if live.get("firstOrder") in valid_orders else pages[0]["order"],
    )
    structures = merge_structures(
        volume_id,
        mets["logicalRoot"],
        live["toc"],
        valid_orders,
        title,
    )
    manifest = build_manifest(
        effective_seed,
        title,
        mets["metadata"],
        pages,
        structures,
        base_url,
        viewer_url,
        mets_url,
    )
    volume = build_volume_record(
        effective_seed,
        title,
        mets["metadata"],
        pages,
        structures,
        base_url,
        viewer_url,
        mets_url,
    )
    volume["source"]["legacyBounds"] = {
        "defaultPn": live.get("firstOrder"),
        "lastPrintedOrder": live.get("lastOrder"),
        "overhead": live.get("overhead"),
        "lastPhysicalOrder": live.get("lastPhysicalOrder"),
        "matchesMetsPhysicalSequence": (
            live.get("lastPhysicalOrder") is None
            or live["lastPhysicalOrder"] == volume["lastOrder"]
        ),
    }
    if mets.get("warnings"):
        volume["source"]["metsWarnings"] = mets["warnings"]
    validate_output(effective_seed, live, volume, manifest)
    return volume, manifest


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument("--base-url", help="Public site root, without a trailing slash")
    parser.add_argument(
        "--scope",
        choices=("samples", "full"),
        default="samples",
        help="Configured synchronization scope (the first-pass config supports samples)",
    )
    parser.add_argument(
        "--volume",
        action="append",
        dest="volumes",
        help="Build only this configured stable volume ID (repeatable)",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--refresh", action="store_true", help="Require fresh copies of every upstream response"
    )
    mode.add_argument(
        "--offline", action="store_true", help="Read only cached upstream responses"
    )
    parser.add_argument(
        "--workers", type=int, default=8, help="Concurrent IIIF info.json requests (default: 8)"
    )
    return parser.parse_args(argv)


def load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SyncError(f"Cannot read configuration {path}: {exc}") from exc
    if value.get("schemaVersion") != 1 or not isinstance(value.get("volumes"), list):
        raise SyncError(f"Unsupported or invalid configuration: {path}")
    ids = [item.get("id") for item in value["volumes"]]
    if any(not item for item in ids) or len(ids) != len(set(ids)):
        raise SyncError("Configured volume IDs must be non-empty and unique")
    return value


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    if args.workers < 1 or args.workers > 32:
        raise SyncError("--workers must be between 1 and 32")
    config = load_config(args.config.resolve())
    config_scope = config.get("scope", "samples")
    if args.scope == "full" and config_scope != "full":
        raise SyncError(
            "The selected configuration contains the four reference samples only; "
            "use --scope samples or provide a full-scope config with --config"
        )
    base_url = (args.base_url or config.get("baseUrl") or DEFAULT_BASE_URL).rstrip("/")
    parsed_base = urllib.parse.urlsplit(base_url)
    if parsed_base.scheme != "https" or not parsed_base.netloc:
        raise SyncError(f"--base-url must be an absolute HTTPS URL: {base_url}")
    selected = set(args.volumes or [])
    configured = {item["id"]: item for item in config["volumes"]}
    unknown = selected - configured.keys()
    if unknown:
        raise SyncError(f"Unknown --volume ID(s): {', '.join(sorted(unknown))}")
    seeds = [item for item in config["volumes"] if not selected or item["id"] in selected]
    if not seeds:
        raise SyncError("No volumes selected")

    cache_dir = args.cache.resolve()
    dist_dir = args.dist.resolve()
    generated_at = utc_now()
    volumes: list[dict[str, Any]] = []
    manifests: list[dict[str, Any]] = []
    for seed in seeds:
        print(f"Syncing {seed['id']}...", flush=True)
        volume, manifest = sync_volume(
            seed,
            base_url=base_url,
            cache_dir=cache_dir,
            offline=args.offline,
            refresh=args.refresh,
            workers=args.workers,
        )
        volumes.append(volume)
        manifests.append(manifest)
        print(
            f"  {volume['pageCount']} pages, ORDER {volume['firstOrder']}..{volume['lastOrder']}",
            flush=True,
        )

    clear_generated_records(dist_dir)
    for volume, manifest in zip(volumes, manifests, strict=True):
        write_json(dist_dir / "data" / "volumes" / f"{volume['id']}.json", volume)
        write_json(dist_dir / "iiif" / volume["id"] / "manifest.json", manifest)

    catalogue = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "itemCount": len(volumes),
        "volumeCount": len(volumes),
        "items": [catalogue_item(volume, seed) for volume, seed in zip(volumes, seeds, strict=True)],
    }
    write_json(dist_dir / "data" / "catalogue.json", catalogue)
    collection = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        "id": f"{base_url}/iiif/collection.json",
        "type": "Collection",
        "label": language_map("CMG Viewer sample collection", "en"),
        "items": [
            {
                "id": volume["manifestUrl"],
                "type": "Manifest",
                "label": language_map(volume["label"]),
                "thumbnail": [manifest["thumbnail"][0]],
            }
            for volume, manifest in zip(volumes, manifests, strict=True)
        ],
    }
    write_json(dist_dir / "iiif" / "collection.json", collection)
    report = {
        "schemaVersion": 1,
        "status": "ok",
        "generatedAt": generated_at,
        "mode": "offline" if args.offline else "refresh" if args.refresh else "cache-first",
        "scope": args.scope,
        "config": str(args.config.resolve()),
        "volumeCount": len(volumes),
        "pageCount": sum(volume["pageCount"] for volume in volumes),
        "volumes": [
            {
                "id": volume["id"],
                "pageCount": volume["pageCount"],
                "firstOrder": volume["firstOrder"],
                "lastOrder": volume["lastOrder"],
                "samplePn": seed["samplePn"],
                "sampleCanvasIndex": volume["orderToCanvasIndex"][str(seed["samplePn"])],
            }
            for volume, seed in zip(volumes, seeds, strict=True)
        ],
    }
    write_json(dist_dir / "data" / "sync-report.json", report)
    print(
        f"Wrote {len(volumes)} volumes and {report['pageCount']} canvases to {dist_dir}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SyncError as exc:
        print(f"sync error: {exc}", file=sys.stderr)
        raise SystemExit(1)
