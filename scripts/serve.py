#!/usr/bin/env python3
"""Serve the built GitHub Pages artifact at its project-site base path."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import posixpath
import sys
import urllib.parse


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = PROJECT_ROOT / "dist"


class PagesRequestHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, directory: str, base_path: str, **kwargs) -> None:
        self.base_path = "/" + base_path.strip("/") + "/"
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/":
            self.send_response(302)
            self.send_header("Location", self.base_path)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not parsed.path.startswith(self.base_path):
            self.send_error(404, "This server exposes the site only at " + self.base_path)
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/":
            self.send_response(302)
            self.send_header("Location", self.base_path)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not parsed.path.startswith(self.base_path):
            self.send_error(404, "This server exposes the site only at " + self.base_path)
            return
        super().do_HEAD()

    def translate_path(self, path: str) -> str:
        parsed = urllib.parse.urlsplit(path)
        request_path = urllib.parse.unquote(parsed.path, errors="surrogatepass")
        if request_path.startswith(self.base_path):
            request_path = "/" + request_path[len(self.base_path) :]
        else:
            request_path = "/__not_found__"
        request_path = posixpath.normpath(request_path)
        return super().translate_path(request_path)

    def end_headers(self) -> None:
        path = urllib.parse.urlsplit(self.path).path.casefold()
        if path.endswith((".json", ".html", ".js", ".css")) or path.endswith("/"):
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--base-path", default="/cmg-viewer/")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    dist = args.dist.resolve()
    if not (dist / "index.html").is_file():
        print(f"serve error: built site is missing at {dist}; run the sync and build first", file=sys.stderr)
        return 1
    if not 1 <= args.port <= 65535:
        print("serve error: --port must be between 1 and 65535", file=sys.stderr)
        return 1
    base_path = "/" + args.base_path.strip("/") + "/"
    handler = partial(
        PagesRequestHandler,
        directory=str(dist),
        base_path=base_path,
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {dist}", flush=True)
    print(f"Open http://{args.host}:{args.port}{base_path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
