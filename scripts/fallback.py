#!/usr/bin/env python3
"""Fail-closed ingestion for CMG legacy viewers which have no reliable METS.

The legacy PHP viewers still expose enough information to build a minimal
IIIF Presentation input:

* a human-readable title and HTML table of contents;
* the physical page-number bounds used by the old viewer; and
* a Digilib directory, whose generated Manifester response provides the exact
  image identifiers in directory order.

This module deliberately does not publish a manifest itself.  Its
``build_fallback_inputs`` result uses the same ``metadata``, ``pages`` and
``logicalRoot`` shapes consumed by :mod:`scripts.sync`, allowing the main
pipeline to use the same manifest and volume builders for METS and fallback
volumes.

All upstream responses are cached.  Offline mode never accesses the network,
and every URL used for a request or emitted as an image service is required to
be HTTPS on the BBAW allowlist.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import posixpath
import re
import string
import tempfile
import time
from typing import Any, Callable, Iterable
import urllib.error
import urllib.parse
import urllib.request


CMG_ONLINE = "https://cmg.bbaw.de/epubl/online/"
DIGILIB_ORIGIN = "https://digilib.bbaw.de"
IMAGE_API_ROOT = f"{DIGILIB_ORIGIN}/digilib/Scaler/IIIF"
MANIFEST_API_ROOT = f"{DIGILIB_ORIGIN}/digilib/Manifester/IIIF/3"
ALLOWED_HOSTS = frozenset({"cmg.bbaw.de", "digilib.bbaw.de"})
USER_AGENT = (
    "cmg-viewer-sync/0.1 "
    "(+https://github.com/alchemiesofscent/cmg-viewer; fallback ingestion)"
)

Transport = Callable[[str], bytes]


class FallbackError(RuntimeError):
    """An ambiguity or upstream error that must stop fallback publication."""


class CacheMissError(FallbackError):
    """An offline run did not have a required cached response."""


class FetchError(FallbackError):
    """A bounded HTTPS request failed."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def compact_space(value: str) -> str:
    return " ".join(html.unescape(value).split())


def stable_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug or hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


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


def _require_https_url(url: str, *, host: str | None = None) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise FallbackError(f"URL is not allowlisted HTTPS: {url}")
    if host is not None and parsed.hostname != host:
        raise FallbackError(f"URL must use {host}: {url}")
    if parsed.username or parsed.password or parsed.port not in (None, 443):
        raise FallbackError(f"URL contains unexpected authority components: {url}")
    if parsed.fragment or any(ord(char) < 32 for char in url):
        raise FallbackError(f"URL contains an unsafe fragment or control character: {url}")
    return url


def _upgrade_known_url(url: str, *, host: str) -> str:
    """Upgrade a hard-coded legacy HTTP URL without accepting a new host."""

    parsed = urllib.parse.urlsplit(html.unescape(url.strip()))
    if parsed.scheme not in {"http", "https"} or parsed.hostname != host:
        raise FallbackError(f"Unexpected legacy URL: {url}")
    if parsed.username or parsed.password or parsed.port not in (None, 80, 443):
        raise FallbackError(f"Unexpected legacy URL authority: {url}")
    upgraded = urllib.parse.urlunsplit(
        ("https", host, parsed.path, parsed.query, parsed.fragment)
    )
    return _require_https_url(upgraded, host=host)


def _read_bounded(path: Path, max_bytes: int) -> bytes:
    try:
        size = path.stat().st_size
        if size > max_bytes:
            raise FallbackError(f"Cached response is larger than {max_bytes} bytes: {path}")
        return path.read_bytes()
    except OSError as exc:
        raise FallbackError(f"Cannot read cached response {path}: {exc}") from exc


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
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


