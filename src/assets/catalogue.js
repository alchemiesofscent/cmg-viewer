const PROJECT_PATH = '/cmg-viewer/';

function projectBase() {
  const path = window.location.pathname;
  if (path.startsWith(PROJECT_PATH)) return new URL(PROJECT_PATH, window.location.origin);
  return new URL('./', window.location.href);
}

const BASE_URL = projectBase();
const CATALOGUE_URL = new URL('data/catalogue.json', BASE_URL);

const filterDefinitions = [
  { key: 'authors', queryKey: 'author', label: 'Author' },
  { key: 'editors', queryKey: 'editor', label: 'Editor' },
  { key: 'years', queryKey: 'year', label: 'Year' },
  { key: 'series', queryKey: 'series', label: 'Series / number' },
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
};

const state = {
  items: [],
  query: '',
  sort: 'relevance',
  filters: Object.fromEntries(filterDefinitions.map(({ key }) => [key, new Set()])),
  expanded: new Set(),
  loadController: null,
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
  const seriesLabel = number && collection && !fold(number).startsWith(fold(collection)) ? `${collection} ${number}` : (number || collection || 'Other');
  const languages = listValue(item.languages, item.language, item.textLanguages, item.text_languages);
  const translationLanguages = listValue(item.translationLanguages, item.translation_languages, item.translationLanguage, item.translation_language);
  const searchTerms = listValue(item.searchTerms, item.search_terms, item.keywords);
  const startOrder = numberValue(item.startOrder, item.start_order, item.startPn, item.start_pn, item.pn, item.order, item.start?.order, volume.startOrder) ?? 1;
  const originalUrl = textValue(item.originalUrl || item.original_url || item.cmgUrl || item.cmg_url || item.sourceUrl || item.source_url);
  const fields = [title, work, ...authors, ...editors, ...contributors, ...years, seriesLabel, ...languages, ...translationLanguages, ...searchTerms, id, volumeId];

  return {
    source: item,
    index,
    id,
    volumeId,
    title,
    work,
    authors,
    editors,
    contributors,
    years,
    series: [seriesLabel],
    seriesLabel,
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
  state.sort = ['relevance', 'author', 'year', 'series'].includes(params.get('sort')) ? params.get('sort') : 'relevance';
  elements.search.value = state.query;
  elements.sort.value = state.sort;

  for (const definition of filterDefinitions) {
    state.filters[definition.key] = new Set(params.getAll(definition.queryKey).filter(Boolean));
  }
}

function writeUrlState() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  for (const definition of filterDefinitions) {
    [...state.filters[definition.key]].sort().forEach((value) => params.append(definition.queryKey, value));
  }
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
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
    if (leftCount !== rightCount) return rightCount - leftCount;
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function renderFilters() {
  const fragment = document.createDocumentFragment();

  for (const definition of filterDefinitions) {
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
      return left.seriesLabel.localeCompare(right.seriesLabel, undefined, { numeric: true, sensitivity: 'base' }) || left.title.localeCompare(right.title);
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

function renderResults() {
  const items = filteredItems();
  const fragment = document.createDocumentFragment();

  items.forEach((item) => {
    const card = elements.template.content.firstElementChild.cloneNode(true);
    const url = viewerUrl(item);
    card.dataset.itemId = item.id;
    card.querySelector('.series-pill').textContent = item.seriesLabel;
    card.querySelector('.result-year').textContent = item.years.join('–');
    card.querySelector('.result-year').hidden = item.years.length === 0;
    card.querySelector('.result-title').textContent = item.title;

    const titleLink = card.querySelector('.result-link');
    titleLink.href = url;
    const author = card.querySelector('.result-author');
    author.textContent = item.authors.length ? item.authors.join(' · ') : 'Author not yet indexed';

    const metadata = card.querySelector('.result-metadata');
    addMetadata(metadata, 'Edited by', item.editors);
    addMetadata(metadata, 'Contributors', item.contributors.filter((name) => !item.editors.includes(name)));
    addMetadata(metadata, 'Text', item.languages);
    addMetadata(metadata, 'Translation', item.translationLanguages);

    const openLink = card.querySelector('.open-result');
    openLink.href = url;
    openLink.setAttribute('aria-label', `Open ${item.title} in the reader`);
    fragment.append(card);
  });

  elements.results.replaceChildren(fragment);
  elements.count.textContent = `${items.length.toLocaleString()} ${items.length === 1 ? 'work' : 'works'}`;
  elements.empty.hidden = items.length > 0;
  elements.results.hidden = items.length === 0;
  elements.clearSearch.hidden = state.query.length === 0;
  renderActiveFilters();
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
  state.sort = 'relevance';
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
    elements.loading.hidden = true;
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
readUrlState();
loadCatalogue();
