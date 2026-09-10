import { createProgressStore } from './viewer-progress.js';
const progress = createProgressStore();
const PROJECT_PATH = '/cmg-viewer/';

function projectBase() {
  const path = window.location.pathname;
  if (path.startsWith(PROJECT_PATH)) return new URL(PROJECT_PATH, window.location.origin);
  return new URL('./', window.location.href);
}

const BASE_URL = projectBase();
const CATALOGUE_URL = new URL('data/catalogue.json', BASE_URL);

const CMG_DIVISIONS = [
  { roman: 'I', author: 'Hippocrates' },
  { roman: 'II', author: 'Aretaeus' },
  { roman: 'III', author: 'Rufus of Ephesus' },
  { roman: 'IV', author: 'Soranus' },
  { roman: 'V', author: 'Galen' },
  { roman: 'VI', author: 'Oribasius' },
  { roman: 'VIII', author: 'Aëtius of Amida' },
  { roman: 'IX', author: 'Paul of Aegina' },
];

const CMG_DIVISION_AUTHORS = new Map(
  CMG_DIVISIONS.map(({ roman, author }) => [`CMG ${roman}`, author]),
);

const COLLECTION_ORDER = new Map([
  ['CMG', 0],
  ['CMG Supplementum', 1],
  ['CMG Supplementum Orientale', 2],
  ['CML', 3],
  ['Weitere Ausgaben', 4],
  ['Übersetzungen', 5],
  ['Diels', 6],
]);

const filterDefinitions = [
  { key: 'authors', queryKey: 'author', label: 'Author', sidebar: false },
  { key: 'editors', queryKey: 'editor', label: 'Editor' },
  { key: 'years', queryKey: 'year', label: 'Year' },
  { key: 'series', queryKey: 'series', label: 'Series' },
  { key: 'languages', queryKey: 'lang', label: 'Language' },
  { key: 'translationLanguages', queryKey: 'translation', label: 'Translation language' },
];

const elements = {
  form: document.querySelector('#search-form'),
  search: document.querySelector('#catalogue-search'),
  clearSearch: document.querySelector('#clear-search'),
  filters: document.querySelector('#filters'),
  filterGroups: document.querySelector('#filter-groups'),
  clearFilters: document.querySelector('#clear-filters'),
  activeFilterCount: document.querySelector('#active-filter-count'),
  activeFilters: document.querySelector('#active-filters'),
  sort: document.querySelector('#sort-results'),
  count: document.querySelector('#results-count'),
  loading: document.querySelector('#loading-results'),
  results: document.querySelector('#results'),
  empty: document.querySelector('#empty-state'),
  error: document.querySelector('#error-state'),
  errorMessage: document.querySelector('#error-message'),
  reset: document.querySelector('#reset-search'),
  retry: document.querySelector('#retry-load'),
  template: document.querySelector('#result-template'),
  authorsMenuToggle: document.querySelector('#authors-menu-toggle'),
  authorsMenu: document.querySelector('#authors-menu'),
  authorsMenuClose: document.querySelector('#authors-menu-close'),
  authorsMenuBackdrop: document.querySelector('#authors-menu-backdrop'),
  authorsMenuList: document.querySelector('#authors-menu-list'),
};

const state = {
  items: [],
  query: '',
  sort: 'series',
  filters: Object.fromEntries(filterDefinitions.map(({ key }) => [key, new Set()])),
  expanded: new Set(),
  loadController: null,
  authorsMenuReturnFocus: null,
};

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(' · ');
  if (typeof value === 'object') {
    for (const key of ['name', 'label', 'title', 'value', 'text']) {
      const result = textValue(value[key]);
      if (result) return result;
    }
    for (const localized of Object.values(value)) {
      const result = textValue(localized);
      if (result) return result;
    }
  }
  return '';
}

function listValue(...candidates) {
  const value = candidates.find((candidate) => candidate != null && textValue(candidate));
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return [...new Set(entries.flatMap((entry) => {
    if (typeof entry === 'string' && /\s*[;|]\s*/.test(entry)) return entry.split(/\s*[;|]\s*/);
    return [textValue(entry)];
  }).map((entry) => entry.trim()).filter(Boolean))];
}

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

function numberValue(...values) {
  for (const value of values) {
    const number = Number.parseInt(value, 10);
    if (Number.isInteger(number)) return number;
  }
  return null;
}