def _download(
    url: str,
    *,
    max_bytes: int,
    timeout: float = 40.0,
    attempts: int = 2,
) -> bytes:
    _require_https_url(url)
    if attempts < 1 or attempts > 8:
        raise FetchError("Download attempts must be between 1 and 8")
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/html;q=0.9, */*;q=0.5",
        },
    )
    retryable_statuses = {500, 502, 503, 504}
    payload: bytes | None = None
    last_error: FetchError | None = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                final_url = response.geturl()
                _require_https_url(final_url)
                if response.status != 200:
                    raise FetchError(
                        f"GET {url} returned HTTP {response.status}",
                        status=response.status,
                    )
                payload = response.read(max_bytes + 1)
            break
        except urllib.error.HTTPError as exc:
            last_error = FetchError(
                f"GET {url} returned HTTP {exc.code}", status=exc.code
            )
            if exc.code not in retryable_statuses or attempt == attempts:
                raise last_error from exc
        except (OSError, urllib.error.URLError) as exc:
            raise FetchError(f"Unable to fetch {url}: {exc}") from exc
        except FetchError as exc:
            last_error = exc
            if exc.status not in retryable_statuses or attempt == attempts:
                raise

        # Stable per-URL jitter prevents concurrent page retries from hitting
        # the Digilib service in lockstep after a brief 5xx response.
        jitter = int(hashlib.sha1(url.encode("utf-8")).hexdigest()[:2], 16) / 1024
        time.sleep(0.5 + jitter)

    if payload is None:
        raise last_error or FetchError(f"Unable to fetch {url}")
    if len(payload) > max_bytes:
        raise FetchError(f"GET {url} exceeded the {max_bytes}-byte response limit")
    return payload


def fetch_cached(
    url: str,
    cache_path: Path,
    *,
    offline: bool,
    refresh: bool,
    max_bytes: int,
    transport: Transport | None = None,
) -> bytes:
    """Read a cache-first response, or fetch and atomically populate the cache."""

    _require_https_url(url)
    if offline:
        if not cache_path.is_file():
            raise CacheMissError(f"Offline cache miss for {url}: {cache_path}")
        return _read_bounded(cache_path, max_bytes)
    if cache_path.is_file() and not refresh:
        return _read_bounded(cache_path, max_bytes)
    payload = (
        transport(url)
        if transport is not None
        else _download(url, max_bytes=max_bytes)
    )
    if not isinstance(payload, bytes):
        raise FetchError(f"Transport returned a non-bytes response for {url}")
    if len(payload) > max_bytes:
        raise FetchError(f"GET {url} exceeded the {max_bytes}-byte response limit")
    _atomic_write(cache_path, payload)
    return payload


class _LegacyViewerParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ul_depth = 0
        self.toc_root_depth: int | None = None
        self.current_anchor: dict[str, Any] | None = None
        self.toc_anchors: list[dict[str, Any]] = []
        self.in_h1 = False
        self.h1_done = False
        self.h1_parts: list[str] = []
        self.in_title = False
        self.title_parts: list[str] = []
        self.in_script = False
        self.script_parts: list[str] = []

    def _finish_anchor(self) -> None:
        if self.current_anchor is None:
            return
        label = compact_space("".join(self.current_anchor.pop("parts")))
        if label:
            self.current_anchor["label"] = label
            self.toc_anchors.append(self.current_anchor)
        self.current_anchor = None

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        tag = tag.casefold()
        attributes = {key.casefold(): value or "" for key, value in attrs}
        if tag == "br":
            if self.current_anchor is not None:
                self.current_anchor["parts"].append(" ")
            if self.in_h1:
                self.h1_parts.append(" ")
            if self.in_title:
                self.title_parts.append(" ")
        elif tag == "ul":
            self.ul_depth += 1
            if attributes.get("id", "").casefold() == "inhaltsverzeichnis":
                self.toc_root_depth = self.ul_depth
        elif (
            tag == "a"
            and self.toc_root_depth is not None
            and self.ul_depth >= self.toc_root_depth
        ):
            self._finish_anchor()
            self.current_anchor = {
                "href": attributes.get("href", ""),
                "parts": [],
                "depth": self.ul_depth - self.toc_root_depth,
            }
        elif tag == "h1" and not self.h1_done:
            self.in_h1 = True
        elif tag == "title" and not self.title_parts:
            self.in_title = True
        elif tag == "script":
            self.in_script = True

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag == "a":
            self._finish_anchor()
        elif tag == "ul":
            if self.toc_root_depth == self.ul_depth:
                self.toc_root_depth = None
            self.ul_depth = max(0, self.ul_depth - 1)
        elif tag == "h1" and self.in_h1:
            self.in_h1 = False
            self.h1_done = True
        elif tag == "title":
            self.in_title = False
        elif tag == "script":
            self.in_script = False

    def handle_data(self, data: str) -> None:
        if self.current_anchor is not None:
            self.current_anchor["parts"].append(data)
        if self.in_h1:
            self.h1_parts.append(data)
        if self.in_title:
            self.title_parts.append(data)
        if self.in_script:
            self.script_parts.append(data)


def _active_javascript(parts: Iterable[str]) -> str:
    source = "\n".join(parts)
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return "\n".join(
        line for line in source.splitlines() if not re.match(r"^\s*//", line)
    )


def _unique_assignment(source: str, name: str, pattern: str) -> str | None:
    matches = [match.group(1) for match in re.finditer(pattern, source, re.I)]
    values = list(dict.fromkeys(matches))
    if len(values) > 1:
        raise FallbackError(f"Legacy viewer has conflicting {name} assignments: {values}")
    return values[0] if values else None


def _string_assignment(source: str, name: str) -> str | None:
    return _unique_assignment(
        source,
        name,
        rf"(?:^|[;\n])\s*(?:var\s+|let\s+|const\s+)?{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]",
    )


