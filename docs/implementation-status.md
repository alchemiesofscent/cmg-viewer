# Seven-step improvement checklist

| Step | Implemented and verified in code | Acceptance limit |
| --- | --- | --- |
| 1. Interface checks | Release browser suite covers desktop Chromium/WebKit and mobile Chromium/WebKit, controls, navigation, geometry and failure recovery. | Physical iPhone keyboard/rotation checklist in interface.md requires a device. |
| 2. Independent synchronization | UI builds use the checksum-validated saved corpus; corpus refresh has its own workflow. | Live upstream availability remains relevant when images load. |
| 3. Consistent interface | Shared type, spacing, icon, focus and surface tokens; compact sort direction control; drawer and keyboard layout regression coverage. | Emulation cannot certify every iOS version. |
| 4. Reading position | Per-volume local resume, recent volumes and scoped history reset; explicit links take precedence. | Local browser storage only. |
| 5. Scholarly navigation | Printed labels vs scan positions, citations, corpus author/title/shelfmark search and ordered hierarchy; reviewed metadata overrides. | Source metadata remains evidence-dependent. |
| 6. Reader loading | Bounded timing diagnostics, active-first requests, preview/decode handling and bounded retention; repeatable cold/warm desktop and shaped-mobile live benchmark workflow. | Insertion timing and pixel-memory estimates are proxies; live benchmark failures must be inspected. |
| 7. Internal separation | Separate state, data, references, progress, corpus, tools, sharing, keyboard, metrics and image lifecycle modules. | DOM/gesture/TIFY orchestration remains in viewer.js for gradual future maintenance. |

Release acceptance: inspect the exact PR revision's Reader checks, then the merged
revision's Pages deployment and published build-info.json. A green PR check alone
does not establish deployment. Live benchmark reports describe the published site,
not an unpublished PR build.
