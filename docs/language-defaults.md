# Reviewed source-language defaults

The `languages` facet describes the language of the edited or translated source
text represented by a catalogue record. It is separate from
`translationLanguages`, which records an explicitly named modern translation
target. These defaults are necessary because the reviewed upstream METS records
do not contain MODS language terms.

Rules live in `config/catalogue-sources.json`. They are applied from broadest to
most specific scope: source page, collection, physical volume, then logical
work. A more specific rule replaces a broader default. Every output value cites
the matched rule, its review basis, and its BBAW evidence URL in
`metadataProvenance.languages`; conflicting source-page rules fail the build.

| Scope | Reviewed default |
| --- | --- |
| CMG | Ancient Greek |
| CML | Latin |
| CMG Supplementum | Per volume: I Ancient Greek + Arabic; II Latin + Ancient Greek; III Arabic; IV–V Ancient Greek; VI German |
| CMG Supplementum Orientale | Arabic; the volume-II header is Arabic + Ancient Greek and its two Greek re-editions are Ancient Greek |
| Weitere Ausgaben: Aëtius, Alexander, Anonymus Londinensis, Dioscorides, Hippocrates, Ideler | Ancient Greek |
| Weitere Ausgaben: Theodorus Priscianus | Latin |
| Weitere Ausgaben: Galen | Ancient Greek, except the two Arabic Anatomy volumes and the Arabic Medizinische Namen edition |
| Galen translations | Ancient Greek source |
| Explicit Diels viewers | German |

The broad CMG/CML assignments follow the BBAW's description of the main series
as critical editions of Greek and Latin medical texts. The BBAW describes
Supplementum Orientale as Greek-origin works surviving in Arabic, Syriac, or
Latin translations, so its scanned corpus was reviewed record by record rather
than assigned Ancient Greek from the parent series. Supplementum is likewise
heterogeneous and therefore has no blanket source-page rule.

Primary references:

- <https://cmg.bbaw.de/en/homepage/corpus-medicum>
- <https://cmg.bbaw.de/epubl/online/publisuppl.html>
- <https://cmg.bbaw.de/epubl/online/publisupplor.html>
- the eleven other allowlisted catalogue pages recorded alongside their rules
