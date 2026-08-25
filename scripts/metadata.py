"""Conservative, evidence-bearing catalogue metadata enrichment.

The BBAW catalogue supplies human-readable bibliographic citations rather than
role-bearing structured metadata.  This module deliberately recognizes only a
small set of explicit author forms, editorial role clauses and translation
target constructions.  Anything outside those grammars remains unassigned.
"""

from __future__ import annotations

from collections import defaultdict
import re
from typing import Any, Iterable


LANGUAGE_DEFAULT_PRECEDENCE = (
    "sourceId",
    "collection",
    "volumeId",
    "workId",
)
LANGUAGE_DEFAULT_MAPS = {
    "sourceId": "bySourceId",
    "collection": "byCollection",
    "volumeId": "byVolumeId",
    "workId": "byWorkId",
}


class MetadataError(ValueError):
    """A reviewed metadata rule is malformed or ambiguous."""


FORMAL_SERIES_COLLECTIONS = {
    "CMG",
    "CMG Supplementum",
    "CMG Supplementum Orientale",
    "CML",
}

YEAR_RE = re.compile(r"^(?:1[5-9]\d{2}|20\d{2})$")
LEADING_SERIES_RE = re.compile(
    r"^(?P<series>"
    r"(?:(?:CMG|CML|Supplementum(?:\s+Orientale)?|Suppl\.?\s*Or\.?)\s*)?"
    r"[IVXLCDM]+(?:\s+\d+(?:\s*,\s*\d+)*)?"
    r")\s+(?=\S)",
    re.IGNORECASE,
)


# Ordered from the most specific attribution to the broadest canonical form.
# These expressions are applied only at the beginning of a citation, after an
# optional formal series number has been removed.  Subject references such as
# ``In Hippocratis ...`` therefore do not become author assignments.
AUTHOR_ALIASES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), canonical)
    for pattern, canonical in (
        (r"^Claudii\s+Galeni\s+Pergameni\b", "Galen"),
        (r"^Galeni\s+qui\s+fertur\b", "Pseudo-Galen"),
        (r"^Pseudogaleni\b", "Pseudo-Galen"),
        (r"^Plinii\s+Secundi\s+Iunioris\s+qui\s+feruntur\b", "Pseudo-Pliny"),
        (r"^Alexander\s+von\s+Tralles\b", "Alexander of Tralles"),
        (r"^Galeni\b", "Galen"),
        (r"^Galens\b", "Galen"),
        (r"^Galenos(?:\s+von\s+Pergamon)?\b", "Galen"),
        (r"^Galen\b(?=\s*[,.:])", "Galen"),
        (r"^Hippocratis\b", "Hippocrates"),
        (r"^Rufi\s+Ephesii\b", "Rufus of Ephesus"),
        (r"^Aretaeus\b", "Aretaeus"),
        (r"^Sorani\b", "Soranus"),
        (r"^Oribasii\b", "Oribasius"),
        (r"^Aetii\s+Amideni\b", "Aëtius of Amida"),
        (r"^Paulus\s+Aegineta\b", "Paul of Aegina"),
        (r"^Philumeni\b", "Philumenus"),
        (r"^Leonis\s+medici\b", "Leo the Physician"),
        (r"^Apollonii\s+Citiensis\b", "Apollonius of Citium"),
        (r"^Stephani\s+Philosophi\b", "Stephanus the Philosopher"),
        (r"^Stephani\s+Atheniensis\b", "Stephanus of Athens"),
        (r"^Ioannis\s+Alexandrini\b", "John of Alexandria"),
        (r"^Anonymi\s+Londinensis\b", "Anonymus Londinensis"),
        (r"^Anonymi\b", "Anonymous"),
        (r"^A\.\s+Cornelii\s+Celsi\b", "Aulus Cornelius Celsus"),
        (r"^Scribonii\s+Largi\b", "Scribonius Largus"),
        (r"^Quinti\s+Sereni\b", "Quintus Serenus"),
        (r"^Antonii\s+Musae\b", "Antonius Musa"),
        (r"^Pseudoapulei\b", "Pseudo-Apuleius"),
        (r"^Sexti\s+Placiti\b", "Sextus Placitus"),
        (r"^Marcelli\b", "Marcellus Empiricus"),
        (r"^Caelii\s+Aureliani\b", "Caelius Aurelianus"),
        (r"^Anthimi\b", "Anthimus"),
        (r"^Pedanii\s+Dioscuridis\s+Anazarbei\b", "Dioscorides"),
        (r"^Theodori\s+Prisciani\b", "Theodorus Priscianus"),
    )
)

