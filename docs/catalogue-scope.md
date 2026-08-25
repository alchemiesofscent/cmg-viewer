# Catalogue scope

This document defines the upstream boundary for CMG Viewer. It is deliberately
an allowlist: a monthly synchronization may update records found inside these
sources, but it must not silently broaden the site to unrelated BBAW pages.

The URLs and counts below were verified against the live BBAW site on
2026-08-25. All 13 catalogue pages, all four explicit Diels viewers, and all 18
exceptional METS documents returned HTTP 200 at verification time.

## Allowlisted catalogue pages

| Source | Collection membership | URL |
| --- | --- | --- |
| CMG editions | CMG | <https://cmg.bbaw.de/epubl/online/editionen.html> |
| Supplementum | CMG Supplementum | <https://cmg.bbaw.de/epubl/online/publisuppl.html> |
| Supplementum Orientale | CMG Supplementum Orientale | <https://cmg.bbaw.de/epubl/online/publisupplor.html> |
| CML | CML | <https://cmg.bbaw.de/epubl/online/publicml.html> |
| Aëtios | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_aetius.html> |
| Alexander von Tralles | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_alex_trall.html> |
| Anonymus Londinensis | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_anon_lond.html> |
| Dioscurides | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_dioscurides.html> |
| Galen | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_galen.html> |
| Hippocrates | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_hippocrates.html> |
| Theodorus Priscianus | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_theod_prisc.html> |
| Ideler | Weitere Ausgaben | <https://cmg.bbaw.de/epubl/online/publiweitereausgaben_ideler.html> |
| Galen translations | Übersetzungen | <https://cmg.bbaw.de/epubl/online/publiuebersetzungen_galen.html> |

The four `diels_01.php` through `diels_04.php` viewers are explicit additions.
They remain individually allowlisted even though the current Galen translations
page links them; this prevents a harmless upstream layout change from removing
them from the generated catalogue.

## Counting semantics

A catalogue item is not the same thing as a physical scan. Query strings,
especially `?p=`, identify a work or logical starting point inside a volume and
must be retained when generating work-level search records. The same links are
normalized without their query strings when identifying physical viewers.

The verified baseline is:

| Unit | Count |
| --- | ---: |
| Allowlisted catalogue pages | 13 |
| Unique catalogue work/deep links | 214 |
| Explicit Diels work links | 4 |
| Searchable work-level entries | 218 |
| Catalogue-derived physical viewer endpoints | 139 |
| Explicit Diels physical viewer endpoints | 4 |
| Physical viewer endpoints in total | 143 |

The 143 physical endpoints break down as 55 CMG, 6 Supplementum, 7
Supplementum Orientale, 8 CML, 43 Weitere Ausgaben, 19 translations, 1
`Diss_Schubring`, and 4 Diels viewers. Prefixes are not authoritative for
collection membership; the source page is. A single physical volume can and
often does produce several searchable catalogue entries.

Three linked PHP pages are outside the publication count:

- `kuehn.php` and `littre.php` are concordance/search tools.
- `suppl_or_05_01_xurspr.php` is an auxiliary original-page helper for
  `suppl_or_05_01.php`, not another physical volume.

## METS resolution

For each viewer, synchronization first probes
`mets/{viewerStem}.xml`. This predictable rule resolves 99 of the 143
endpoints. The 18 entries in `config/mets-overrides.json` are active DFG Viewer
links from the corresponding legacy page whose target METS filenames do not
follow that rule. Every override target returned HTTP 200 and contained both
PHYSICAL and LOGICAL METS structMaps during verification.

One structurally valid predictable METS file exists even though its legacy
viewer page has no active DFG link: `wa_prisc_eupor`. It remains safe to use
because the document was fetched and validated directly. Five `wu_` paths that
look predictable instead return HTML error content rather than METS XML; the
live audit therefore routes them through the verified fallback adapter.

`cmg_01_01_02.php` is a special but non-blocking alias case. Its active legacy
DFG link names `mets/CMG_01_01_02_00.xml`, while the predictable
`mets/cmg_01_01_02.xml` also exists and is structurally valid. The predictable
document is preferred, so this does not consume one of the 18 overrides.

In total, 117 viewers have reliable METS and 26 use the functional Digilib
fallback. The fallback set is:

- `Diss_Schubring`.
- `wa_Alex_Trall_Puschmann_01` and `wa_Alex_Trall_Puschmann_02`.
- `wa_Diss_Reedy` and `wa_Gal_Siebenmonatskinder_Walzer`.
- `wa_Physici_Medici_Graeci_Ideler_01` and
  `wa_Physici_Medici_Graeci_Ideler_02`.
- Nineteen `wu_` viewers, including the five predictable-looking paths whose
  current responses are not METS XML.

All 26 fallback pages have a live legacy Digilib configuration. Twenty-one have
no usable predictable METS response; the other five return non-METS HTML/error
content. None has a reviewed active METS link. Some source files contain
commented example links to unrelated documents such as
`wa_Gal_Fieberbehandlung_Voigt.xml`, `cmg_05_03_03.xml`, or
`wa_Minor_Gal_diff_resp.xml`. Synchronization removes HTML comments before link
discovery and never promotes those placeholders.

## Synchronization invariants

The monthly job should fail closed if the upstream crawl falls materially below
the committed baseline, if an allowlisted source stops returning successfully,
or if a viewer moves between the reliable-METS and fallback sets without an
explicit review. Stable viewer IDs come from the committed PHP paths, not from
titles or newly generated slugs. Only HTTPS resources on `cmg.bbaw.de` and
`digilib.bbaw.de` are accepted.