function leadingRoman(value) {
  const match = textValue(value).match(/(?:^|\s)([IVXLCDM]+)(?=\s*(?:\d|$))/i);
  return match ? match[1].toUpperCase() : '';
}

function romanNumber(value) {
  const roman = textValue(value).toUpperCase();
  if (!roman || !/^[IVXLCDM]+$/.test(roman)) return Number.MAX_SAFE_INTEGER;
  const digits = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let index = 0; index < roman.length; index += 1) {
    const current = digits[roman[index]];
    const next = digits[roman[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total;
}

function exactSeriesLabel(collection, number) {
  if (number && collection && !fold(number).startsWith(fold(collection))) return `${collection} ${number}`;
  return number || collection || 'Other';
}

function browseSeriesLabel(collection, number, exactLabel) {
  const roman = leadingRoman(number);
  if (!roman) return exactLabel;
  return collection ? `${collection} ${roman}` : roman;
}

function seriesAliasKey(value) {
  return fold(textValue(value).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' '));
}

function normalizeItem(item, index) {
  const volume = item.volume && typeof item.volume === 'object' ? item.volume : {};
  const id = textValue(item.id || item.catalogueItemId || item.catalogue_item_id || `item-${index + 1}`);
  const volumeId = textValue(item.volumeId || item.volume_id || item.viewerId || item.viewer_id || volume.id || item.slug);
  const work = textValue(item.work || item.workTitle || item.work_title);
  const title = textValue(item.title || item.label || item.displayTitle || item.display_title || work) || 'Untitled work';
  const authors = listValue(item.authors, item.author, item.creator, item.creators);
  const editors = listValue(item.editors, item.editor);
  const contributors = listValue(item.contributors, item.contributor);
  const years = listValue(item.years, item.year, item.date, item.publicationYear, item.publication_year);
  const collection = textValue(item.collection || item.collectionLabel || item.collection_label || item.series);
  const number = textValue(item.seriesNumber || item.series_number || item.cmgNumber || item.cmg_number || item.number || volume.number);
  const seriesExact = exactSeriesLabel(collection, number);
  const seriesLabel = browseSeriesLabel(collection, number, seriesExact);
  const seriesRoman = leadingRoman(number);
  const seriesNumbers = listValue(item.seriesNumbers, item.series_numbers, number);
  const languages = listValue(item.languages, item.language, item.textLanguages, item.text_languages);
  const translationLanguages = listValue(item.translationLanguages, item.translation_languages, item.translationLanguage, item.translation_language);
  const searchTerms = listValue(item.searchTerms, item.search_terms, item.keywords);
  const startOrder = numberValue(item.startOrder, item.start_order, item.startPn, item.start_pn, item.pn, item.order, item.start?.order, volume.startOrder) ?? 1;
  const originalUrl = textValue(item.originalUrl || item.original_url || item.cmgUrl || item.cmg_url || item.sourceUrl || item.source_url);
  const fields = [
    title,
    work,
    ...authors,
    ...editors,
    ...contributors,
    ...years,
    seriesLabel,
    seriesExact,
    number,
    ...seriesNumbers,
    ...languages,
    ...translationLanguages,
    ...searchTerms,
    id,
    volumeId,
  ];

  return {
    source: item,
    index,
    id,
    volumeId,
    title,
    work,
    collection,
    authors,
    editors,
    contributors,
    years,
    series: [seriesLabel],
    seriesLabel,
    seriesExact,
    seriesNumber: number,
    seriesRoman,
    seriesOrdinal: romanNumber(seriesRoman),
    languages,
    translationLanguages,
    searchTerms,
    startOrder,
    originalUrl,
    searchText: fold(fields.join(' ')),
  };
}

function extractItems(data) {
  const candidates = [data?.items, data?.catalogueItems, data?.catalogue_items, data?.records, data?.catalogue?.items, data];
  const items = candidates.find(Array.isArray);
  if (!items) throw new Error('The catalogue file does not contain an item list.');
  return items.map(normalizeItem).filter((item) => item.volumeId);
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  state.query = params.get('q')?.trim() || '';
  state.sort = ['relevance', 'author', 'year', 'series'].includes(params.get('sort')) ? params.get('sort') : 'series';
  elements.search.value = state.query;
  elements.sort.value = state.sort;

  for (const definition of filterDefinitions) {
    state.filters[definition.key] = new Set(params.getAll(definition.queryKey).filter(Boolean));
  }
}

function normalizeIncomingSeriesFilters() {
  const aliases = new Map();
  const addAlias = (alias, canonical) => {
    const key = seriesAliasKey(alias);
    if (!key) return;
    if (!aliases.has(key)) aliases.set(key, new Set());
    aliases.get(key).add(canonical);
  };

  for (const item of state.items) {
    addAlias(item.seriesLabel, item.seriesLabel);
    addAlias(item.seriesExact, item.seriesLabel);
    addAlias(item.seriesNumber, item.seriesLabel);
  }

  const normalized = new Set();
  for (const selected of state.filters.series) {
    const matches = aliases.get(seriesAliasKey(selected));
    normalized.add(matches?.size === 1 ? [...matches][0] : selected);
  }
  state.filters.series = normalized;
}

function writeUrlState() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.sort !== 'series') params.set('sort', state.sort);
  for (const definition of filterDefinitions) {
    [...state.filters[definition.key]].sort().forEach((value) => params.append(definition.queryKey, value));
  }
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