# The two cached Opera records explicitly qualify the Hippocratic attribution.
# A plain ``authors: Hippocrates`` would erase that uncertainty, while calling
# the entire collected volume pseudo-Hippocratic would overstate it.  Leave the
# author facet blank until a reviewed work-level attribution exists.
UNCERTAIN_AUTHOR_FORMS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"^Hippocratis\s+Opera\s+quae\s+feruntur\s+omnia\b",
        re.IGNORECASE,
    ),
)


# Contributor names in this catalogue are consistently initial-led.  Requiring
# that shape is intentionally strict: it prevents cities, titles and role words
# from being consumed as people.
# Multi-letter praenomina are allowlisted from forms actually present in the
# catalogue.  A broad ``[A-Z][a-z]+.`` token would misclassify ``Bd. I`` and
# ``Diss. Marburg`` as people after a real editor name.
INITIAL_PATTERN = r"(?:[A-ZÄÖÜ]\.|Ph\.|Chr\.|St\.|Th\.)"
SURNAME_WORD_PATTERN = r"[A-ZÄÖÜ](?:[^\W\d_]|['’‐‑-])*"
PERSON_PATTERN = (
    rf"(?:{INITIAL_PATTERN}\s*){{1,4}}"
    rf"(?:(?:de|De|ter|von|v\.)\s+)?"
    rf"{SURNAME_WORD_PATTERN}"
)
NAME_LIST_PATTERN = (
    rf"{PERSON_PATTERN}"
    rf"(?:\s*,\s*{PERSON_PATTERN})*"
    rf"(?:\s+(?:et|und|u\.)\s+{PERSON_PATTERN})?"
)
PERSON_RE = re.compile(PERSON_PATTERN)


EDITOR_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "latin-compound-role",
        re.compile(
            rf"\b(?:edidit|ediderunt|recensuit)"
            rf"(?:\s*,\s*|\s+et\s+)"
            rf"[^;]{{0,160}}?\b(?:vertit|verterunt|transtulit|transtulerunt)\b"
            rf"(?:\s*,\s*commentat(?:us|a)\s+est)?\s+"
            rf"(?P<names>{NAME_LIST_PATTERN})",
            re.IGNORECASE,
        ),
    ),
    (
        "latin-editor-role",
        re.compile(
            rf"\b(?:edidit|ediderunt|recensuit|retractaverunt)\s+"
            rf"(?P<names>{NAME_LIST_PATTERN})",
            re.IGNORECASE,
        ),
    ),
    (
        "german-editor-role",
        re.compile(
            rf"\bhrsg\.\s*(?:v\.|von)\s+(?P<names>{NAME_LIST_PATTERN})",
            re.IGNORECASE,
        ),
    ),
    (
        "german-compound-role",
        re.compile(
            rf"\bhrsg\.\s*,\s*übers\.\s+u\.\s+erl\.\s+v\.\s+"
            rf"(?P<names>{NAME_LIST_PATTERN})",
            re.IGNORECASE,
        ),
    ),
    (
        "german-expanded-role",
        re.compile(
            rf"\bherausgegeben(?:\s+und\s+übersetzt)?\s+von\s+"
            rf"(?P<names>{NAME_LIST_PATTERN})",
            re.IGNORECASE,
        ),
    ),
    (
        "latin-editor-abbreviation",
        re.compile(
            rf"\bed\.\s+(?P<names>{NAME_LIST_PATTERN})",
            re.IGNORECASE,
        ),
    ),
    (
        "english-critical-edition-role",
        re.compile(
            rf"\ba\s+critical\s+edition\b[^.;]{{0,80}}?,\s*by\s+"
            rf"(?P<names>{NAME_LIST_PATTERN})",
            re.IGNORECASE,
        ),
    ),
)