def _integer_assignment(source: str, name: str) -> int | None:
    value = _unique_assignment(
        source,
        name,
        rf"(?:^|[;\n])\s*(?:var\s+|let\s+|const\s+)?{re.escape(name)}\s*=\s*(\d+)\s*(?:;|$)",
    )
    return int(value) if value is not None else None


def _safe_fn_directory(scaler_url: str) -> tuple[str, str]:
    scaler_url = _upgrade_known_url(scaler_url, host="digilib.bbaw.de")
    parsed = urllib.parse.urlsplit(scaler_url)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    values = query.get("fn")
    if not values or len(set(values)) != 1:
        raise FallbackError(f"Legacy Scaler URL has no unique fn parameter: {scaler_url}")
    fn_value = urllib.parse.unquote(values[0])
    if "\\" in fn_value or not fn_value.startswith("/silo10/cmg/"):
        raise FallbackError(f"Unexpected Digilib fn path: {fn_value}")
    segments = [segment for segment in fn_value.split("/") if segment]
    if not segments or any(segment in {".", ".."} for segment in segments):
        raise FallbackError(f"Unsafe Digilib fn path: {fn_value}")
    if not fn_value.endswith("/"):
        fn_value = posixpath.dirname(fn_value).rstrip("/") + "/"
    return scaler_url, fn_value


def _safe_basename(value: str) -> str:
    value = urllib.parse.unquote(value).strip()
    if (
        not value
        or value in {".", ".."}
        or "/" in value
        or "\\" in value
        or len(value) > 255
        or any(ord(char) < 32 for char in value)
    ):
        raise FallbackError(f"Unsafe Digilib image basename: {value!r}")
    return value


def _prefix_signals(
    *, viewer_id: str | None, viewer_path: str | None, fn_directory: str, urlx: str | None
) -> list[dict[str, Any]]:
    candidates: list[tuple[str, str]] = []
    normalized_urlx: str | None = None
    if urlx:
        normalized_urlx = _upgrade_known_url(urlx, host="cmg.bbaw.de")
        path_basename = posixpath.basename(
            urllib.parse.unquote(urllib.parse.urlsplit(normalized_urlx).path)
        )
        if path_basename:
            candidates.append((path_basename, "urlx"))
    if viewer_id:
        candidates.append((f"{viewer_id}_", "viewerId"))
    if viewer_path:
        candidates.append((f"{posixpath.splitext(posixpath.basename(viewer_path))[0]}_", "viewerPath"))
    directory_segments = [segment for segment in fn_directory.split("/") if segment]
    for segment in reversed(directory_segments[-2:]):
        candidates.append((f"{segment}_", "fnDirectory"))

    grouped: dict[str, list[str]] = {}
    for prefix, source in candidates:
        prefix = _safe_basename(prefix)
        grouped.setdefault(prefix, [])
        if source not in grouped[prefix]:
            grouped[prefix].append(source)
    return [
        {"prefix": prefix, "sources": sources}
        for prefix, sources in grouped.items()
    ]


def parse_fallback_html(
    source: str,
    *,
    viewer_id: str | None = None,
    viewer_path: str | None = None,
) -> dict[str, Any]:
    """Parse active legacy viewer configuration and its HTML-only contents."""

    parser = _LegacyViewerParser()
    parser.feed(source)
    parser.close()
    script = _active_javascript(parser.script_parts)

    raw_url = _string_assignment(script, "url")
    if raw_url is None:
        raise FallbackError("Legacy viewer has no active Digilib `url` assignment")
    scaler_url, fn_directory = _safe_fn_directory(raw_url)
    raw_urlx = _string_assignment(script, "urlx")
    pdf_url_prefix = (
        _upgrade_known_url(raw_urlx, host="cmg.bbaw.de") if raw_urlx else None
    )

    anf_real = _integer_assignment(script, "anf_real")
    ende_real = _integer_assignment(script, "ende_real")
    overhead = _integer_assignment(script, "overhead")
    if anf_real is None or ende_real is None or overhead is None:
        raise FallbackError(
            "Legacy viewer must define anf_real, ende_real and overhead as integers"
        )
    if anf_real < 1 or ende_real < 1 or overhead < 0:
        raise FallbackError(
            f"Invalid legacy bounds: anf_real={anf_real}, "
            f"ende_real={ende_real}, overhead={overhead}"
        )

    toc: list[dict[str, Any]] = []
    for anchor in parser.toc_anchors:
        href = html.unescape(anchor["href"])
        js_match = re.search(r"InhaltInFrame\(\s*(\d+)", href, re.I)
        page_match = re.search(r"(?:\?|&)p=(\d+)(?:=(\d+))?", href, re.I)
        if js_match:
            orders = [int(js_match.group(1))]
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

    title = compact_space("".join(parser.h1_parts)) or compact_space(
        "".join(parser.title_parts)
    )
    signals = _prefix_signals(
        viewer_id=viewer_id,
        viewer_path=viewer_path,
        fn_directory=fn_directory,
        urlx=raw_urlx,
    )
    return {
        "title": title,
        "scalerUrl": scaler_url,
        "fnDirectory": fn_directory,
        "fnIdentifier": fn_directory.strip("/").replace("/", "!"),
        "pdfUrlPrefix": pdf_url_prefix,
        "urlx": raw_urlx,
        # Compatibility names used by the existing METS synchronizer.
        "firstOrder": anf_real,
        "lastOrder": ende_real,
        "lastPhysicalOrder": ende_real + overhead,
        "anfReal": anf_real,
        "endeReal": ende_real,
        "overhead": overhead,
        "physicalCountCandidates": list(
            dict.fromkeys([ende_real + overhead, ende_real])
        ),
        "basenameSignals": signals,
        "toc": toc,
    }


