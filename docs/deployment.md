# GitHub Pages deployment

The production site is built and deployed by
`.github/workflows/deploy-pages.yml`. In the GitHub repository settings, choose
**Settings → Pages → Build and deployment → GitHub Actions** as the Pages
source. No publishing branch or committed `dist/` directory is required.

The workflow runs in three situations:

- after a push to `main`;
- when started manually with **Run workflow**; and
- at 03:17 UTC on the first day of every month.

Manual runs may build any selected ref for diagnosis, but the deploy job is
guarded to `main`; selecting another branch cannot replace the public site.

Each run installs the pinned pnpm dependencies, runs the Python test suite,
synchronizes the full allowlisted BBAW catalogue, builds the static site, and
validates `dist/`. The Pages artifact is uploaded only after every gate passes.
Consequently, an upstream outage, unexpected catalogue-count change, invalid
manifest, or build failure cannot replace the last successful deployment.

After a successful scheduled synchronization, the workflow commits the compact
`data/last-successful-sync.json` marker with a `[skip ci]` commit. Besides making
the reviewed counts visible in Git, this keeps the public repository active so
GitHub does not automatically disable its scheduled workflow after 60 days.
Push and manual runs never write this marker.

The deploy job uses GitHub's `github-pages` environment and OIDC deployment
token. The workflow's `contents: write` permission is used only by the guarded
scheduled marker step; generated catalogue data and caches are never committed.
Pages publication uses the separately declared `pages: write` and
`id-token: write` permissions.

The equivalent release check can be run locally from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm sync
pnpm build
pnpm validate
```

The deployed project URL is
<https://alchemiesofscent.github.io/cmg-viewer/>.

## Current release workflow

UI pushes now restore a checksum-pinned corpus snapshot. Upstream synchronization runs independently in **Refresh corpus**. See [releasing.md](releasing.md) for the current workflows, bootstrap, browser checks and rollback.