LANGUAGE_ALIASES = {
    "germanicam": "German",
    "germanicum": "German",
    "germanice": "German",
    "anglicam": "English",
    "anglicum": "English",
    "anglice": "English",
    "italicam": "Italian",
    "italicum": "Italian",
    "italice": "Italian",
    "francogallicam": "French",
    "francogallicum": "French",
    "francogallice": "French",
    "graecam": "Greek",
    "graecum": "Greek",
    "graece": "Greek",
    "latinam": "Latin",
    "latinum": "Latin",
    "latine": "Latin",
    "arabicam": "Arabic",
    "arabicum": "Arabic",
    "arabice": "Arabic",
    "german": "German",
    "english": "English",
    "italian": "Italian",
    "french": "French",
    "greek": "Greek",
    "latin": "Latin",
    "arabic": "Arabic",
    "deutsche": "German",
    "englische": "English",
    "italienische": "Italian",
    "französische": "French",
    "griechische": "Greek",
    "lateinische": "Latin",
    "arabische": "Arabic",
}
LATIN_LANGUAGE_PATTERN = (
    r"Germanic(?:am|um)|Anglic(?:am|um)|Italic(?:am|um)|"
    r"Francogallic(?:am|um)|Graec(?:am|um)|Latin(?:am|um)|Arabic(?:am|um)"
)
ADVERB_LANGUAGE_PATTERN = (
    r"Germanice|Anglice|Italice|Francogallice|Graece|Latine|Arabice"
)
ENGLISH_LANGUAGE_PATTERN = r"German|English|Italian|French|Greek|Latin|Arabic"
GERMAN_LANGUAGE_PATTERN = (
    r"Deutsche|Englische|Italienische|Französische|Griechische|Lateinische|Arabische"
)

TRANSLATION_TARGET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("latin-in-linguam-target", re.compile(
        rf"\bin\s+(?:linguam|liguam)\s+(?P<language>{LATIN_LANGUAGE_PATTERN})\s+"
        rf"(?:retro\s+)?(?:vertit|verterunt|transtulit|transtulerunt)\b",
        re.IGNORECASE,
    )),
    ("latin-in-language-linguam-target", re.compile(
        rf"\bin\s+(?P<language>{LATIN_LANGUAGE_PATTERN})\s+linguam\s+"
        rf"(?:retro\s+)?(?:vertit|verterunt|transtulit|transtulerunt)\b",
        re.IGNORECASE,
    )),
    ("latin-in-language-sermonem-target", re.compile(
        rf"\bin\s+(?P<language>{LATIN_LANGUAGE_PATTERN})\s+sermonem\s+"
        rf"(?:retro\s+)?(?:vertit|verterunt|transtulit|transtulerunt|translatus)\b",
        re.IGNORECASE,
    )),
    ("latin-in-sermonem-language-target", re.compile(
        rf"\bin\s+sermonem\s+(?P<language>{LATIN_LANGUAGE_PATTERN})\s+"
        rf"(?:retro\s+)?(?:vertit|verterunt|transtulit|transtulerunt|translatus)\b",
        re.IGNORECASE,
    )),
    ("latin-adverb-target", re.compile(
        rf"\b(?P<language>{ADVERB_LANGUAGE_PATTERN})\s+"
        rf"(?:retro\s+)?(?:vertit|verterunt|versum)\b",
        re.IGNORECASE,
    )),
    ("english-translated-into-target", re.compile(
        rf"\btranslated\s+into\s+(?P<language>{ENGLISH_LANGUAGE_PATTERN})\b",
        re.IGNORECASE,
    )),
    ("german-explicit-target", re.compile(
        rf"\b(?:ins|in\s+die)\s+(?P<language>{GERMAN_LANGUAGE_PATTERN})\s+übersetzt\b",
        re.IGNORECASE,
    )),
)


def compact_space(value: Any) -> str:
    return " ".join(str(value).split()) if value is not None else ""


