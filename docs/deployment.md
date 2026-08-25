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

The deploy job uses GitHub's `github-pages` environment and OIDC deployment
token. Repository access remains read-only; the workflow does not commit
generated catalogue data or caches. Pages deployment requires only the
workflow-level `pages: write` and `id-token: write` permissions declared in the
workflow.

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
