# Changelog

Notable changes to the CMG Reader interface. Corpus data is versioned separately as `corpus-<run>-<attempt>` snapshot releases; see [docs/releasing.md](docs/releasing.md).

Versions follow [Semantic Versioning](https://semver.org/): a minor version adds reader features, a patch version fixes behaviour without adding features. Each version is tagged `v<version>` with a matching GitHub release when it reaches `main`.

## 0.2.0

- Desktop mouse drag-to-pan: press the left button on the page and drag to move it, especially when zoomed in. Works in scroll mode and in the zoomed basic spread reader; touch gestures, scrollbars and controls are unchanged.

## 0.1.0

Baseline release: the reader as deployed before versioning was introduced (through #25).

- Catalogue with search, sorting and reading history.
- Continuous single-page reader and TIFY spread view, with a basic fallback reader.
- Touch pinch and double-tap-drag zoom; desktop Shift-wheel zoom anchored to the pointer.
- Page entry by printed label, contents, thumbnails, shareable page links and citations.
- Current-page and page-range PDF export.
- About page with credits and licences.
