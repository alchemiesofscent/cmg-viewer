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