def _identifier_from_service_url(url: str) -> str:
    _require_https_url(url, host="digilib.bbaw.de")
    path = urllib.parse.urlsplit(url).path.rstrip("/")
    match = re.search(r"/Scaler/IIIF(?:/[123])?/([^/]+)$", path, re.I)
    if match is None:
        raise FallbackError(f"Unrecognized Digilib IIIF service URL: {url}")
    identifier = urllib.parse.unquote(match.group(1))
    if "/" in identifier or "\\" in identifier:
        raise FallbackError(f"Unsafe Digilib IIIF identifier: {identifier}")
    segments = identifier.split("!")
    if any(not item or item in {".", ".."} for item in segments):
        raise FallbackError(f"Unsafe Digilib IIIF identifier: {identifier}")
    return identifier


def image_service_id(fn_directory: str, image_basename: str) -> str:
    image_basename = _safe_basename(image_basename)
    directory = fn_directory.strip("/").replace("/", "!")
    if not directory or ".." in directory.split("!"):
        raise FallbackError(f"Unsafe Digilib directory: {fn_directory}")
    identifier = f"{directory}!{image_basename}"
    return f"{IMAGE_API_ROOT}/{urllib.parse.quote(identifier, safe='!._~-')}"


def manifester_url(fn_directory: str) -> str:
    identifier = fn_directory.strip("/").replace("/", "!")
    if not identifier or ".." in identifier.split("!"):
        raise FallbackError(f"Unsafe Digilib directory: {fn_directory}")
    return f"{MANIFEST_API_ROOT}/{urllib.parse.quote(identifier, safe='!._~-')}"


