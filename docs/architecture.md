# Architecture

## Outcome

CMG Viewer is a fully static GitHub Pages site with work-level discovery and
physical-volume viewing. It generates its own durable catalogue records and
IIIF Presentation 3 manifests while reading page pixels from BBAW's public
Digilib IIIF Image API.

## Data model

Catalogue items and physical volumes are deliberately separate:

```text
catalogue item (author/work/editor/language/start pn)
                         |
                         +----> physical volume (ordered canvases and ranges)
```

Several works can begin at different physical orders inside one scanned
volume. Stable IDs are derived from the allowlisted PHP path, physical start,
and occurrence rather than from mutable display-title slugs.

Bibliographic enrichment is evidence-bearing and deliberately conservative.
Controlled, anchored author forms and explicit editorial or translation-role
clauses receive searchable values plus field-level provenance. Roleless MODS
names remain contributors; multi-year citations keep every year and do not
receive an ambiguous singular year. The current full METS set supplies no MODS
source-language values, so the source-language facet is left empty rather than
inferred from a series name. Explicit translation targets remain searchable.

Generated files use this layout:

```text
dist/
  index.html
  assets/
  data/catalogue.json
  data/volumes/{volumeId}.json
  data/sync-report.json
  iiif/collection.json
  iiif/{volumeId}/manifest.json
  viewer/{volumeId}/index.html
  404.html
  .nojekyll
```

## Stable URLs and page identity

The canonical viewer URL is:

```text
https://alchemiesofscent.github.io/cmg-viewer/viewer/{volumeId}/?pn={ORDER}
```

`pn` is the physical scan order used by the original CMG viewer (and normally
the METS physical `ORDER`). It is not a zero-based canvas index and is not
necessarily the printed page label. Each volume therefore contains an explicit
`ORDER -> canvas index` map.

## Upstream synthesis

The monthly synchronizer combines three sources:

1. Catalogue HTML for collection membership and work-level records.
2. METS physical/logical structure where a reliable file exists.
3. Live legacy viewer HTML for image configuration and additional contents.

METS and live HTML logical contents are merged with provenance rather than
silently choosing one. Volumes without reliable METS still receive a functional
fallback manifest from their legacy Digilib configuration.

## Image services

Each canvas references BBAW's HTTPS, CORS-enabled IIIF Image API v2 service.
The service identifier is derived from the live Digilib `fn` directory and the
page basename, then verified against Digilib's directory manifest or, when
needed, `info.json`. Presentation manifests remain viewer-independent even
though TIFY is the initial client.

## Publication safety

Synchronization fails closed. The previous successful Pages deployment remains
live if validation detects an unexpected catalogue shrink, duplicate IDs or
unrecoverable physical orders, invalid ranges, bad `pn` mappings, non-HTTPS or
non-allowlisted resources, failed IIIF probes, broken base-path links, or a
large artifact-size regression.

Production validation also requires the reviewed full 218-work/143-viewer
census and its 117-METS/26-fallback split. A diagnostic `--volume` subset must
use a separate `--dist` directory and is marked `partial`, so it cannot replace
or validate as the production artifact.

Narrow upstream defects are normalized only when a second source makes the
repair unambiguous: stable physical IDs can repair a single duplicated METS
order, the live Digilib directory position can repair a stale derivative name,
and unavailable METS tail pages can be omitted only when both the live viewer
and directory inventory end at the same order. Duplicate logical IDs and
dangling logical pointers are retained as source warnings. Every such decision
is written into the normalized volume provenance.
