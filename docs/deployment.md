# GitHub Pages deployment

The production site is built and deployed by `.github/workflows/deploy-pages.yml`. In repository settings, choose **Settings → Pages → Build and deployment → GitHub Actions** as the Pages source. No publishing branch or committed `dist/` directory is required.

UI deployments run on pushes to `main`, manual runs on `main`, and successful completion of the separate **Refresh corpus** workflow. Other branches cannot publish the public site.

Each UI release installs pinned dependencies, runs Python/JavaScript tests, restores a checksum-pinned corpus snapshot, builds the static site, validates the full artifact, and runs browser checks. Only then is the Pages artifact uploaded and deployed. UI deployments no longer synchronize BBAW metadata.

The independent refresh workflow runs at 03:17 UTC on the first day of each month, manually on `main`, or after ingestion code/configuration changes. It publishes a full validated snapshot and commits its pin and `data/last-successful-sync.json` marker. A failed refresh leaves the previous pin and public site intact. The first release after introducing snapshots waits for this independent bootstrap refresh to finish.

Only the refresh workflow has `contents: write` for publishing snapshots and their pins. The deployment workflow uses the `github-pages` environment and OIDC with `pages: write` and `id-token: write`. Generated corpus data, scan images and caches are never committed.

For a local build using the committed snapshot:

```sh
pnpm install --frozen-lockfile
pnpm test
python scripts/corpus_snapshot.py restore
pnpm build
pnpm validate
```

See [release checks and rollback](releasing.md) for browser setup, hardware verification, restoring old snapshots and failed refresh recovery.

The deployed project URL is [CMG Viewer](https://alchemiesofscent.github.io/cmg-viewer/).