function collectionRank(collection) {
  return COLLECTION_ORDER.get(collection) ?? COLLECTION_ORDER.size;
}

function compareSeriesItems(left, right) {
  const rankDifference = collectionRank(left.collection) - collectionRank(right.collection);
  if (rankDifference) return rankDifference;
  const collectionDifference = left.collection.localeCompare(right.collection, undefined, { sensitivity: 'base' });
  if (collectionDifference) return collectionDifference;
  const divisionDifference = left.seriesOrdinal - right.seriesOrdinal;
  if (divisionDifference) return divisionDifference;
  const shelfmarkDifference = left.seriesExact.localeCompare(right.seriesExact, undefined, { numeric: true, sensitivity: 'base' });
  if (shelfmarkDifference) return shelfmarkDifference;
  const volumeDifference = left.volumeId.localeCompare(right.volumeId, undefined, { numeric: true, sensitivity: 'base' });
  if (volumeDifference) return volumeDifference;
  return left.startOrder - right.startOrder || left.index - right.index;
}

function compareSeriesLabels(left, right) {
  const leftItem = state.items.find((item) => item.seriesLabel === left);
  const rightItem = state.items.find((item) => item.seriesLabel === right);
  if (leftItem && rightItem) return compareSeriesItems(leftItem, rightItem);
  if (leftItem) return -1;
  if (rightItem) return 1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function facetOptions(key) {
  const counts = new Map();
  for (const item of state.items) {
    for (const value of item[key]) counts.set(value, (counts.get(value) || 0) + 1);
  }

  const selected = state.filters[key];
  return [...counts.entries()].sort(([left, leftCount], [right, rightCount]) => {
    if (selected.has(left) !== selected.has(right)) return selected.has(left) ? -1 : 1;
    if (key === 'years') return right.localeCompare(left, undefined, { numeric: true });
    if (key === 'series') return compareSeriesLabels(left, right);
    if (leftCount !== rightCount) return rightCount - leftCount;
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function renderFilters() {
  const fragment = document.createDocumentFragment();

  for (const definition of filterDefinitions) {
    if (definition.sidebar === false) continue;
    const group = document.createElement('section');
    group.className = 'filter-group';
    group.dataset.filterKey = definition.key;

    const heading = document.createElement('h3');
    heading.textContent = definition.label;
    group.append(heading);

    const options = document.createElement('div');
    options.className = 'filter-options';
    const allOptions = facetOptions(definition.key);
    const visibleOptions = state.expanded.has(definition.key) ? allOptions : allOptions.slice(0, 8);

    visibleOptions.forEach(([value, count], index) => {
      const label = document.createElement('label');
      label.className = 'filter-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = definition.queryKey;
      input.value = value;
      input.checked = state.filters[definition.key].has(value);
      input.id = `facet-${definition.key}-${index}`;
      input.dataset.filterKey = definition.key;

      const name = document.createElement('span');
      name.textContent = value;
      const optionCount = document.createElement('span');
      optionCount.className = 'option-count';
      optionCount.textContent = String(count);
      optionCount.setAttribute('aria-label', `${count} works`);
      label.append(input, name, optionCount);
      options.append(label);
    });

    group.append(options);
    if (allOptions.length > 8) {
      const more = document.createElement('button');
      more.className = 'show-more';
      more.type = 'button';
      more.dataset.expandFilter = definition.key;
      more.textContent = state.expanded.has(definition.key) ? 'Show fewer' : `Show all ${allOptions.length}`;
      group.append(more);
    }

    if (!allOptions.length) group.hidden = true;
    fragment.append(group);
  }

  elements.filterGroups.replaceChildren(fragment);
}

function authorCounts() {
  const counts = new Map();
  for (const item of state.items) {
    for (const author of item.authors) counts.set(author, (counts.get(author) || 0) + 1);
  }
  return counts;
}

function seriesCounts() {
  const counts = new Map();
  for (const item of state.items) counts.set(item.seriesLabel, (counts.get(item.seriesLabel) || 0) + 1);
  return counts;
}

function authorMenuButton({ key, value, label, meta = '', count = null }) {
  const button = document.createElement('button');
  button.className = 'authors-menu-link';
  button.type = 'button';
  button.dataset.browseKey = key;
  button.dataset.browseValue = value;

  const name = document.createElement('span');
  name.className = 'authors-menu-link-label';
  name.textContent = label;
  button.append(name);

  if (meta) {
    const detail = document.createElement('small');
    detail.className = 'authors-menu-link-meta';
    detail.textContent = meta;
    button.append(detail);
  }

  if (count != null) {
    const tally = document.createElement('small');
    tally.className = 'authors-menu-link-count';
    tally.textContent = String(count);
    tally.setAttribute('aria-hidden', 'true');
    button.append(tally);
    button.setAttribute(
      'aria-label',
      key === 'authors'
        ? `Browse ${count} ${count === 1 ? 'work' : 'works'} by ${label}`
        : `Browse ${count} ${count === 1 ? 'work' : 'works'} in ${value}${meta ? `, ${label}` : ''}`,
    );
  }

  return button;
}

function authorMenuSection(title, entries) {
  const section = document.createElement('li');
  section.className = 'authors-menu-section';
  const heading = document.createElement('h3');
  heading.className = 'authors-menu-section-title';
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'authors-menu-grid';
  for (const entry of entries) {
    const item = document.createElement('li');
    item.append(authorMenuButton(entry));
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function renderAuthorsMenu() {
  if (!elements.authorsMenuList) return;
  const fragment = document.createDocumentFragment();
  const divisionCounts = seriesCounts();
  const divisions = CMG_DIVISIONS.map(({ roman, author }) => {
    const series = `CMG ${roman}`;
    return {
      key: 'series',
      value: series,
      label: author,
      meta: series,
      count: divisionCounts.get(series) || 0,
    };
  }).filter(({ count }) => count > 0);
  if (divisions.length) fragment.append(authorMenuSection('CMG divisions by author', divisions));

  const indexedAuthors = [...authorCounts().entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map(([author, count]) => ({ key: 'authors', value: author, label: author, count }));
  if (indexedAuthors.length) fragment.append(authorMenuSection('All indexed authors', indexedAuthors));

  elements.authorsMenuList.replaceChildren(fragment);
  syncBrowseButtons();
}

function authorsMenuIsOpen() {
  return elements.authorsMenu?.getAttribute('aria-hidden') === 'false';
}

function openAuthorsMenu() {
  if (!elements.authorsMenu || authorsMenuIsOpen()) return;
  state.authorsMenuReturnFocus = document.activeElement;
  elements.authorsMenuToggle?.setAttribute('aria-expanded', 'true');
  elements.authorsMenu.setAttribute('aria-hidden', 'false');
  elements.authorsMenu.removeAttribute('inert');
  if (elements.authorsMenuBackdrop) elements.authorsMenuBackdrop.hidden = false;
  document.body.classList.add('authors-menu-open');
  elements.authorsMenuList?.querySelector('.authors-menu-link')?.focus();
}

function closeAuthorsMenu({ restoreFocus = true } = {}) {
  if (!elements.authorsMenu || !authorsMenuIsOpen()) return;
  elements.authorsMenuToggle?.setAttribute('aria-expanded', 'false');
  elements.authorsMenu.setAttribute('aria-hidden', 'true');
  elements.authorsMenu.setAttribute('inert', '');
  if (elements.authorsMenuBackdrop) elements.authorsMenuBackdrop.hidden = true;
  document.body.classList.remove('authors-menu-open');
  if (restoreFocus && state.authorsMenuReturnFocus instanceof HTMLElement) {
    state.authorsMenuReturnFocus.focus();
  }
  state.authorsMenuReturnFocus = null;
}

function onlyActiveFilter(key, value) {
  if (state.query) return false;
  return filterDefinitions.every((definition) => {
    const selected = state.filters[definition.key];
    if (definition.key === key) return selected.size === 1 && selected.has(value);
    return selected.size === 0;
  });
}

function clearCatalogueState() {
  state.query = '';
  elements.search.value = '';
  for (const definition of filterDefinitions) state.filters[definition.key].clear();
}

function browseBy(key, value) {
  const clearSelection = onlyActiveFilter(key, value);
  clearCatalogueState();
  if (!clearSelection) state.filters[key].add(value);
  state.sort = 'series';
  elements.sort.value = state.sort;
  closeAuthorsMenu({ restoreFocus: false });
  refresh({ filters: true });
  elements.results.focus();
}

function syncBrowseButtons() {
  document.querySelectorAll('[data-browse-key][data-browse-value]').forEach((button) => {
    const selected = state.filters[button.dataset.browseKey]?.has(button.dataset.browseValue) || false;
    button.setAttribute('aria-pressed', String(selected));
    if (selected) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
    button.classList.toggle('is-active', selected);
  });
}

function matchesFilters(item) {
  return filterDefinitions.every(({ key }) => {
    const selected = state.filters[key];
    return selected.size === 0 || item[key].some((value) => selected.has(value));
  });
}

function relevanceScore(item, terms) {
  if (!terms.length) return -item.index;
  let score = 0;
  const title = fold(item.title);
  const author = fold(item.authors.join(' '));
  for (const term of terms) {
    if (title === term) score += 20;
    else if (title.startsWith(term)) score += 12;
    else if (title.includes(term)) score += 8;
    if (author.startsWith(term)) score += 7;
    else if (author.includes(term)) score += 4;
    if (item.searchText.includes(term)) score += 1;
  }
  return score;
}

function filteredItems() {
  const terms = fold(state.query).split(/\s+/).filter(Boolean);
  const matched = state.items.filter((item) => terms.every((term) => item.searchText.includes(term)) && matchesFilters(item));

  return matched.sort((left, right) => {
    if (state.sort === 'author') {
      return (left.authors[0] || left.title).localeCompare(right.authors[0] || right.title, undefined, { sensitivity: 'base' }) || left.title.localeCompare(right.title);
    }
    if (state.sort === 'year') {
      return (Number.parseInt(left.years[0], 10) || 9999) - (Number.parseInt(right.years[0], 10) || 9999) || left.title.localeCompare(right.title);
    }
    if (state.sort === 'series') {
      return compareSeriesItems(left, right);
    }
    return relevanceScore(right, terms) - relevanceScore(left, terms) || left.index - right.index;
  });
}

function viewerUrl(item) {
  const url = new URL(`viewer/${encodeURIComponent(item.volumeId)}/`, BASE_URL);
  url.searchParams.set('pn', String(item.startOrder));
  return url.href;
}

function addMetadata(list, label, values) {
  if (!values.length) return;
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = values.join(', ');
  row.append(term, description);
  list.append(row);
}

function renderCardAuthors(container, item) {
  if (!item.authors.length) {
    container.textContent = 'Author not yet indexed';
    return;
  }

  item.authors.forEach((name, index) => {
    if (index) {
      const separator = document.createElement('span');
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = ' · ';
      container.append(separator);
    }
    const button = document.createElement('button');
    button.className = 'result-author-link';
    button.type = 'button';
    button.dataset.browseKey = 'authors';
    button.dataset.browseValue = name;
    button.setAttribute('aria-label', `Browse all works by ${name}`);
    button.setAttribute('aria-pressed', String(state.filters.authors.has(name)));
    button.textContent = name;
    container.append(button);
  });
}

function resultCard(item) {
  const card = elements.template.content.firstElementChild.cloneNode(true);
  const url = viewerUrl(item);
  card.dataset.itemId = item.id;
  card.dataset.seriesNumber = item.seriesNumber;

  const seriesPill = card.querySelector('.series-pill');
  seriesPill.textContent = item.seriesExact || item.seriesLabel;

  card.querySelector('.result-year').textContent = item.years.join('–');
  card.querySelector('.result-year').hidden = item.years.length === 0;
  card.querySelector('.result-title').textContent = item.title;

  const titleLink = card.querySelector('.result-link');
  titleLink.href = url;
  renderCardAuthors(card.querySelector('.result-author'), item);

  const metadata = card.querySelector('.result-metadata');
  addMetadata(metadata, 'Edited by', item.editors);
  addMetadata(metadata, 'Contributors', item.contributors.filter((name) => !item.editors.includes(name)));
  addMetadata(metadata, 'Text', item.languages);
  addMetadata(metadata, 'Translation', item.translationLanguages);

  const openLink = card.querySelector('.open-result');
  openLink.href = url;
  openLink.setAttribute('aria-label', `Open ${item.title} in the reader`);
  if (progress.get(item.volumeId) != null) {
    const resume = document.createElement('a');
    resume.className = 'result-resume';
    resume.href = new URL(`viewer/${encodeURIComponent(item.volumeId)}/`, BASE_URL).href;
    resume.textContent = 'Resume this volume';
    resume.setAttribute('aria-label', `Resume ${item.title} at your saved reading position`);
    card.querySelector('.result-body').append(resume);
  }
  return card;
}

function safeSeriesAuthor(seriesLabel) {
  if (CMG_DIVISION_AUTHORS.has(seriesLabel)) return CMG_DIVISION_AUTHORS.get(seriesLabel);
  const group = state.items.filter((item) => item.seriesLabel === seriesLabel);
  if (!group.length || group.some((item) => item.authors.length !== 1)) return '';
  const authors = new Set(group.map((item) => item.authors[0]));
  return authors.size === 1 ? [...authors][0] : '';
}

function seriesGroup(seriesLabel, items, index) {
  const section = document.createElement('section');
  section.className = 'series-group';
  const headingId = `series-group-${index + 1}`;
  section.setAttribute('aria-labelledby', headingId);

  const header = document.createElement('header');
  header.className = 'series-group-header';
  const title = document.createElement('h3');
  title.className = 'series-group-title';
  title.id = headingId;
  title.textContent = seriesLabel;
  header.append(title);

  const author = safeSeriesAuthor(seriesLabel);
  if (author) {
    const byline = document.createElement('button');
    byline.className = 'series-group-author';
    byline.type = 'button';
    byline.dataset.browseKey = 'authors';
    byline.dataset.browseValue = author;
    byline.setAttribute('aria-label', `Browse all works by ${author}`);
    byline.textContent = author;
    header.append(byline);
  }

  const count = document.createElement('span');
  count.className = 'series-group-count';
  count.textContent = `${items.length.toLocaleString()} ${items.length === 1 ? 'work' : 'works'}`;
  header.append(count);

  const groupItems = document.createElement('div');
  groupItems.className = 'series-group-items';
  for (const item of items) groupItems.append(resultCard(item));
  section.append(header, groupItems);
  return section;
}

function renderResults() {
  const items = filteredItems();
  const fragment = document.createDocumentFragment();

  if (state.sort === 'series') {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.seriesLabel)) groups.set(item.seriesLabel, []);
      groups.get(item.seriesLabel).push(item);
    }
    [...groups.entries()].forEach(([seriesLabel, groupItems], index) => {
      fragment.append(seriesGroup(seriesLabel, groupItems, index));
    });
  } else {
    for (const item of items) fragment.append(resultCard(item));
  }

  elements.results.replaceChildren(fragment);
  elements.count.textContent = `${items.length.toLocaleString()} ${items.length === 1 ? 'work' : 'works'}`;
  elements.empty.hidden = items.length > 0;
  elements.results.hidden = items.length === 0;
  elements.clearSearch.hidden = state.query.length === 0;
  renderActiveFilters();
  syncBrowseButtons();
}

function renderActiveFilters() {
  const fragment = document.createDocumentFragment();
  let count = 0;

  for (const definition of filterDefinitions) {
    for (const value of state.filters[definition.key]) {
      count += 1;
      const chip = document.createElement('span');
      chip.className = 'active-filter';
      const label = document.createElement('span');
      label.textContent = `${definition.label}: ${value}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.removeFilter = definition.key;
      remove.dataset.filterValue = value;
      remove.setAttribute('aria-label', `Remove ${definition.label} filter ${value}`);
      remove.textContent = '×';
      chip.append(label, remove);
      fragment.append(chip);
    }
  }

  elements.activeFilters.replaceChildren(fragment);
  elements.activeFilterCount.textContent = count ? `${count} active` : 'No filters';
}

function refresh({ filters = false } = {}) {
  writeUrlState();
  if (filters) renderFilters();
  renderResults();
}

function resetAll() {
  state.query = '';
  elements.search.value = '';
  state.sort = 'series';
  elements.sort.value = state.sort;
  filterDefinitions.forEach(({ key }) => state.filters[key].clear());
  refresh({ filters: true });
  elements.search.focus();
}

async function loadCatalogue() {
  state.loadController?.abort();
  state.loadController = new AbortController();
  elements.loading.hidden = false;
  elements.error.hidden = true;
  elements.empty.hidden = true;
  elements.results.hidden = true;

  try {
    const response = await fetch(CATALOGUE_URL, { signal: state.loadController.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`The catalogue request returned ${response.status}.`);
    const data = await response.json();
    state.items = extractItems(data);
    if (!state.items.length) throw new Error('The catalogue does not contain any viewable works.');
    normalizeIncomingSeriesFilters();
    writeUrlState();
    elements.loading.hidden = true;
    renderAuthorsMenu();
    if (elements.authorsMenuToggle) elements.authorsMenuToggle.disabled = false;
    renderFilters();
    renderResults();
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error(error);
    elements.loading.hidden = true;
    elements.results.hidden = true;
    elements.error.hidden = false;
    elements.errorMessage.textContent = error.message || 'Check your connection and try again.';
    elements.count.textContent = 'Catalogue unavailable';
  }
}

elements.form.addEventListener('submit', (event) => event.preventDefault());
elements.search.addEventListener('input', () => {
  state.query = elements.search.value.trim();
  refresh();
});
elements.clearSearch.addEventListener('click', () => {
  state.query = '';
  elements.search.value = '';
  refresh();
  elements.search.focus();
});
elements.sort.addEventListener('change', () => {
  state.sort = elements.sort.value;
  refresh();
});
elements.filterGroups.addEventListener('change', (event) => {
  const input = event.target.closest('input[data-filter-key]');
  if (!input) return;
  const selected = state.filters[input.dataset.filterKey];
  if (input.checked) selected.add(input.value);
  else selected.delete(input.value);
  refresh();
});
elements.filterGroups.addEventListener('click', (event) => {
  const button = event.target.closest('[data-expand-filter]');
  if (!button) return;
  const key = button.dataset.expandFilter;
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  renderFilters();
});
elements.activeFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-filter]');
  if (!button) return;
  state.filters[button.dataset.removeFilter].delete(button.dataset.filterValue);
  refresh({ filters: true });
});
elements.results.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-browse-key][data-browse-value]');
  if (!button) return;
  browseBy(button.dataset.browseKey, button.dataset.browseValue);
});
elements.authorsMenuList?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-browse-key][data-browse-value]');
  if (!button) return;
  browseBy(button.dataset.browseKey, button.dataset.browseValue);
});
elements.authorsMenuToggle?.addEventListener('click', () => {
  if (authorsMenuIsOpen()) closeAuthorsMenu();
  else openAuthorsMenu();
});
elements.authorsMenuClose?.addEventListener('click', () => closeAuthorsMenu());
elements.authorsMenuBackdrop?.addEventListener('click', () => closeAuthorsMenu());
document.addEventListener('keydown', (event) => {
  if (!authorsMenuIsOpen()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeAuthorsMenu();
    return;
  }
  if (event.key === 'Tab') {
    const focusable = [...elements.authorsMenu.querySelectorAll('button:not(:disabled), a[href]')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});
elements.clearFilters.addEventListener('click', () => {
  filterDefinitions.forEach(({ key }) => state.filters[key].clear());
  refresh({ filters: true });
});
elements.reset.addEventListener('click', resetAll);
elements.retry.addEventListener('click', loadCatalogue);

const desktopFilters = window.matchMedia('(min-width: 54.01rem)');
function syncFilterDisclosure() {
  if (desktopFilters.matches) elements.filters.open = true;
}
desktopFilters.addEventListener?.('change', syncFilterDisclosure);
syncFilterDisclosure();
if (elements.authorsMenuToggle) elements.authorsMenuToggle.disabled = true;
readUrlState();
loadCatalogue();

// Refresh resume links after returning through the browser back/forward cache.
window.addEventListener('pageshow', () => { if (state.items.length) renderResults(); });