def unique_strings(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = compact_space(value)
        folded = text.casefold()
        if text and folded not in seen:
            seen.add(folded)
            result.append(text)
    return result


def normalize_year(value: Any) -> str:
    text = compact_space(value)
    return text if YEAR_RE.fullmatch(text) else ""


def normalize_edition_year(value: Any) -> str:
    """Return only an unambiguous four-digit edition year from volume metadata."""

    return normalize_year(value)


def citation_sources(work: dict[str, Any]) -> list[tuple[str, str]]:
    values: list[tuple[str, Any]] = [
        ("label", work.get("label")),
        *[("rawLabels", value) for value in work.get("rawLabels", [])],
        ("rawContext", work.get("rawContext")),
        *[("rawContexts", value) for value in work.get("rawContexts", [])],
    ]
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for field, value in values:
        text = compact_space(value)
        if text and text.casefold() not in seen:
            seen.add(text.casefold())
            result.append((field, text))
    return result


def provenance(
    value: str,
    *,
    source: str,
    evidence: str,
    evidence_field: str,
    rule: str | None = None,
    evidence_ids: list[str] | None = None,
    evidence_url: str | None = None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "value": value,
        "source": source,
        "evidence": evidence,
        "evidenceField": evidence_field,
    }
    if rule:
        record["rule"] = rule
    if evidence_ids:
        record["evidenceIds"] = evidence_ids
    if evidence_url:
        record["evidenceUrl"] = evidence_url
    return record


def validate_language_defaults(value: Any) -> dict[str, Any]:
    """Validate the curated default table and return it unchanged.

    Defaults are data, not parsing heuristics.  Their declared precedence is
    part of the schema so a future configuration edit cannot silently change
    which reviewed assertion wins.
    """

    if not isinstance(value, dict):
        raise MetadataError("languageDefaults must be an object")
    if tuple(value.get("precedence", ())) != LANGUAGE_DEFAULT_PRECEDENCE:
        raise MetadataError(
            "languageDefaults.precedence must be sourceId, collection, "
            "volumeId, workId"
        )
    reviewed_at = compact_space(value.get("reviewedAt"))
    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", reviewed_at):
        raise MetadataError("languageDefaults.reviewedAt must be an ISO date")

    for map_name in LANGUAGE_DEFAULT_MAPS.values():
        rules = value.get(map_name)
        if not isinstance(rules, dict):
            raise MetadataError(f"languageDefaults.{map_name} must be an object")
        for key, rule in rules.items():
            if not compact_space(key) or not isinstance(rule, dict):
                raise MetadataError(
                    f"languageDefaults.{map_name} contains an invalid rule"
                )
            languages = rule.get("languages")
            if not isinstance(languages, list) or not languages:
                raise MetadataError(
                    f"languageDefaults.{map_name}.{key}.languages must be a "
                    "non-empty list"
                )
            normalized = unique_strings(languages)
            if len(normalized) != len(languages):
                raise MetadataError(
                    f"languageDefaults.{map_name}.{key}.languages contains "
                    "blank or duplicate values"
                )
            if not compact_space(rule.get("basis")):
                raise MetadataError(
                    f"languageDefaults.{map_name}.{key}.basis is required"
                )
            basis_url = compact_space(rule.get("basisUrl"))
            if not basis_url.startswith("https://cmg.bbaw.de/"):
                raise MetadataError(
                    f"languageDefaults.{map_name}.{key}.basisUrl must be an "
                    "HTTPS BBAW URL"
                )
    return value


def _language_rule_provenance(
    *,
    languages: list[str],
    rule: dict[str, Any],
    map_name: str,
    key: str,
) -> list[dict[str, Any]]:
    evidence_field = f"config.languageDefaults.{map_name}.{key}"
    return [
        provenance(
            language,
            source="reviewed-source-language-default",
            evidence=compact_space(rule["basis"]),
            evidence_field=evidence_field,
            evidence_url=compact_space(rule["basisUrl"]),
            rule=f"{map_name}-default",
        )
        for language in languages
    ]


def resolve_language_default(
    work: dict[str, Any], defaults: dict[str, Any] | None
) -> tuple[list[str], list[dict[str, Any]]]:
    """Resolve one reviewed default, from broadest to most specific scope."""

    if defaults is None:
        return [], []
    defaults = validate_language_defaults(defaults)
    chosen: tuple[str, str, dict[str, Any]] | None = None

    source_rules = defaults["bySourceId"]
    source_matches = [
        (source_id, source_rules[source_id])
        for source_id in unique_strings(work.get("sourceIds", []))
        if source_id in source_rules
    ]
    if source_matches:
        distinct = {
            tuple(unique_strings(rule["languages"]))
            for _source_id, rule in source_matches
        }
        if len(distinct) != 1:
            raise MetadataError(
                f"Conflicting source-language defaults for work {work.get('id')!r}"
            )
        source_id, rule = source_matches[0]
        chosen = ("bySourceId", source_id, rule)

    selectors = (
        ("byCollection", compact_space(work.get("collection"))),
        ("byVolumeId", compact_space(work.get("volumeId"))),
        ("byWorkId", compact_space(work.get("id"))),
    )
    for map_name, key in selectors:
        if key and key in defaults[map_name]:
            chosen = (map_name, key, defaults[map_name][key])

    if chosen is None:
        return [], []
    map_name, key, rule = chosen
    languages = unique_strings(rule["languages"])
    return languages, _language_rule_provenance(
        languages=languages,
        rule=rule,
        map_name=map_name,
        key=key,
    )


def strip_leading_series(text: str, collection: str) -> str:
    if collection not in FORMAL_SERIES_COLLECTIONS:
        return text
    return LEADING_SERIES_RE.sub("", text, count=1)


def extract_authors(work: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    collection = compact_space(work.get("collection"))
    candidates: list[tuple[str, dict[str, Any]]] = []
    uncertain = False
    for field, citation in citation_sources(work):
        candidate = strip_leading_series(citation, collection)
        if any(pattern.match(candidate) for pattern in UNCERTAIN_AUTHOR_FORMS):
            uncertain = True
            continue
        for pattern, canonical in AUTHOR_ALIASES:
            match = pattern.match(candidate)
            if match:
                candidates.append(
                    (
                        canonical,
                        provenance(
                            canonical,
                            source="catalogue-explicit-author-form",
                            evidence=match.group(0),
                            evidence_field=field,
                            rule="anchored-controlled-author-alias",
                        ),
                    )
                )
                break
    canonical_values = unique_strings(value for value, _record in candidates)
    if uncertain or len(canonical_values) != 1:
        return [], []
    canonical = canonical_values[0]
    record = next(record for value, record in candidates if value == canonical)
    return [canonical], [record]


def person_names(value: str) -> list[str]:
    return unique_strings(match.group(0) for match in PERSON_RE.finditer(value))


def extract_editors(work: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    editors: list[str] = []
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for field, citation in citation_sources(work):
        for rule, pattern in EDITOR_PATTERNS:
            for match in pattern.finditer(citation):
                for editor in person_names(match.group("names")):
                    folded = editor.casefold()
                    if folded in seen:
                        continue
                    seen.add(folded)
                    editors.append(editor)
                    records.append(
                        provenance(
                            editor,
                            source="catalogue-explicit-editor-role",
                            evidence=match.group(0),
                            evidence_field=field,
                            rule=rule,
                        )
                    )
    return editors, records


def extract_translation_languages(
    work: dict[str, Any],
) -> tuple[list[str], list[dict[str, Any]]]:
    languages: list[str] = []
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for field, citation in citation_sources(work):
        for rule, pattern in TRANSLATION_TARGET_PATTERNS:
            for match in pattern.finditer(citation):
                matched_language = match.group("language")
                canonical = LANGUAGE_ALIASES.get(matched_language.casefold())
                if not canonical or canonical.casefold() in seen:
                    continue
                seen.add(canonical.casefold())
                languages.append(canonical)
                records.append(
                    provenance(
                        canonical,
                        source="catalogue-explicit-translation-target",
                        evidence=match.group(0),
                        evidence_field=field,
                        rule=rule,
                    )
                )
    return languages, records


def direct_series_evidence(
    work: dict[str, Any],
) -> tuple[list[str], list[dict[str, Any]]]:
    values = unique_strings(work.get("hints", {}).get("seriesNumbers", []))
    records = [
        provenance(
            value,
            source="catalogue-series-hint",
            evidence=value,
            evidence_field="hints.seriesNumbers",
        )
        for value in values
    ]
    if values or compact_space(work.get("collection")) not in FORMAL_SERIES_COLLECTIONS:
        return values, records
    for field, citation in citation_sources(work):
        match = LEADING_SERIES_RE.match(citation)
        if not match:
            continue
        value = re.sub(r"\s*,\s*", ",", compact_space(match.group("series")))
        return [value], [
            provenance(
                value,
                source="catalogue-explicit-series-form",
                evidence=match.group(0).strip(),
                evidence_field=field,
                rule="anchored-formal-series-form",
            )
        ]
    return [], []


def direct_year_evidence(
    work: dict[str, Any],
) -> tuple[list[str], list[dict[str, Any]]]:
    values = unique_strings(
        year
        for value in work.get("hints", {}).get("years", [])
        if (year := normalize_year(value))
    )
    return values, [
        provenance(
            value,
            source="catalogue-year-hint",
            evidence=value,
            evidence_field="hints.years",
        )
        for value in values
    ]


def extract_work_metadata(
    work: dict[str, Any],
    language_defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    authors, author_records = extract_authors(work)
    editors, editor_records = extract_editors(work)
    translation_languages, translation_records = extract_translation_languages(work)
    series_numbers, series_records = direct_series_evidence(work)
    years, year_records = direct_year_evidence(work)
    explicit_languages = unique_strings(work.get("languages", []))
    if explicit_languages:
        languages = explicit_languages
        language_records = [
            provenance(
                language,
                source="catalogue-explicit-language-value",
                evidence=language,
                evidence_field="languages",
            )
            for language in languages
        ]
    else:
        languages, language_records = resolve_language_default(
            work, language_defaults
        )
    field_provenance: dict[str, list[dict[str, Any]]] = {}
    for field, records in (
        ("languages", language_records),
        ("authors", author_records),
        ("editors", editor_records),
        ("translationLanguages", translation_records),
        ("seriesNumbers", series_records),
        ("seriesNumber", series_records if len(series_numbers) == 1 else []),
        ("years", year_records),
        ("year", year_records if len(years) == 1 else []),
    ):
        if records:
            field_provenance[field] = records
    return {
        "languages": languages,
        "authors": authors,
        "editors": editors,
        "translationLanguages": translation_languages,
        "seriesNumbers": series_numbers,
        "seriesNumber": series_numbers[0] if len(series_numbers) == 1 else "",
        "years": years,
        "year": years[0] if len(years) == 1 else "",
        "metadataProvenance": field_provenance,
    }


def enrich_works(
    works: Iterable[dict[str, Any]],
    language_defaults: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Enrich works and propagate only unanimous series/year evidence per volume."""

    if language_defaults is not None:
        validate_language_defaults(language_defaults)
    enriched: list[dict[str, Any]] = []
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for work in works:
        if work.get("_metadataEnriched"):
            value = {
                **work,
                "metadataProvenance": {
                    field: [dict(record) for record in records]
                    for field, records in work.get(
                        "metadataProvenance", {}
                    ).items()
                },
            }
        else:
            value = {
                **work,
                **extract_work_metadata(work, language_defaults),
                "_metadataEnriched": True,
            }
        enriched.append(value)
        grouped[compact_space(work.get("volumeId"))].append(value)

    for volume_id, siblings in grouped.items():
        series_values = unique_strings(
            value for work in siblings for value in work.get("seriesNumbers", [])
        )
        year_values = unique_strings(
            value for work in siblings for value in work.get("years", [])
        )
        series_evidence_ids = [
            work.get("id", "") for work in siblings if work.get("seriesNumbers")
        ]
        year_evidence_ids = [work.get("id", "") for work in siblings if work.get("years")]

        if len(series_values) == 1:
            consensus = series_values[0]
            for work in siblings:
                if work.get("seriesNumber") or len(work.get("seriesNumbers", [])) > 1:
                    continue
                work["seriesNumber"] = consensus
                work["metadataProvenance"]["seriesNumber"] = [
                    provenance(
                        consensus,
                        source="catalogue-volume-unanimous",
                        evidence=consensus,
                        evidence_field="volumeId",
                        rule="one distinct non-empty series value within the physical volume",
                        evidence_ids=series_evidence_ids,
                    )
                ]

        if len(year_values) == 1:
            consensus = year_values[0]
            for work in siblings:
                if work.get("years"):
                    continue
                work["years"] = [consensus]
                record = provenance(
                    consensus,
                    source="catalogue-volume-unanimous",
                    evidence=consensus,
                    evidence_field="volumeId",
                    rule="one distinct non-empty year value within the physical volume",
                    evidence_ids=year_evidence_ids,
                )
                work["year"] = consensus
                work["metadataProvenance"]["years"] = [record]
                work["metadataProvenance"]["year"] = [dict(record)]

    return enriched


def coverage_counts(works: Iterable[dict[str, Any]]) -> dict[str, int]:
    values = enrich_works(works)
    return {
        "items": len(values),
        "languages": sum(bool(item["languages"]) for item in values),
        "authors": sum(bool(item["authors"]) for item in values),
        "editors": sum(bool(item["editors"]) for item in values),
        "translationLanguages": sum(
            bool(item["translationLanguages"]) for item in values
        ),
        "seriesNumber": sum(bool(item["seriesNumber"]) for item in values),
        "year": sum(bool(item["year"]) for item in values),
        "multiYearEvidence": sum(len(item["years"]) > 1 for item in values),
    }
