# CMG Viewer

A static, catalogue-wide viewer for the digital editions published by the
Corpus Medicorum Graecorum / Latinorum at BBAW. The site is designed for
deployment at <https://alchemiesofscent.github.io/cmg-viewer/>.

The application keeps its searchable catalogue, IIIF Presentation manifests,
and viewer routes on GitHub Pages. Page images remain on BBAW's HTTPS IIIF
Image API, so the repository does not duplicate the scan collection.

The reviewed live census currently contains 218 work-level entries mapped to
143 physical viewers and 37,756 available scans. Of those viewers, 117 use
METS and 26 use a validated legacy-HTML/Digilib fallback.

## Local development

Requirements: Python 3.11+, Node.js 20+, and pnpm 11.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm sync
pnpm build
pnpm validate
pnpm serve
```

Then open <http://localhost:8000/cmg-viewer/>. `pn` in a viewer URL always
means the legacy CMG physical scan order, not an array index or printed page
label. For a quick four-volume fixture build, use `pnpm sync:samples` instead
of `pnpm sync`.

Catalogue fields are evidence-based. Explicit author/editor/translation clauses
and reviewed source-language defaults are indexed with field-level provenance;
roleless METS names remain generic contributors, and missing metadata is not
guessed. The upstream METS currently supplies no MODS language terms, so the
language facet uses the reviewed source, collection, volume, and work rules
documented in [language defaults](docs/language-defaults.md).

## Project layout

- `config/` — allowlisted upstream catalogue sources and curated overrides.
- `scripts/` — synchronization, normalization, validation, and static build.
- `src/` — dependency-light catalogue and viewer interface.
- `scripts/tests/` — generator, ingestion, and URL-contract tests.
- `data/last-successful-sync.json` — compact marker updated after each scheduled sync.
- `dist/` — generated GitHub Pages artifact (ignored by Git).

The older single-volume prototype in `bbaw-cmg-tify-mobile-prototype/` is kept
locally for comparison but intentionally ignored because it contains roughly
80 MB of substitute scans.

## Deployment

Push `main` to the `alchemiesofscent/cmg-viewer` repository and enable GitHub
Pages with **GitHub Actions** as the source. The deployment workflow builds and
validates a static artifact with the `/cmg-viewer/` base path. A monthly
scheduled run refreshes upstream catalogue metadata and deploys only after all
fail-closed checks pass.

See [the architecture decision](docs/architecture.md) for the data model and
sync guarantees, [the reviewed catalogue scope](docs/catalogue-scope.md) for
the upstream census, and [the deployment guide](docs/deployment.md) for Pages
setup.

## License

CMG Viewer is released under the [GNU Affero General Public License v3.0](LICENSE).
The generated site also includes TIFY 0.35.0 under the same license family; see
[the third-party notices](THIRD_PARTY_NOTICES.md). Catalogue records and page
images remain linked to their BBAW sources and are not relicensed here.
