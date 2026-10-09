# Reader checks and corpus snapshots

Every pull request runs the Python/JavaScript tests and browser checks with desktop and mobile-sized Chromium and WebKit. The browser corpus is deliberately synthetic, built locally with eight pages per volume. All external browser requests are blocked. This tests the actual self-hosted TIFY integration without requiring BBAW availability. Failed checks retain screenshots and traces for seven days.

Run `pnpm test` locally. To run browser tests in a normal development environment, install browsers with `pnpm exec playwright install --with-deps chromium webkit`, then run `pnpm test:browser`. The tests start their own fixture server on port 8000; stop any other server on that port first.

## Reader versions

The reader interface has a [Semantic Versioning](https://semver.org/) release number, separate from corpus snapshots. `package.json` holds the current version, and `CHANGELOG.md` must have a matching top section; the Python tests enforce this. A pull request that should ship as a new release bumps both together: a minor version for new reader features, a patch version for fixes.

When that change reaches `main`, the **Tag reader release** workflow creates the `v<version>` tag on the merge commit and a GitHub release whose notes are the changelog section. A version that is already released is skipped, so unrelated merges never retag. The build stamps the version into the About page, and `build-info.json` records it as `uiVersion` alongside the exact `uiRevision` and corpus snapshot.

## Corpus release flow

The **Refresh corpus** workflow runs monthly, manually, and when ingestion configuration changes. It synchronizes the full corpus, builds the site and runs the full artifact validator before publishing a uniquely tagged GitHub release containing `corpus.tar.gz` and `snapshot.json`. Only metadata and IIIF JSON are archived; scan images stay at BBAW. The workflow commits the snapshot's tag and SHA-256 checksum to `config/corpus-snapshot.json`, then its successful completion starts the Pages workflow.

Ordinary UI pushes restore that committed snapshot, verify the checksum, build the current interface, run the full validator and browser tests, and deploy. They do not contact BBAW for a catalogue refresh. A failed refresh leaves the previous pin and deployed site intact. Before the first snapshot exists, UI deployment is skipped while the separate bootstrap refresh runs.

`build-info.json` in the deployed site records the exact UI revision and corpus snapshot. Snapshot release tags are unique per workflow attempt; do not replace release assets. Retain older snapshots for reproducible builds and rollback.

To deploy an older corpus, run **Build and deploy GitHub Pages** manually with its published `corpus-<run>-<attempt>` tag in `snapshot_tag`. This is a one-release override. For a lasting rollback, copy that release's `snapshot.json` into `config/corpus-snapshot.json` through a reviewed commit. The saved checksum is verified on every restoration. Restored data must still pass the current full validator; incompatible snapshots fail safely.

If publication succeeds but pinning fails, the release remains available but the deployed site does not change. Resolve the failed workflow and rerun the refresh; its new attempt gets a new tag.

## Physical iPhone release check

WebKit emulation does not reproduce the iOS software keyboard or Safari browser chrome. Before considering keyboard behavior verified on hardware:

- Open a volume in portrait and landscape Safari.
- Focus page entry; confirm the entire field and Go button stay above the keyboard.
- Enter both a Roman label and an Arabic page number; submit with Go and the keyboard action.
- Dismiss the keyboard and confirm the toolbar returns to its original position.
- Tap navigation arrows quickly; confirm the page changes without browser zoom.
- Open Contents, Tools and Share; confirm controls remain reachable near safe areas.

These hardware checks are separate from automated browser results.
