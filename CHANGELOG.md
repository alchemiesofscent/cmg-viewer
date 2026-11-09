# Changelog

Notable changes to the CMG Reader interface. Corpus data is versioned separately as `corpus-<run>-<attempt>` snapshot releases; see [docs/releasing.md](docs/releasing.md).

Versions follow [Semantic Versioning](https://semver.org/): a minor version adds reader features, a patch version fixes behaviour without adding features. Each version is tagged `v<version>` with a matching GitHub release when it reaches `main`.

## 0.2.2

- Fix Aetius, *Logos* XII (ed. Kostomiris, 1892): every page showed the scan two pages earlier, so printed page numbers appeared about 2 too high. Its Digilib directory begins with two extra duplicate title scans that the METS does not list; pages are now matched two positions further on (e.g. p. 1 → scan `Seite_111`). Original-viewer page links follow the same mapping.

## 0.2.1

- Fix Aetius, *Liber medicinalis* XIII (Athena 18, 1905): every page after the title page showed a blank placeholder. Its METS omits the ~240 blank scans that the Digilib directory still holds, so pages are now joined to Digilib by printed page number (e.g. p. 241 → scan 241) rather than physical order. Original-viewer page links follow the same mapping.

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