def _canvas_service_urls(canvas: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for annotation_page in canvas.get("items", []):
        if not isinstance(annotation_page, dict):
            continue
        for annotation in annotation_page.get("items", []):
            if not isinstance(annotation, dict):
                continue
            bodies = annotation.get("body", [])
            if isinstance(bodies, dict):
                bodies = [bodies]
            for body in bodies if isinstance(bodies, list) else []:
                if not isinstance(body, dict):
                    continue
                services = body.get("service", [])
                if isinstance(services, dict):
                    services = [services]
                for service in services if isinstance(services, list) else []:
                    if isinstance(service, dict):
                        value = service.get("id") or service.get("@id")
                        if isinstance(value, str):
                            urls.append(value)
    return urls


def parse_manifester(payload: bytes, fn_directory: str) -> list[dict[str, Any]]:
    """Extract exact image identifiers from a Digilib Presentation 3 response.

    BBAW's generated manifest currently advertises proxy-root URLs without the
    ``/digilib`` path component.  Those URLs are treated only as identifier
    evidence and are normalized to the known working versionless Image API v2
    root before being returned.
    """

    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FallbackError(f"Invalid Digilib Manifester JSON: {exc}") from exc
    if not isinstance(value, dict) or value.get("type") != "Manifest":
        raise FallbackError("Digilib Manifester response is not a Presentation 3 Manifest")
    canvases = value.get("items")
    if not isinstance(canvases, list) or not canvases:
        raise FallbackError("Digilib Manifester response has no canvases")

    directory_identifier = fn_directory.strip("/").replace("/", "!")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for order, canvas in enumerate(canvases, start=1):
        if not isinstance(canvas, dict) or canvas.get("type") != "Canvas":
            raise FallbackError(f"Manifester item {order} is not a Canvas")
        identifiers = {
            _identifier_from_service_url(url) for url in _canvas_service_urls(canvas)
        }
        if len(identifiers) != 1:
            raise FallbackError(
                f"Manifester Canvas {order} has {len(identifiers)} distinct image services"
            )
        identifier = identifiers.pop()
        expected_prefix = f"{directory_identifier}!"
        if not identifier.startswith(expected_prefix):
            raise FallbackError(
                f"Manifester Canvas {order} escapes {fn_directory}: {identifier}"
            )
        basename = _safe_basename(identifier[len(expected_prefix) :])
        if identifier in seen:
            raise FallbackError(f"Duplicate Manifester image identifier: {identifier}")
        seen.add(identifier)
        width = canvas.get("width")
        height = canvas.get("height")
        result.append(
            {
                "directoryOrder": order,
                "imageBasename": basename,
                "imageServiceId": image_service_id(fn_directory, basename),
                "manifestWidth": width if isinstance(width, int) else None,
                "manifestHeight": height if isinstance(height, int) else None,
            }
        )
    return result


def _numbered_basename(value: str) -> tuple[str, int, int] | None:
    match = re.fullmatch(r"(.+?)(\d+)", value)
    if match is None:
        return None
    return match.group(1), int(match.group(2)), len(match.group(2))


def _coherent_prefix_run(pages: list[dict[str, Any]]) -> bool:
    parsed = [_numbered_basename(page["imageBasename"]) for page in pages]
    if not pages or any(item is None for item in parsed):
        return False
    values = [item for item in parsed if item is not None]
    prefix, first_number, width = values[0]
    return all(
        item_prefix == prefix
        and item_width == width
        and number == first_number + index
        for index, (item_prefix, number, item_width) in enumerate(values)
    )


def select_manifester_pages(
    pages: list[dict[str, Any]], live: dict[str, Any], entry: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Select the sequence exposed by the old viewer from a directory listing.

    ``ende_real`` is not consistent across the legacy catalogue: depending on
    the page it is either the physical image count or the Arabic-page count to
    which ``overhead`` must be added.  Both documented interpretations are
    accepted only when the directory inventory proves one of them.  Extra
    directory files may be excluded only when a single, contiguous, numbered
    prefix run starts at directory position one, has a prefix explicitly
    signalled by the page, and matches a declared count.

    Truly stale counts require the explicit ``fallbackPageCount`` override.
    """

    if not pages:
        raise FallbackError("Cannot select from an empty Digilib inventory")
    candidates = list(live["physicalCountCandidates"])
    override_count = entry.get("fallbackPageCount")
    if override_count is not None:
        if not isinstance(override_count, int) or override_count < 1:
            raise FallbackError("fallbackPageCount must be a positive integer")
        candidates = [override_count]

    explicit_prefix = entry.get("fallbackImagePrefix")
    signal_prefixes = {item["prefix"] for item in live["basenameSignals"]}
    if explicit_prefix is not None:
        signal_prefixes = {_safe_basename(explicit_prefix)}

    selections: list[tuple[list[dict[str, Any]], str]] = []
    if len(pages) in candidates:
        selections.append((pages, "complete-directory"))

    for count in candidates:
        if count >= len(pages):
            continue
        prefix_pages = pages[:count]
        if not _coherent_prefix_run(prefix_pages):
            continue
        numbered = _numbered_basename(prefix_pages[0]["imageBasename"])
        assert numbered is not None
        prefix = numbered[0]
        if prefix not in signal_prefixes:
            continue
        next_page = pages[count]
        next_numbered = _numbered_basename(next_page["imageBasename"])
        if next_numbered is not None and next_numbered[0] == prefix:
            continue
        selections.append((prefix_pages, f"signalled-prefix:{prefix}"))

    unique: dict[tuple[str, ...], tuple[list[dict[str, Any]], str]] = {}
    for selected, mode in selections:
        unique.setdefault(
            tuple(page["imageServiceId"] for page in selected), (selected, mode)
        )
    if len(unique) != 1:
        counts = ", ".join(str(item) for item in candidates)
        raise FallbackError(
            f"Cannot select one safe page sequence from {len(pages)} Digilib images "
            f"using legacy count candidate(s) {counts}; add fallbackPageCount"
            " (and fallbackImagePrefix if the directory contains multiple series)"
        )
    selected, mode = next(iter(unique.values()))
    normalized = []
    for order, page in enumerate(selected, start=1):
        normalized.append({**page, "order": order})
    return normalized, {
        "mode": mode,
        "directoryImageCount": len(pages),
        "selectedPageCount": len(normalized),
        "legacyCountCandidates": live["physicalCountCandidates"],
        "overridden": override_count is not None or explicit_prefix is not None,
    }


def _validate_template(template: str) -> None:
    formatter = string.Formatter()
    for literal, field, format_spec, conversion in formatter.parse(template):
        del literal
        if field is None:
            continue
        if field not in {"order", "number"} or conversion is not None:
            raise FallbackError(
                "fallback image templates may contain only {order} and {number}"
            )
        if format_spec and re.fullmatch(r"0?\d*d", format_spec) is None:
            raise FallbackError(f"Unsafe fallback image template format: {format_spec}")


def discover_pattern_pages(
    live: dict[str, Any],
    entry: dict[str, Any],
    *,
    page_count: int,
    cache_dir: Path,
    offline: bool,
    refresh: bool,
    transport: Transport | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Discover one simple numbered filename pattern with bounded probes.

    This is a secondary path for installations where Manifester is unavailable.
    It never enumerates arbitrary filenames: prefixes must come from ``urlx``,
    the viewer ID/path, the Digilib directory, or an explicit override.  A
    candidate must resolve at its first, middle and last pages and must *not*
    resolve at the next filename.  Ambiguous candidates stop the build.
    """

    if page_count < 1:
        raise FallbackError("page_count must be positive")
    if offline:
        raise CacheMissError(
            "Pattern discovery requires the cached Manifester response in offline mode"
        )

    explicit_template = entry.get("fallbackImageBasenameTemplate")
    candidate_specs: list[tuple[str, int, int]] = []
    if explicit_template:
        if not isinstance(explicit_template, str):
            raise FallbackError("fallbackImageBasenameTemplate must be a string")
        _validate_template(explicit_template)
        offsets = [int(entry.get("fallbackImageNumberOffset", 0))]
        templates = [explicit_template]
    else:
        prefixes = [item["prefix"] for item in live["basenameSignals"]]
        explicit_prefix = entry.get("fallbackImagePrefix")
        if explicit_prefix is not None:
            prefixes = [_safe_basename(explicit_prefix)]
        widths = entry.get("fallbackNumberWidths", [4, 5, 6])
        offsets = entry.get("fallbackImageNumberOffsets", [0, 1, -1])
        if (
            not isinstance(widths, list)
            or not widths
            or any(not isinstance(item, int) or item < 1 or item > 8 for item in widths)
            or not isinstance(offsets, list)
            or not offsets
            or any(not isinstance(item, int) or abs(item) > 1000 for item in offsets)
        ):
            raise FallbackError("Invalid fallback pattern width/offset configuration")
        templates = [f"{prefix}{{number:0{width}d}}" for prefix in prefixes for width in widths]

    for template in templates:
        _validate_template(template)
        for offset in offsets:
            candidate_specs.append((template, offset, page_count))

    def basename(template: str, offset: int, order: int) -> str:
        number = order + offset
        if number < 0:
            raise FallbackError("Fallback image pattern generated a negative number")
        return _safe_basename(template.format(order=order, number=number))

    anchors = sorted({1, (page_count + 1) // 2, page_count})
    matches: dict[tuple[str, ...], tuple[str, int]] = {}
    for template, offset, _count in candidate_specs:
        try:
            services = [
                image_service_id(live["fnDirectory"], basename(template, offset, order))
                for order in anchors
            ]
            for service in services:
                digest = hashlib.sha256(service.encode("utf-8")).hexdigest()
                fetch_info(
                    service,
                    cache_dir / "discovery" / f"{digest}.json",
                    offline=False,
                    refresh=refresh,
                    transport=transport,
                )
            next_service = image_service_id(
                live["fnDirectory"], basename(template, offset, page_count + 1)
            )
            digest = hashlib.sha256(next_service.encode("utf-8")).hexdigest()
            try:
                fetch_info(
                    next_service,
                    cache_dir / "discovery" / f"{digest}.json",
                    offline=False,
                    refresh=refresh,
                    transport=transport,
                )
            except FetchError as exc:
                if exc.status not in {400, 404}:
                    raise
            else:
                continue
        except (FetchError, FallbackError):
            continue
        all_services = tuple(
            image_service_id(
                live["fnDirectory"], basename(template, offset, order)
            )
            for order in range(1, page_count + 1)
        )
        matches.setdefault(all_services, (template, offset))

    if len(matches) != 1:
        raise FallbackError(
            f"Numbered filename discovery found {len(matches)} safe patterns; "
            "cache Manifester or add an explicit fallback image template"
        )
    services, (template, offset) = next(iter(matches.items()))
    pages = [
        {
            "order": order,
            "directoryOrder": order,
            "imageBasename": basename(template, offset, order),
            "imageServiceId": service,
        }
        for order, service in enumerate(services, start=1)
    ]
    return pages, {
        "mode": "numbered-pattern",
        "selectedPageCount": page_count,
        "template": template,
        "offset": offset,
        "overridden": explicit_template is not None,
    }


def fetch_info(
    service_id: str,
    cache_path: Path,
    *,
    offline: bool,
    refresh: bool,
    transport: Transport | None = None,
) -> dict[str, Any]:
    expected_identifier = _identifier_from_service_url(service_id)
    info_url = f"{service_id}/info.json"
    payload = fetch_cached(
        info_url,
        cache_path,
        offline=offline,
        refresh=refresh,
        max_bytes=512 * 1024,
        transport=transport,
    )
    try:
        info = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FallbackError(f"Invalid IIIF info.json for {service_id}: {exc}") from exc
    if not isinstance(info, dict):
        raise FallbackError(f"IIIF info.json is not an object: {info_url}")
    width = info.get("width")
    height = info.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1:
        raise FallbackError(f"IIIF info.json has invalid dimensions: {info_url}")
    advertised = info.get("@id") or info.get("id")
    if not isinstance(advertised, str):
        raise FallbackError(f"IIIF info.json has no service ID: {info_url}")
    if _identifier_from_service_url(advertised) != expected_identifier:
        raise FallbackError(f"IIIF info.json advertises a different image: {info_url}")
    context = info.get("@context")
    if not isinstance(context, str) or "/api/image/2/" not in context:
        raise FallbackError(f"IIIF service is not Image API v2: {info_url}")
    return {"width": width, "height": height, "profile": info.get("profile")}


def _roman(number: int) -> str:
    if number < 1 or number > 3999:
        return str(number)
    values = (
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
        (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
        (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    )
    result: list[str] = []
    for value, glyph in values:
        while number >= value:
            result.append(glyph)
            number -= value
    return "".join(result)


def fallback_page_label(order: int, overhead: int) -> str:
    return _roman(order) if order <= overhead else str(order - overhead)


def build_html_logical_root(
    volume_id: str,
    title: str,
    toc: list[dict[str, Any]],
    valid_orders: set[int],
) -> dict[str, Any]:
    root: dict[str, Any] = {
        "id": f"{volume_id}-contents",
        "label": title or volume_id,
        "type": "monograph",
        "orders": [],
        "items": [],
        "provenance": ["html"],
    }
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
    seen: set[tuple[int, str, tuple[int, ...]]] = set()
    for index, item in enumerate(toc, start=1):
        invalid = set(item["orders"]) - valid_orders
        if invalid:
            raise FallbackError(
                f"HTML contents entry {item['label']!r} refers to missing ORDER(s) "
                f"{sorted(invalid)}"
            )
        depth = max(0, int(item.get("depth", 0)))
        key = (depth, compact_space(item["label"]).casefold(), tuple(item["orders"]))
        if key in seen:
            continue
        seen.add(key)
        node = {
            "id": (
                f"html-{volume_id}-{stable_slug(item['label'])}-"
                f"{item['orders'][0]}-{index}"
            ),
            "label": item["label"],
            "type": "section",
            "orders": list(item["orders"]),
            "items": [],
            "provenance": ["html"],
            "selection": item["selection"],
        }
        while stack and stack[-1][0] >= depth:
            stack.pop()
        parent = stack[-1][1] if stack else root
        parent["items"].append(node)
        stack.append((depth, node))
    return root


def enrich_pages(
    pages: list[dict[str, Any]],
    cache_dir: Path,
    *,
    overhead: int,
    offline: bool,
    refresh: bool,
    workers: int,
    transport: Transport | None = None,
) -> None:
    if workers < 1 or workers > 32:
        raise FallbackError("workers must be between 1 and 32")

    def validate(page: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        info = fetch_info(
            page["imageServiceId"],
            cache_dir / f"{page['order']:06d}.json",
            offline=offline,
            refresh=refresh,
            transport=transport,
        )
        return page, info

    errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(validate, page): page for page in pages}
        for future in concurrent.futures.as_completed(futures):
            page = futures[future]
            try:
                item, info = future.result()
                item["width"] = info["width"]
                item["height"] = info["height"]
                item["label"] = fallback_page_label(item["order"], overhead)
                item["physicalId"] = f"fallback_phys_{item['order']:06d}"
                item["maxFileId"] = f"fallback_max_{item['order']:06d}"
                item["maxHref"] = f"{item['imageServiceId']}/full/full/0/default.jpg"
            except BaseException as exc:
                errors.append(f"ORDER {page['order']}: {exc}")
    if errors:
        detail = "\n  - ".join(errors[:12])
        suffix = "" if len(errors) <= 12 else f"\n  - ...and {len(errors) - 12} more"
        raise FallbackError(f"Fallback IIIF validation failed:\n  - {detail}{suffix}")


def _safe_viewer_entry(entry: dict[str, Any]) -> tuple[str, str]:
    viewer_id = entry.get("viewerId") or entry.get("id")
    viewer_path = entry.get("viewerPath")
    if not isinstance(viewer_id, str) or re.fullmatch(r"[A-Za-z0-9._-]+", viewer_id) is None:
        raise FallbackError(f"Unsafe or missing fallback viewerId: {viewer_id!r}")
    if (
        not isinstance(viewer_path, str)
        or posixpath.basename(viewer_path) != viewer_path
        or not viewer_path.casefold().endswith(".php")
        or re.fullmatch(r"[A-Za-z0-9._-]+", viewer_path) is None
    ):
        raise FallbackError(f"Unsafe or missing fallback viewerPath: {viewer_path!r}")
    return viewer_id, viewer_path


def load_fallback_config(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FallbackError(f"Cannot read fallback configuration {path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise FallbackError(f"Unsupported fallback configuration: {path}")
    entries = value.get("fallbacks")
    if not isinstance(entries, list):
        raise FallbackError(f"Fallback configuration has no fallback list: {path}")
    ids: set[str] = set()
    paths: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise FallbackError("Each fallback configuration entry must be an object")
        viewer_id, viewer_path = _safe_viewer_entry(entry)
        if viewer_id in ids or viewer_path.casefold() in paths:
            raise FallbackError(f"Duplicate fallback viewer: {viewer_id}")
        ids.add(viewer_id)
        paths.add(viewer_path.casefold())
    expected = value.get("expectedCounts", {}).get("fallbackViewers")
    if expected is not None and expected != len(entries):
        raise FallbackError(
            f"Expected {expected} fallback viewers but configuration has {len(entries)}"
        )
    return entries


def build_fallback_inputs(
    entry: dict[str, Any],
    *,
    cache_dir: Path,
    offline: bool,
    refresh: bool,
    workers: int = 8,
    transport: Transport | None = None,
    allow_pattern_discovery: bool = True,
) -> dict[str, Any]:
    """Build verified sync-compatible inputs for one configured fallback."""

    viewer_id, viewer_path = _safe_viewer_entry(entry)
    viewer_url = urllib.parse.urljoin(CMG_ONLINE, viewer_path)
    _require_https_url(viewer_url, host="cmg.bbaw.de")
    html_payload = fetch_cached(
        viewer_url,
        cache_dir / "viewers" / f"{viewer_id}.html",
        offline=offline,
        refresh=refresh,
        max_bytes=4 * 1024 * 1024,
        transport=transport,
    )
    live = parse_fallback_html(
        decode_html(html_payload), viewer_id=viewer_id, viewer_path=viewer_path
    )
    if not live["title"]:
        live["title"] = viewer_id

    discovery_url = manifester_url(live["fnDirectory"])
    try:
        manifest_payload = fetch_cached(
            discovery_url,
            cache_dir / "manifester" / f"{viewer_id}.json",
            offline=offline,
            refresh=refresh,
            max_bytes=64 * 1024 * 1024,
            transport=transport,
        )
    except FetchError as exc:
        if not allow_pattern_discovery or exc.status not in {400, 404}:
            raise
        override_count = entry.get("fallbackPageCount")
        count_candidates = (
            [override_count] if override_count is not None else live["physicalCountCandidates"]
        )
        discovered: list[tuple[list[dict[str, Any]], dict[str, Any]]] = []
        for count in count_candidates:
            try:
                discovered.append(
                    discover_pattern_pages(
                        live,
                        entry,
                        page_count=count,
                        cache_dir=cache_dir,
                        offline=offline,
                        refresh=refresh,
                        transport=transport,
                    )
                )
            except FallbackError:
                continue
        unique = {
            tuple(page["imageServiceId"] for page in pages): (pages, selection)
            for pages, selection in discovered
        }
        if len(unique) != 1:
            raise FallbackError(
                f"Manifester is unavailable and no unique numbered pattern was found for {viewer_id}"
            ) from exc
        pages, selection = next(iter(unique.values()))
        discovery_url = None
    else:
        inventory = parse_manifester(manifest_payload, live["fnDirectory"])
        pages, selection = select_manifester_pages(inventory, live, entry)

    enrich_pages(
        pages,
        cache_dir / "iiif" / viewer_id,
        overhead=live["overhead"],
        offline=offline,
        refresh=refresh,
        workers=workers,
        transport=transport,
    )
    valid_orders = {page["order"] for page in pages}
    if live["anfReal"] not in valid_orders:
        raise FallbackError(
            f"Legacy default anf_real={live['anfReal']} is outside the selected page sequence"
        )
    logical_root = build_html_logical_root(
        viewer_id, live["title"], live["toc"], valid_orders
    )
    metadata = {
        "title": live["title"],
        "contributors": [],
        "dateIssued": "",
        "languages": [],
    }
    return {
        "title": live["title"],
        "metadata": metadata,
        "pages": pages,
        "logicalRoot": logical_root,
        "live": live,
        "source": {
            "kind": "legacy-html-fallback",
            "viewerUrl": viewer_url,
            "metsUrl": None,
            "imageProvider": f"{DIGILIB_ORIGIN}/",
            "discoveryManifestUrl": discovery_url,
        },
        "selection": selection,
    }


__all__ = [
    "ALLOWED_HOSTS",
    "CacheMissError",
    "FallbackError",
    "FetchError",
    "build_fallback_inputs",
    "build_html_logical_root",
    "decode_html",
    "discover_pattern_pages",
    "fallback_page_label",
    "fetch_cached",
    "fetch_info",
    "image_service_id",
    "load_fallback_config",
    "manifester_url",
    "parse_fallback_html",
    "parse_manifester",
    "select_manifester_pages",
]
