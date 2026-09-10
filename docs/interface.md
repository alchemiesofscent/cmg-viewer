# Reader interface styles

The existing reader appearance is retained. `src/assets/reader-tokens.css` is the shared source for reader-specific fonts, surfaces, borders, control sizes, panel shadows and icon size. `base.css` owns the application palette and focus outline; `viewer.css` owns layout and responsive behavior. The template loads them in that order. The build gives all three stylesheets the same content-derived cache version.

| Token | Purpose |
| --- | --- |
| `--reader-font` | Native system interface font |
| `--reader-touch-size` | Standard 44px control height at the default root font size |
| `--reader-control-border`, `--reader-control-radius` | Consistent control outlines |
| `--reader-control-surface`, `--reader-toolbar-surface` | Control and toolbar backgrounds |
| `--reader-panel-surface`, `--reader-panel-radius`, `--reader-panel-shadow` | Tools panel appearance |
| `--reader-icon-size` | SVG interface icon dimensions |
| `--reader-stage-color` | Background surrounding page scans |

Use the existing `.tool-button`, `.reader-icon`, and `setupToolsMenu` disclosure helper for new reader controls. Preserve visible labels, accessible names and keyboard focus behavior. Focus styles remain shared with the catalogue. Reader styles must not change page image resolution or introduce font-dependent icon glyphs.

The compact layout keeps Contents, page navigation and Tools in the bottom bar. Tools opens above that bar on narrow screens and below it on desktop. The corpus tree stays in the Contents drawer. Mobile page entry remains 16px to avoid input-focus zoom; the visual-viewport helper handles keyboard displacement separately.

## Reading continuity and references

The reader saves the last source-page order for up to 50 volumes in this browser. Opening a volume without `pn` resumes it; explicit page links always win, including invalid links (which open the first scan). If a saved page disappears from a later snapshot, the volume opens at its default. Storage failures do not interrupt reading. The catalogue offers a separate **Resume this volume** link; its ordinary work links still open the work's starting page. Private browsing or clearing site storage may remove saved positions; positions are not shared between devices.

Page entry accepts the source's page labels (including Roman numerals) and `scan N` for a one-based image position. Duplicate labels retain the current occurrence or select the nearest one. Numeric entry retains its existing source-order fallback. Share shows page label and scan position separately and offers a selectable page citation, with a manual-copy fallback when clipboard access fails. Citations use the existing edition title and source label; when no distinct label is available, they explicitly cite the scan and source-page order rather than inventing a printed page number.

`viewer-progress.js` owns storage and initial-page precedence; `viewer-reference.js` owns page-entry resolution and citation/reference formatting; `viewer-metrics.js` owns bounded local timing records. The reader controller connects these modules to the existing UI.

Volume and manifest normalization now lives in `viewer-data.js`, including source-page mapping and contents/range resolution. It has no DOM dependency or global reader state; `viewer-values.js` provides shared value parsing. Indexed records apply only to their specified canvas, complete range definitions take precedence over reference-only objects, and circular range references terminate without losing reachable pages. Browser checks cover reading with either metadata source missing, navigation past a failed image, and retry after both sources fail.
