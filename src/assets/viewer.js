import { setupSharePanel } from './viewer-share.js';
import { setupToolsMenu } from './viewer-tools.js';
import { setupCorpusContents } from './viewer-corpus.js';
import {
  clampZoom,
  dragZoom,
  isSecondTap,
  pinchZoom,
  pointDistance,
} from './viewer-gesture-math.js';
import { syncTifyPageSelection } from './viewer-navigation.js';
import { pageLoadOrder, startImagePreview } from './viewer-loading.js';

const PROJECT_PATH = '/cmg-viewer/';

function projectBase() {
  const path = window.location.pathname;
  if (path.startsWith(PROJECT_PATH)) return new URL(PROJECT_PATH, window.location.origin);
  const viewerOffset = path.indexOf('/viewer/');
  if (viewerOffset >= 0) return new URL(`${path.slice(0, viewerOffset)}/`, window.location.origin);
  if (path.includes('/templates/')) return new URL('../', window.location.href);
  return new URL('../../', window.location.href);
}

function pathVolumeId() {
  const configured = document.body.dataset.volumeId;
  if (configured && !configured.includes('__')) return configured;
  const segments = window.location.pathname.split('/').filter(Boolean);
  const viewerIndex = segments.lastIndexOf('viewer');
  return viewerIndex >= 0 ? decodeURIComponent(segments[viewerIndex + 1] || '') : '';
}

const BASE_URL = projectBase();
const volumeId = pathVolumeId();
const corpusContents = setupCorpusContents({ baseUrl: BASE_URL, volumeId });
const VOLUME_URL = new URL(`data/volumes/${encodeURIComponent(volumeId)}.json`, BASE_URL);
const MANIFEST_URL = new URL(`iiif/${encodeURIComponent(volumeId)}/manifest.json`, BASE_URL);

const elements = {
  readerApp: document.querySelector('.reader-app'),
  skipLink: document.querySelector('.skip-link'),
  catalogueLink: document.querySelector('#catalogue-link'),
  title: document.querySelector('#volume-title'),
  meta: document.querySelector('#volume-meta'),
  cmgSource: document.querySelector('#cmg-source'),
  share: document.querySelector('#share-view'),
  stage: document.querySelector('#reader-stage'),
  continuousReader: document.querySelector('#continuous-reader'),
  continuousScroll: document.querySelector('#continuous-scroll'),
  continuousPages: document.querySelector('#continuous-pages'),
  doubleTapCatcher: document.querySelector('#double-tap-catcher'),
  zoomHud: document.querySelector('#gesture-zoom-hud'),
  tify: document.querySelector('#tify'),
  fallback: document.querySelector('#fallback-reader'),
  fallbackScroll: document.querySelector('#fallback-scroll'),
  fallbackPages: document.querySelector('#fallback-pages'),
  fallbackNote: document.querySelector('#fallback-note'),
  loading: document.querySelector('#reader-loading'),
  loadingTitle: document.querySelector('#loading-title'),
  loadingDetail: document.querySelector('#loading-detail'),
  error: document.querySelector('#reader-error'),
  errorMessage: document.querySelector('#reader-error-message'),
  errorCmgLink: document.querySelector('#error-cmg-link'),
  retry: document.querySelector('#retry-reader'),
  previous: document.querySelector('#previous-page'),
  next: document.querySelector('#next-page'),
  jumpForm: document.querySelector('#page-jump-form'),
  orderInput: document.querySelector('#page-order'),
  pageStatus: document.querySelector('#page-status'),
  single: document.querySelector('#single-page'),
  spread: document.querySelector('#two-pages'),
  zoomOut: document.querySelector('#zoom-out'),
  zoomIn: document.querySelector('#zoom-in'),
  resetZoom: document.querySelector('#reset-zoom'),
  fullscreen: document.querySelector('#fullscreen'),
  fullscreenNotice: document.querySelector('#fullscreen-notice'),
  drawer: document.querySelector('#contents-drawer'),
  drawerToggle: document.querySelector('#contents-toggle'),
  drawerClose: document.querySelector('#contents-close'),
  drawerBackdrop: document.querySelector('#drawer-backdrop'),
  contents: document.querySelector('#contents-list'),
  contentsProvenance: document.querySelector('#contents-provenance'),
  thumbnailsToggle: document.querySelector('#thumbnails-toggle'),
  infoToggle: document.querySelector('#info-toggle'),
  exportToggle: document.querySelector('#export-toggle'),
  thumbnailStrip: document.querySelector('#thumbnail-strip'),
  thumbnailScroller: document.querySelector('#thumbnail-scroller'),
  thumbnailList: document.querySelector('#thumbnail-list'),
  toolsToggle: document.querySelector('#tools-toggle'),
  secondaryTools: document.querySelector('#reader-secondary-tools'),
  live: document.querySelector('#reader-live'),
};

// Keep the touch reader active when a phone rotates to landscape. This query
// must match the compact layout in viewer.css.
const mobileMedia = window.matchMedia('(max-width: 48rem), (max-width: 64rem) and (max-height: 32rem)');
const CONTINUOUS_ZOOM_MIN = 0.75;
const CONTINUOUS_ZOOM_MAX = 2.5;
const DOUBLE_TAP_DELAY = 300;
const TAP_MAX_DURATION = 250;
const TAP_MAX_TRAVEL = 12;
const DOUBLE_TAP_MAX_DISTANCE = 48;
const CONTINUOUS_IMAGE_RETRY_DELAY = 10000;

const state = {
  volume: {},
  manifest: null,
  pages: [],
  orderIndex: new Map(),
  index: 0,
  mode: new URLSearchParams(window.location.search).get('view') === 'spread' ? 'spread' : 'single',
  zoom: 1,
  tify: null,
  tifyPromise: null,
  tifyFailed: false,
  generation: 0,
  tifyTimer: null,
  tifyPageSignature: '',
  tifyView: '',
  tifyNavigationGuardUntil: 0,
  toc: [],
  tocEntries: [],
  thumbnailsOpen: !mobileMedia.matches,
  thumbnailEntries: [],
  thumbnailsRendered: false,
  thumbnailObserver: null,
  thumbnailPrimaryIndex: null,
  thumbnailVisibleIndices: new Set(),
  continuousEntries: [],
  continuousImageObserver: null,
  continuousLoadedIndices: new Set(),
  continuousScrollFrame: null,
  continuousSettleTimer: null,
  continuousResizeTimer: null,
  continuousResizeObserver: null,
  continuousObservedWidth: 0,
  continuousTargetIndex: null,
  continuousReady: false,
  continuousPrimaryIndex: null,
  toolsOpen: false,
  fullscreenNativeFailed: false,
  fullscreenRequestPending: false,
  fullscreenRequestKind: '',
  fullscreenRequestToken: 0,
  fullscreenLayoutTimer: null,
  fullscreenTransitionToken: 0,
  fullscreenRestoreIndex: null,
  fullscreenNoticeTimer: null,
  sourceUrl: '',
  controller: null,
};

const toolsMenu = setupToolsMenu({
  toggle: elements.toolsToggle,
  panel: elements.secondaryTools,
  onChange: (open) => { state.toolsOpen = open; },
});

const continuousTouchZoom = {
  pointers: new Map(),
  kind: '',
  tapCandidate: null,
  lastTap: null,
  armTimer: null,
  armedFrame: null,
  target: null,
  anchorX: 0.5,
  anchorY: 0.5,
  anchorClientX: 0,
  anchorClientY: 0,
  targetClientX: 0,
  targetClientY: 0,
  startZoom: 1,
  lastDistance: 0,
  startY: 0,
  lastY: 0,
  previewZoom: 1,
  startIndex: 0,
  suppressSync: false,
  moved: false,
  previewFrame: null,
  hudTimer: null,
  hydrationTimer: null,
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
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => {
    if (typeof entry === 'string' && /\s*[;|]\s*/.test(entry)) return entry.split(/\s*[;|]\s*/);
    return [textValue(entry)];
  }).map((entry) => entry.trim()).filter(Boolean))];
}

function integerValue(...values) {
  for (const value of values) {
    const number = Number.parseInt(value, 10);
    if (Number.isInteger(number)) return number;
  }
  return null;
}

function sourcePageLabel(page) {
  const label = textValue(page?.label);
  return label && label !== String(page?.order) ? label : '';
}

function pageDisplay(page, index) {
  const label = sourcePageLabel(page);
  if (!label) return `Page ${integerValue(page?.order) ?? index + 1}`;
  return /^(?:Abb\.|Tafel)\s/i.test(label) ? label : `Page ${label}`;
}

function pageInputValue(page, index) {
  return sourcePageLabel(page) || String(integerValue(page?.order) ?? index + 1);
}

function pageStatusText(indices) {
  if (!indices.length) return '—';
  const pages = indices.map((index) => pageDisplay(state.pages[index], index));
  if (pages.length === 1) return pages[0];
  if (pages.every((page) => page.startsWith('Page '))) {
    return `Pages ${pages.map((page) => page.slice(5)).join('–')}`;
  }
  return pages.join(' + ');
}

function announce(message) {
  elements.live.textContent = '';
  window.requestAnimationFrame(() => { elements.live.textContent = message; });
}

function timeout(ms, message) {
  return new Promise((_, reject) => window.setTimeout(() => reject(new Error(message)), ms));
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url.pathname} returned ${response.status}`);
  return response.json();
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function annotationBody(canvas) {
  let body = canvas?.items?.[0]?.items?.[0]?.body;
  if (body?.type === 'Choice') body = body.items?.[0] || body.default;
  return body || {};
}

function serviceId(body) {
  const service = arrayValue(body?.service)[0] || {};
  return textValue(service.id || service['@id']).replace(/\/info\.json$/i, '');
}

function imageServiceUrl(record, canvas) {
  const body = annotationBody(canvas);
  return textValue(
    record?.imageServiceId || record?.image_service_id || record?.imageService ||
    record?.image_service || record?.serviceId || record?.service_id,
  ) || serviceId(body);
}

function imageUrl(record, canvas) {
  const direct = textValue(record?.imageUrl || record?.image_url || record?.image || record?.resourceUrl || record?.resource_url);
  if (direct) return direct;
  const body = annotationBody(canvas);
  const bodyId = textValue(body.id || body['@id']);
  if (bodyId) return bodyId;
  const service = imageServiceUrl(record, canvas);
  return service ? `${service.replace(/\/$/, '')}/full/full/0/default.jpg` : '';
}

function thumbnailUrl(record, canvas) {
  const direct = textValue(
    record?.thumbnailUrl || record?.thumbnail_url || record?.thumbnail ||
    record?.previewUrl || record?.preview_url,
  );
  if (direct) return direct;
  const thumbnail = arrayValue(canvas?.thumbnail)[0] || {};
  const thumbnailId = textValue(thumbnail.id || thumbnail['@id'] || thumbnail.url || thumbnail.href);
  if (thumbnailId) return thumbnailId;
  const service = imageServiceUrl(record, canvas);
  return service ? `${service.replace(/\/$/, '')}/full/200,/0/default.jpg` : '';
}

function metadataValue(resource, pattern) {
  const entry = arrayValue(resource?.metadata).find((item) => pattern.test(textValue(item?.label)));
  return textValue(entry?.value);
}

function sourcePages(volume) {
  for (const candidate of [volume.pages, volume.canvases, volume.physicalPages, volume.physical_pages, volume.physical?.pages]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function orderMapping(volume, manifestItems) {
  const raw = volume.orderToCanvas || volume.order_to_canvas || volume.orderToCanvasIndex || volume.order_to_canvas_index || {};
  const inverse = new Map();
  const idIndex = new Map(manifestItems.map((canvas, index) => [textValue(canvas.id || canvas['@id']), index]));
  const base = integerValue(volume.canvasIndexBase, volume.canvas_index_base, volume.orderToCanvasBase, volume.order_to_canvas_base) || 0;

  const add = (orderCandidate, target) => {
    const order = integerValue(orderCandidate, target?.order, target?.pn);
    let index = integerValue(target?.canvasIndex, target?.canvas_index, target?.index);
    if (index == null && typeof target === 'number') index = target;
    if (index == null && typeof target === 'string') index = idIndex.get(target);
    if (order != null && index != null) inverse.set(index - base, order);
  };

  if (Array.isArray(raw)) raw.forEach((entry) => add(entry.order || entry.pn, entry));
  else if (raw && typeof raw === 'object') Object.entries(raw).forEach(([order, target]) => add(order, target));
  return inverse;
}

function normalizePages(volume, manifest) {
  const manifestItems = arrayValue(manifest?.items || manifest?.sequences?.[0]?.canvases);
  const records = sourcePages(volume);
  const mappedOrders = orderMapping(volume, manifestItems);
  const recordByIndex = new Map();

  records.forEach((record, position) => {
    const index = integerValue(record?.canvasIndex, record?.canvas_index, record?.index) ?? position;
    recordByIndex.set(index, record);
  });

  const length = Math.max(manifestItems.length, records.length);
  return Array.from({ length }, (_, index) => {
    const record = recordByIndex.get(index) || records[index] || {};
    const canvas = manifestItems[index] || (record?.type === 'Canvas' ? record : {});
    const manifestOrder = metadataValue(canvas, /^(physical\s*)?(order|scan|pn)$/i);
    const order = integerValue(
      record.order,
      record.pn,
      record.physicalOrder,
      record.physical_order,
      mappedOrders.get(index),
      manifestOrder,
    ) ?? index + 1;
    const label = textValue(record.label || record.pageLabel || record.page_label || canvas.label) || String(order);
    const canvasId = textValue(record.canvasId || record.canvas_id || canvas.id || canvas['@id']);
    return {
      index,
      order,
      label,
      canvasId,
      service: imageServiceUrl(record, canvas),
      image: imageUrl(record, canvas),
      thumbnail: thumbnailUrl(record, canvas),
      width: integerValue(record.width, annotationBody(canvas).width, canvas.width),
      height: integerValue(record.height, annotationBody(canvas).height, canvas.height),
    };
  });
}

function sourceLink(volume) {
  const links = volume.links;
  if (Array.isArray(links)) {
    const match = links.find((link) => /cmg|original|source/i.test(textValue(link.rel || link.label)));
    if (match) return textValue(match.url || match.href || match.id);
  }
  if (links && typeof links === 'object') {
    const match = links.cmg || links.original || links.source || links.bbaw;
    const value = textValue(match?.url || match?.href || match);
    if (value) return value;
  }
  return textValue(
    volume.cmgUrl || volume.cmg_url || volume.originalUrl || volume.original_url ||
    volume.sourceUrl || volume.source_url || volume.legacyUrl || volume.legacy_url ||
    volume.source?.viewerUrl || volume.source?.viewer_url || volume.source?.url,
  );
}

function manifestLabel(manifest) {
  return textValue(manifest?.label) || 'Untitled volume';
}

function applyVolumeIdentity(volume, manifest) {
  const title = textValue(volume.title || volume.label || volume.displayTitle || volume.display_title) || manifestLabel(manifest);
  const collection = textValue(volume.collection || volume.series || volume.collectionLabel || volume.collection_label);
  const number = textValue(volume.seriesNumber || volume.series_number || volume.cmgNumber || volume.cmg_number || volume.number);
  const volumeMetadata = volume.metadata && typeof volume.metadata === 'object' ? volume.metadata : {};
  const editors = listValue(volume.editors, volume.editor, volumeMetadata.editors);
  const contributors = listValue(volume.contributors, volume.contributor, volumeMetadata.contributors)
    .filter((name) => !editors.includes(name));
  const years = listValue(
    volume.years,
    volume.year,
    volume.date,
    volume.publicationYear,
    volume.publication_year,
    volumeMetadata.dateIssued,
  );
  const series = number && collection && !number.toLocaleLowerCase().startsWith(collection.toLocaleLowerCase()) ? `${collection} ${number}` : (number || collection);
  const metadata = [
    series,
    years.join('–'),
    editors.length ? `ed. ${editors.join(', ')}` : '',
    contributors.length ? contributors.join(', ') : '',
    `${state.pages.length.toLocaleString()} pages`,
  ].filter(Boolean);

  corpusContents.setVolumeLabel(series || title);
  elements.title.textContent = title;
  elements.meta.textContent = metadata.join(' · ');
  document.title = `${title} · CMG Reader`;
  elements.catalogueLink.href = BASE_URL.href;

  state.sourceUrl = sourceLink(volume);
  elements.cmgSource.hidden = !state.sourceUrl;
  elements.errorCmgLink.href = state.sourceUrl || 'https://cmg.bbaw.de/epubl/online/editionen.html';
  updateSourceHref();
}

function pageIndexFromTarget(target) {
  const directOrder = integerValue(
    target?.startOrder,
    target?.start_order,
    target?.order,
    target?.pn,
    target?.targetOrder,
    target?.target_order,
    target?.start?.order,
    arrayValue(target?.orders)[0],
  );
  if (directOrder != null && state.orderIndex.has(directOrder)) return state.orderIndex.get(directOrder);
  const directIndex = integerValue(target?.canvasIndex, target?.canvas_index, target?.startCanvasIndex, target?.start_canvas_index);
  if (directIndex != null && state.pages[directIndex]) return directIndex;
  const reference = textValue(target?.canvasId || target?.canvas_id || target?.target || target?.id || target?.['@id']).split('#')[0];
  if (reference) {
    const index = state.pages.findIndex((page) => page.canvasId === reference);
    if (index >= 0) return index;
  }
  return null;
}

function tocChildren(node) {
  return arrayValue(node?.children || node?.entries || node?.ranges || node?.items).filter((child) => {
    const type = textValue(child?.type || child?.['@type']);
    return type !== 'Canvas' && (textValue(child?.label || child?.title) || tocChildrenShallow(child).length);
  });
}

function tocChildrenShallow(node) {
  return arrayValue(node?.children || node?.entries || node?.ranges || node?.items);
}

function normalizeTocNode(node, depth = 0) {
  const children = tocChildren(node).map((child) => normalizeTocNode(child, depth + 1)).filter(Boolean);
  let index = pageIndexFromTarget(node);
  if (index == null) index = children.find((child) => child.index != null)?.index ?? null;
  const label = textValue(node?.label || node?.title || node?.name);
  if (!label && !children.length) return null;
  const provenance = listValue(node?.provenance, node?.sources, node?.source).map((source) => {
    if (/^(legacy-)?html$/i.test(source)) return 'CMG';
    if (/^mets$/i.test(source)) return 'METS';
    return source;
  });
  return {
    label: label || 'Untitled section',
    index,
    order: index == null ? null : state.pages[index]?.order,
    depth,
    provenance,
    children,
  };
}

function rangeFirstIndex(range, rangeMap, seen = new Set()) {
  const rangeId = textValue(range?.id || range?.['@id']);
  if (rangeId && seen.has(rangeId)) return null;
  if (rangeId) seen.add(rangeId);
  const own = pageIndexFromTarget(range);
  if (own != null) return own;
  for (const item of arrayValue(range?.items || range?.canvases || range?.ranges)) {
    const reference = typeof item === 'string' ? item : textValue(item?.id || item?.['@id']);
    const pageIndex = state.pages.findIndex((page) => page.canvasId === reference.split('#')[0]);
    if (pageIndex >= 0) return pageIndex;
    const nested = (typeof item === 'object' && item) || rangeMap.get(reference);
    if (nested) {
      const nestedIndex = rangeFirstIndex(nested, rangeMap, seen);
      if (nestedIndex != null) return nestedIndex;
    }
  }
  return null;
}

function normalizeManifestRanges(manifest) {
  const structures = arrayValue(manifest?.structures);
  const rangeMap = new Map();
  const collect = (range) => {
    const id = textValue(range?.id || range?.['@id']);
    if (id) rangeMap.set(id, range);
    arrayValue(range?.items || range?.ranges).forEach((item) => {
      const type = textValue(item?.type || item?.['@type']);
      if (typeof item === 'object' && /range/i.test(type)) collect(item);
    });
  };
  structures.forEach(collect);

  const normalize = (range, depth = 0) => {
    const children = arrayValue(range?.items || range?.ranges).map((item) => {
      const reference = typeof item === 'string' ? item : textValue(item?.id || item?.['@id']);
      const type = textValue(item?.type || item?.['@type']);
      const nested = (/range/i.test(type) && item) || rangeMap.get(reference);
      return nested ? normalize(nested, depth + 1) : null;
    }).filter(Boolean);
    const index = rangeFirstIndex(range, rangeMap);
    return {
      label: textValue(range?.label) || 'Untitled section',
      index,
      order: index == null ? null : state.pages[index]?.order,
      depth,
      provenance: ['METS'],
      children,
    };
  };
  return structures.map((range) => normalize(range)).filter((range) => range.label || range.children.length);
}

function buildToc(volume, manifest) {
  const direct = volume.toc || volume.contents || volume.logicalContents || volume.logical_contents || volume.structures;
  const nodes = arrayValue(direct).map((node) => normalizeTocNode(node)).filter(Boolean);
  return nodes.length ? nodes : normalizeManifestRanges(manifest);
}

function renderToc() {
  state.tocEntries = [];
  const createList = (nodes) => {
    const list = document.createElement('ol');
    for (const node of nodes) {
      const item = document.createElement('li');
      item.className = 'contents-entry';
      item.style.setProperty('--toc-depth', String(node.depth));
      let control;
      if (node.index != null) {
        control = document.createElement('button');
        control.type = 'button';
        control.dataset.pageIndex = String(node.index);
        state.tocEntries.push({ node, control });
      } else {
        control = document.createElement('span');
        control.className = 'contents-label';
      }

      const label = document.createElement('span');
      label.textContent = node.label;
      if (node.provenance.length) {
        const source = document.createElement('span');
        source.className = 'contents-source';
        source.textContent = node.provenance.join('+');
        label.append(' ', source);
      }
      const order = document.createElement('span');
      order.className = 'contents-order';
      order.textContent = node.index == null ? '' : pageDisplay(state.pages[node.index], node.index);
      control.append(label, order);
      item.append(control);
      if (node.children.length) item.append(createList(node.children));
      list.append(item);
    }
    return list;
  };

  if (!state.toc.length) {
    const message = document.createElement('p');
    message.className = 'contents-empty';
    message.textContent = 'No logical contents are available for this volume yet. Use the page field or arrow buttons to move through the volume.';
    elements.contents.replaceChildren(message);
    elements.contentsProvenance.hidden = true;
    return;
  }

  elements.contents.replaceChildren(createList(state.toc));
  const sources = new Set(state.toc.flatMap(function flatten(node) {
    return [...node.provenance, ...node.children.flatMap(flatten)];
  }).map((source) => source.toLocaleLowerCase()));
  elements.contentsProvenance.hidden = !(sources.has('mets') && sources.has('cmg'));
  updateActiveToc();
}

function updateActiveToc() {
  const currentOrder = state.pages[state.index]?.order;
  let active = null;
  for (const entry of state.tocEntries) {
    entry.control.removeAttribute('aria-current');
    if (entry.node.order <= currentOrder && (!active || entry.node.order > active.node.order || (entry.node.order === active.node.order && entry.node.depth > active.node.depth))) active = entry;
  }
  active?.control.setAttribute('aria-current', 'location');
}

function canvasIsNonPaged(index) {
  return arrayValue(state.manifest?.items?.[index]?.behavior).includes('non-paged');
}

function romanPageNumber(value) {
  const roman = textValue(value).toUpperCase();
  if (!/^[IVXLCDM]+$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let index = 0; index < roman.length; index += 1) {
    const current = values[roman[index]];
    const next = values[roman[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total || null;
}

function printedPageNumber(index) {
  const label = sourcePageLabel(state.pages[index]);
  if (/^\d+$/.test(label)) return Number.parseInt(label, 10);
  return romanPageNumber(label);
}

function pageSide(index) {
  if (!state.pages[index] || canvasIsNonPaged(index)) return 'neutral';
  const printed = printedPageNumber(index);
  if (printed != null) return printed % 2 === 1 ? 'recto' : 'verso';

  // Treat an unlabelled opening canvas as a recto even when the source starts
  // its physical ORDER numbering at 2.  Afterwards, source order is a much
  // better side signal than TIFY's zero-based canvas sequence.
  if (index === 0 && !sourcePageLabel(state.pages[index])) return 'recto';
  const order = integerValue(state.pages[index]?.order);
  if (order != null) return order % 2 === 1 ? 'recto' : 'verso';

  const precedingNonPaged = state.pages
    .slice(0, index)
    .filter((_item, precedingIndex) => canvasIsNonPaged(precedingIndex)).length;
  return ((index + 1 + precedingNonPaged) % 2) === 1 ? 'recto' : 'verso';
}

function spreadPageNumbers(index = state.index) {
  if (!state.pages[index]) return [];
  const page = index + 1;
  if (state.mode === 'single') return [page];
  const side = pageSide(index);
  if (side === 'neutral') return [-1, page];

  const facingIndex = side === 'recto' ? index - 1 : index + 1;
  if (!state.pages[facingIndex]) return [0, page];
  const facingSide = pageSide(facingIndex);
  if (facingSide === 'neutral' || facingSide === side) return [-1, page];
  return [page, facingIndex + 1].sort((left, right) => left - right);
}

function currentSpreadIndices() {
  return spreadPageNumbers()
    .filter((page) => page > 0)
    .map((page) => page - 1);
}

function displayedPageIndices() {
  if (state.mode === 'single') return state.pages[state.index] ? [state.index] : [];
  if (state.tify) {
    const indices = arrayValue(state.tify.options?.pages)
      .map(Number)
      .filter((pageNumber) => pageNumber > 0 && state.pages[pageNumber - 1])
      .map((pageNumber) => pageNumber - 1);
    if (indices.length) return [...new Set(indices)];
  }
  return currentSpreadIndices();
}

function loadThumbnailImage(image) {
  const source = image.dataset.src;
  if (!source) return;
  image.fetchPriority = 'low';
  image.src = source;
  image.removeAttribute('data-src');
}

function observeThumbnailImages() {
  state.thumbnailObserver?.disconnect();
  state.thumbnailObserver = null;
  const images = state.thumbnailEntries.map((entry) => entry?.image).filter(Boolean);
  if (!('IntersectionObserver' in window)) {
    images.forEach(loadThumbnailImage);
    return;
  }
  state.thumbnailObserver = new IntersectionObserver((observations) => {
    for (const observation of observations) {
      if (!observation.isIntersecting) continue;
      loadThumbnailImage(observation.target);
      state.thumbnailObserver?.unobserve(observation.target);
    }
  }, {
    root: elements.thumbnailScroller,
    rootMargin: '0px 700px',
    threshold: 0.01,
  });
  images.forEach((image) => state.thumbnailObserver.observe(image));
}

function centerThumbnail(index, { smooth = true } = {}) {
  if (elements.thumbnailStrip.hidden) return;
  const entry = state.thumbnailEntries[index];
  if (!entry) return;
  window.requestAnimationFrame(() => {
    if (elements.thumbnailStrip.hidden || state.thumbnailPrimaryIndex !== index) return;
    const scrollerBounds = elements.thumbnailScroller.getBoundingClientRect();
    const buttonBounds = entry.button.getBoundingClientRect();
    const inset = 8;
    if (buttonBounds.left >= scrollerBounds.left + inset && buttonBounds.right <= scrollerBounds.right - inset) return;
    const distance = buttonBounds.right < scrollerBounds.left
      ? scrollerBounds.left - buttonBounds.right
      : buttonBounds.left - scrollerBounds.right;
    const nearby = distance <= scrollerBounds.width * 1.5;
    entry.button.scrollIntoView({
      behavior: smooth && nearby && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto',
      block: 'nearest',
      inline: 'center',
    });
  });
}

function updateThumbnailRail({ center = true, smooth = true } = {}) {
  if (!state.thumbnailEntries.length || !state.pages[state.index]) return;
  const visibleIndices = new Set(displayedPageIndices());
  for (const index of state.thumbnailVisibleIndices) {
    const entry = state.thumbnailEntries[index];
    if (!entry) continue;
    entry.button.removeAttribute('data-visible');
    entry.button.setAttribute('aria-label', entry.label);
  }
  if (state.thumbnailPrimaryIndex != null) {
    const previous = state.thumbnailEntries[state.thumbnailPrimaryIndex];
    previous?.button.removeAttribute('aria-current');
    if (previous) previous.button.tabIndex = -1;
  }

  state.thumbnailPrimaryIndex = state.index;
  state.thumbnailVisibleIndices = visibleIndices;
  for (const index of visibleIndices) {
    const entry = state.thumbnailEntries[index];
    if (!entry) continue;
    entry.button.dataset.visible = 'true';
    if (index !== state.index) entry.button.setAttribute('aria-label', `${entry.label}; visible in current spread`);
  }
  const current = state.thumbnailEntries[state.index];
  current.button.setAttribute('aria-current', 'page');
  current.button.tabIndex = 0;
  if (center) centerThumbnail(state.index, { smooth });
}

function renderThumbnailRail() {
  state.thumbnailObserver?.disconnect();
  state.thumbnailObserver = null;
  state.thumbnailEntries = [];
  state.thumbnailPrimaryIndex = null;
  state.thumbnailVisibleIndices = new Set();
  const fragment = document.createDocumentFragment();

  state.pages.forEach((page, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumbnail-button';
    button.dataset.pageIndex = String(index);
    button.tabIndex = -1;
    const printedLabel = sourcePageLabel(page);
    const label = printedLabel
      ? `Open ${pageDisplay(page, index)}; position ${index + 1} of ${state.pages.length}`
      : `Open page ${index + 1} of ${state.pages.length}`;
    button.setAttribute('aria-label', label);

    const frame = document.createElement('span');
    frame.className = 'thumbnail-image-frame';
    let image = null;
    if (page.thumbnail) {
      image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.fetchPriority = 'low';
      image.draggable = false;
      image.width = 200;
      image.height = page.width && page.height ? Math.round(200 * page.height / page.width) : 280;
      image.dataset.src = page.thumbnail;
      image.addEventListener('error', () => {
        button.dataset.imageFailed = 'true';
        image.hidden = true;
      }, { once: true });
      frame.append(image);
    } else {
      button.dataset.imageFailed = 'true';
    }

    const caption = document.createElement('span');
    caption.className = 'thumbnail-caption';
    const order = document.createElement('span');
    order.textContent = pageDisplay(page, index);
    caption.append(order);
    button.append(frame, caption);
    item.append(button);
    fragment.append(item);
    state.thumbnailEntries[index] = { button, image, label };
  });

  elements.thumbnailList.replaceChildren(fragment);
  state.thumbnailsRendered = true;
  observeThumbnailImages();
  updateThumbnailRail({ center: false });
}

function setThumbnailStripOpen(open, { smooth = false } = {}) {
  state.thumbnailsOpen = Boolean(open);
  if (state.thumbnailsOpen && !state.thumbnailsRendered) renderThumbnailRail();
  elements.thumbnailStrip.hidden = !state.thumbnailsOpen;
  elements.thumbnailsToggle.setAttribute('aria-expanded', String(state.thumbnailsOpen));
  elements.thumbnailsToggle.setAttribute('aria-label', `${state.thumbnailsOpen ? 'Hide' : 'Show'} page thumbnails`);
  if (state.thumbnailsOpen) centerThumbnail(state.index, { smooth });
}

function updateAddress() {
  const page = state.pages[state.index];
  if (!page) return;
  const url = new URL(window.location.href);
  url.searchParams.set('pn', String(page.order));
  url.searchParams.set('view', state.mode);
  try {
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (error) {
    console.warn('The page URL could not be updated.', error);
  }
}

function updateSourceHref() {
  if (!state.sourceUrl) return;
  try {
    const source = new URL(state.sourceUrl);
    if (/\.php$/i.test(source.pathname)) {
      source.searchParams.set('custom', '1');
      source.searchParams.set('pn', String(state.pages[state.index]?.order || 1));
      source.searchParams.set('AnzFrames', '1');
    }
    elements.cmgSource.href = source.href;
    elements.errorCmgLink.href = source.href;
  } catch {
    elements.cmgSource.href = state.sourceUrl;
    elements.errorCmgLink.href = state.sourceUrl;
  }
}

function continuousImagePixelWidth(page, requestedWidth) {
  const sourceWidth = integerValue(page?.width) || 2000;
  const maximumWidth = Math.min(sourceWidth, state.zoom > 1.01 ? 3600 : 2000);
  return Math.min(maximumWidth, Math.max(400, Math.ceil(requestedWidth / 400) * 400 || 1200));
}

function continuousImageUrl(page, width) {
  if (page?.service) return `${page.service.replace(/\/$/, '')}/full/${width},/0/default.jpg`;
  if (page?.image && !/\/full\/full\/0\/default\.(?:jpe?g|png)$/i.test(page.image)) return page.image;
  if (page?.thumbnail) return page.thumbnail;
  return '';
}

function hydrateContinuousImage(index) {
  const entry = state.continuousEntries[index];
  if (!entry || entry.failed) return;
  const page = state.pages[index];
  const renderedWidth = entry.frame.getBoundingClientRect().width || Math.min(elements.continuousScroll.clientWidth, 1100);
  const requestedWidth = Math.ceil(renderedWidth * Math.min(window.devicePixelRatio || 1, 2));
  const pixelWidth = continuousImagePixelWidth(page, requestedWidth);
  if (entry.image && entry.pixelWidth >= pixelWidth) return;
  if (
    entry.image
    && entry.failedPixelWidth === pixelWidth
    && Date.now() - entry.failedAt < CONTINUOUS_IMAGE_RETRY_DELAY
  ) return;
  const primary = index === (state.continuousTargetIndex ?? state.index);
  if (entry.pendingImage && entry.pendingPixelWidth >= pixelWidth) {
    if (primary) {
      entry.pendingImage.fetchPriority = 'high';
      showContinuousPreview(entry, page, index);
    }
    return;
  }
  if (entry.pendingImage) {
    entry.pendingImage.removeAttribute('src');
    entry.pendingImage.remove();
    entry.pendingImage = null;
    entry.pendingPixelWidth = 0;
  }
  const source = continuousImageUrl(page, pixelWidth);
  if (!source) {
    if (!entry.image) {
      entry.failed = true;
      entry.frame.dataset.imageFailed = 'true';
    }
    return;
  }

  const image = document.createElement('img');
  let usingThumbnailFallback = false;
  const printedLabel = sourcePageLabel(page);
  image.alt = printedLabel
    ? `${pageDisplay(page, index)}, position ${index + 1} of ${state.pages.length}`
    : `Page ${index + 1} of ${state.pages.length}`;
  image.decoding = 'async';
  image.loading = 'eager';
  image.fetchPriority = primary ? 'high' : 'low';
  image.draggable = false;
  if (page.width) image.width = page.width;
  if (page.height) image.height = page.height;
  image.addEventListener('load', async () => {
    // Keep the preview (or existing zoom level) visible through image decode.
    try { await image.decode?.(); } catch { /* The load event still permits display. */ }
    if (entry.pendingImage !== image) return;
    const previousImage = entry.image;
    entry.pendingImage = null;
    entry.pendingPixelWidth = 0;
    entry.image = image;
    entry.pixelWidth = usingThumbnailFallback ? Math.min(pixelWidth, 400) : pixelWidth;
    entry.failedPixelWidth = usingThumbnailFallback ? pixelWidth : 0;
    entry.failedAt = usingThumbnailFallback ? Date.now() : 0;
    entry.failed = false;
    entry.frame.prepend(image);
    entry.cancelPreview?.();
    entry.cancelPreview = null;
    previousImage?.removeAttribute('src');
    previousImage?.remove();
    entry.frame.removeAttribute('data-loading');
    entry.frame.removeAttribute('data-image-failed');
    state.continuousLoadedIndices.add(index);
  }, { once: true });
  image.addEventListener('error', () => {
    if (entry.pendingImage !== image) return;
    if (!entry.image && page.thumbnail && source !== page.thumbnail && !usingThumbnailFallback) {
      usingThumbnailFallback = true;
      image.src = page.thumbnail;
      return;
    }
    entry.pendingImage = null;
    entry.pendingPixelWidth = 0;
    entry.failedPixelWidth = pixelWidth;
    entry.failedAt = Date.now();
    entry.cancelPreview?.();
    entry.cancelPreview = null;
    image.removeAttribute('src');
    image.remove();
    entry.frame.removeAttribute('data-loading');
    if (!entry.image) {
      entry.failed = true;
      entry.frame.dataset.imageFailed = 'true';
      state.continuousLoadedIndices.delete(index);
    }
  });
  if (!entry.image) entry.frame.dataset.loading = 'true';
  entry.pendingImage = image;
  entry.pendingPixelWidth = pixelWidth;
  state.continuousLoadedIndices.add(index);
  if (primary) showContinuousPreview(entry, page, index);
  image.src = source;
}

function showContinuousPreview(entry, page, index) {
  if (entry.image || entry.cancelPreview || !page.thumbnail || entry.pendingPixelWidth <= 400) return;
  if (page.thumbnail === continuousImageUrl(page, entry.pendingPixelWidth)) return;
  entry.cancelPreview = startImagePreview(entry.frame, page.thumbnail, {
    alt: `${pageDisplay(page, index)} (preview)`,
    width: page.width,
    height: page.height,
  });
}

function releaseContinuousImage(index) {
  const entry = state.continuousEntries[index];
  if (!entry) return;
  const images = [entry.image, entry.pendingImage];
  entry.cancelPreview?.();
  entry.cancelPreview = null;
  entry.image = null;
  entry.pixelWidth = 0;
  entry.pendingImage = null;
  entry.pendingPixelWidth = 0;
  entry.failedPixelWidth = 0;
  entry.failedAt = 0;
  entry.frame.removeAttribute('data-loading');
  for (const image of images) {
    image?.removeAttribute('src');
    image?.remove();
  }
  state.continuousLoadedIndices.delete(index);
}

function releaseDistantContinuousImages(activeIndex) {
  for (const index of [...state.continuousLoadedIndices]) {
    if (Math.abs(index - activeIndex) <= 8) continue;
    releaseContinuousImage(index);
  }
}

function updateContinuousSelection(index) {
  if (state.continuousPrimaryIndex != null) {
    const previous = state.continuousEntries[state.continuousPrimaryIndex];
    previous?.figure.removeAttribute('data-current');
    previous?.figure.removeAttribute('aria-current');
  }
  const current = state.continuousEntries[index];
  if (current) {
    current.figure.dataset.current = 'true';
    current.figure.setAttribute('aria-current', 'page');
  }
  state.continuousPrimaryIndex = index;
}

function renderContinuousPages() {
  cancelContinuousTouchZoom();
  for (const index of [...state.continuousLoadedIndices]) releaseContinuousImage(index);
  state.continuousImageObserver?.disconnect();
  state.continuousImageObserver = null;
  state.continuousResizeObserver?.disconnect();
  state.continuousResizeObserver = null;
  if (state.continuousScrollFrame != null) window.cancelAnimationFrame(state.continuousScrollFrame);
  state.continuousScrollFrame = null;
  if (state.continuousSettleTimer != null) window.clearTimeout(state.continuousSettleTimer);
  state.continuousSettleTimer = null;
  if (state.continuousResizeTimer != null) window.clearTimeout(state.continuousResizeTimer);
  state.continuousResizeTimer = null;
  state.continuousObservedWidth = 0;
  state.continuousEntries = [];
  state.continuousLoadedIndices = new Set();
  state.continuousPrimaryIndex = null;
  state.continuousReady = false;
  const fragment = document.createDocumentFragment();

  state.pages.forEach((page, index) => {
    const figure = document.createElement('figure');
    figure.className = 'continuous-page';
    figure.dataset.pageIndex = String(index);
    figure.setAttribute('aria-label', pageDisplay(page, index));

    const frame = document.createElement('div');
    frame.className = 'continuous-image-frame';
    const width = integerValue(page.width) || 2;
    const height = integerValue(page.height) || 3;
    frame.style.aspectRatio = `${width} / ${height}`;

    const caption = document.createElement('figcaption');
    caption.textContent = pageDisplay(page, index);
    figure.append(frame, caption);
    fragment.append(figure);
    state.continuousEntries[index] = {
      figure,
      frame,
      image: null,
      pixelWidth: 0,
      pendingImage: null,
      pendingPixelWidth: 0,
      cancelPreview: null,
      failedPixelWidth: 0,
      failedAt: 0,
      failed: false,
    };
  });

  elements.continuousPages.replaceChildren(fragment);
  updateContinuousSelection(state.index);
  if ('ResizeObserver' in window) {
    state.continuousResizeObserver = new ResizeObserver((observations) => {
      if (state.mode !== 'single' || elements.continuousReader.hidden) return;
      const width = observations[0]?.contentRect?.width || elements.continuousScroll.clientWidth;
      if (Math.abs(width - state.continuousObservedWidth) < 1) return;
      state.continuousObservedWidth = width;
      if (state.continuousResizeTimer != null) window.clearTimeout(state.continuousResizeTimer);
      state.continuousResizeTimer = window.setTimeout(() => {
        state.continuousResizeTimer = null;
        scrollToContinuousPage(state.index, { behavior: 'auto' });
      }, 120);
    });
    state.continuousResizeObserver.observe(elements.continuousScroll);
  }
}

function observeContinuousImages() {
  state.continuousImageObserver?.disconnect();
  if (!('IntersectionObserver' in window)) {
    for (const index of pageLoadOrder(state.index, state.pages.length)) {
      hydrateContinuousImage(index);
    }
    return;
  }
  state.continuousImageObserver = new IntersectionObserver((observations) => {
    for (const observation of observations) {
      if (!observation.isIntersecting) continue;
      hydrateContinuousImage(Number(observation.target.dataset.pageIndex));
    }
  }, {
    root: elements.continuousScroll,
    rootMargin: '50% 0px',
    threshold: 0.01,
  });
  state.continuousEntries.forEach((entry) => state.continuousImageObserver.observe(entry.figure));
}

function currentContinuousIndex() {
  if (!state.continuousEntries.length) return 0;
  const readingLine = elements.continuousScroll.scrollTop + elements.continuousScroll.clientHeight * 0.34;
  let low = 0;
  let high = state.continuousEntries.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (state.continuousEntries[middle].figure.offsetTop <= readingLine) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function commitContinuousIndex(index) {
  if (!state.pages[index]) return;
  releaseDistantContinuousImages(index);
  if (index === state.index) {
    hydrateContinuousImage(index);
    return;
  }
  state.index = index;
  hydrateContinuousImage(index);
  updateContinuousSelection(index);
  updatePageUi({ centerThumbnail: false, smoothThumbnail: false, updateUrl: false });
  if (state.continuousSettleTimer != null) window.clearTimeout(state.continuousSettleTimer);
  state.continuousSettleTimer = window.setTimeout(() => {
    state.continuousSettleTimer = null;
    if (state.mode !== 'single') return;
    for (const nearby of pageLoadOrder(state.index, state.pages.length)) {
      hydrateContinuousImage(nearby);
    }
    updateAddress();
    centerThumbnail(state.index, { smooth: false });
  }, 180);
}

function scheduleContinuousPageSync() {
  if (continuousTouchZoom.kind || continuousTouchZoom.suppressSync || state.continuousScrollFrame != null || state.mode !== 'single' || elements.continuousReader.hidden) return;
  state.continuousScrollFrame = window.requestAnimationFrame(() => {
    state.continuousScrollFrame = null;
    const observedIndex = currentContinuousIndex();
    if (state.continuousTargetIndex != null && observedIndex !== state.continuousTargetIndex) return;
    if (observedIndex === state.continuousTargetIndex) state.continuousTargetIndex = null;
    commitContinuousIndex(observedIndex);
  });
}

function cancelContinuousTarget() {
  if (state.continuousTargetIndex == null) return;
  state.continuousTargetIndex = null;
  scheduleContinuousPageSync();
}

function scrollToContinuousPage(index, { behavior } = {}) {
  const entry = state.continuousEntries[index];
  if (!entry || elements.continuousReader.hidden) return;
  const distance = Math.abs(index - currentContinuousIndex());
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = behavior || (!reducedMotion && distance <= 4 ? 'smooth' : 'auto');
  state.continuousTargetIndex = index;
  updateContinuousSelection(index);
  releaseDistantContinuousImages(index);
  for (const nearby of pageLoadOrder(index, state.pages.length)) {
    hydrateContinuousImage(nearby);
  }
  elements.continuousScroll.scrollTo({
    top: Math.max(0, entry.figure.offsetTop - 16),
    behavior: scrollBehavior,
  });
  window.setTimeout(() => {
    if (state.continuousTargetIndex === index) cancelContinuousTarget();
  }, scrollBehavior === 'smooth' ? 800 : 0);
}

function activateContinuousReader(index, { behavior } = {}) {
  if (elements.continuousReader.hidden) return;
  window.requestAnimationFrame(() => {
    scrollToContinuousPage(index, { behavior });
    if (!state.continuousReady) {
      observeContinuousImages();
      state.continuousReady = true;
    }
  });
}

function updateReaderSurface() {
  const panelOpen = Boolean(state.tify && ['info', 'export'].includes(textValue(state.tify.options?.view)));
  const continuousActive = state.mode === 'single' && !panelOpen;
  const tifyActive = Boolean(state.tify && (state.mode === 'spread' || panelOpen));
  const fallbackActive = !state.tify && state.mode === 'spread' && !panelOpen;
  elements.continuousReader.hidden = !continuousActive;
  elements.tify.hidden = !tifyActive;
  elements.fallback.hidden = !fallbackActive;
  elements.continuousReader.setAttribute('aria-hidden', String(!continuousActive));
  elements.tify.setAttribute('aria-hidden', String(!tifyActive));
  elements.fallback.setAttribute('aria-hidden', String(!fallbackActive));
  if (!continuousActive) cancelContinuousTouchZoom();
  if (continuousActive && !state.continuousReady) activateContinuousReader(state.index, { behavior: 'auto' });
  if (tifyActive) {
    window.requestAnimationFrame(() => {
      state.tify?.viewer?.viewport?.resize?.();
      state.tify?.viewer?.viewport?.applyConstraints?.();
    });
  }
}

function renderFallback() {
  const indices = currentSpreadIndices();
  const spreadPages = spreadPageNumbers();
  const fragment = document.createDocumentFragment();

  for (const index of indices) {
    const page = state.pages[index];
    const printedLabel = sourcePageLabel(page);
    const frame = document.createElement('figure');
    frame.className = 'scan-frame';
    const image = document.createElement('img');
    image.src = page.image;
    image.alt = printedLabel
      ? `${pageDisplay(page, index)}, position ${index + 1} of ${state.pages.length}`
      : `Page ${index + 1} of ${state.pages.length}`;
    image.decoding = 'async';
    image.draggable = false;
    if (page.width) image.width = page.width;
    if (page.height) image.height = page.height;
    image.addEventListener('error', () => {
      frame.classList.add('image-failed');
      image.remove();
    }, { once: true });
    const caption = document.createElement('figcaption');
    caption.textContent = pageDisplay(page, index);
    frame.append(image, caption);
    fragment.append(frame);
  }

  elements.fallbackPages.replaceChildren(fragment);
  elements.fallbackPages.dataset.direction = textValue(state.volume.viewingDirection || state.volume.viewing_direction) || 'left-to-right';
  delete elements.fallbackPages.dataset.spreadSide;
  if (state.mode === 'spread' && indices.length === 1 && spreadPages.includes(0)) {
    elements.fallbackPages.dataset.spreadSide = pageSide(state.index);
  }
  applyFallbackZoom();
}

function applyFallbackZoom() {
  elements.fallbackPages.style.width = `${Math.round(state.zoom * 100)}%`;
  elements.fallbackPages.dataset.zoomed = state.zoom > 1.01 ? 'true' : 'false';
  elements.resetZoom.textContent = state.zoom === 1 ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
}

function applyContinuousZoom({ restorePage = false } = {}) {
  const percentage = Math.round(state.zoom * 100);
  if (state.zoom === 1) {
    elements.continuousPages.style.removeProperty('width');
    elements.continuousPages.style.removeProperty('max-width');
    elements.continuousPages.removeAttribute('data-zoomed');
  } else {
    elements.continuousPages.style.width = `${percentage}%`;
    elements.continuousPages.style.maxWidth = `${68 * state.zoom}rem`;
    elements.continuousPages.dataset.zoomed = 'true';
  }
  if (state.zoom > 1.01) elements.continuousScroll.dataset.zoomed = 'true';
  else elements.continuousScroll.removeAttribute('data-zoomed');
  elements.continuousReader.dataset.readerZoom = String(state.zoom);
  elements.resetZoom.textContent = state.zoom === 1 ? 'Fit' : `${percentage}%`;
  if (restorePage && state.mode === 'single') {
    window.requestAnimationFrame(() => {
      for (let index = Math.max(0, state.index - 1); index <= Math.min(state.pages.length - 1, state.index + 1); index += 1) {
        hydrateContinuousImage(index);
      }
      scrollToContinuousPage(state.index, { behavior: 'auto' });
    });
  }
}

function clampContinuousZoom(value) {
  return clampZoom(value, { min: CONTINUOUS_ZOOM_MIN, max: CONTINUOUS_ZOOM_MAX });
}

function continuousTouchZoomEnabled(event) {
  return Boolean(
    event.pointerType === 'touch'
    && mobileMedia.matches
    && state.mode === 'single'
    && !elements.continuousReader.hidden
    && !['info', 'export'].includes(textValue(state.tify?.options?.view)),
  );
}

function setContinuousZoomHud(zoom, { kind = continuousTouchZoom.kind, visible = true } = {}) {
  if (continuousTouchZoom.hudTimer != null) {
    window.clearTimeout(continuousTouchZoom.hudTimer);
    continuousTouchZoom.hudTimer = null;
  }
  const percentage = Math.round(clampContinuousZoom(zoom) * 100);
  const limit = percentage >= Math.round(CONTINUOUS_ZOOM_MAX * 100)
    ? ' max'
    : (percentage <= Math.round(CONTINUOUS_ZOOM_MIN * 100) ? ' min' : '');
  elements.zoomHud.textContent = kind === 'double-drag'
    ? `↑ in · ↓ out · ${percentage}%${limit}`
    : `${percentage}%${limit}`;
  if (visible) elements.zoomHud.dataset.visible = 'true';
  else elements.zoomHud.removeAttribute('data-visible');
}

function clearContinuousDoubleTap() {
  if (continuousTouchZoom.armTimer != null) window.clearTimeout(continuousTouchZoom.armTimer);
  continuousTouchZoom.armTimer = null;
  elements.doubleTapCatcher.removeAttribute('data-armed');
  elements.doubleTapCatcher.style.removeProperty('left');
  elements.doubleTapCatcher.style.removeProperty('top');
  continuousTouchZoom.armedFrame = null;
  continuousTouchZoom.lastTap = null;
}

function armContinuousDoubleTap(frame, point) {
  clearContinuousDoubleTap();
  continuousTouchZoom.lastTap = {
    time: window.performance.now(),
    x: point.x,
    y: point.y,
    frame,
  };
  continuousTouchZoom.armedFrame = frame;
  const readerRect = elements.continuousReader.getBoundingClientRect();
  elements.doubleTapCatcher.style.left = `${point.x - readerRect.left}px`;
  elements.doubleTapCatcher.style.top = `${point.y - readerRect.top}px`;
  elements.doubleTapCatcher.dataset.armed = 'true';
  continuousTouchZoom.armTimer = window.setTimeout(clearContinuousDoubleTap, DOUBLE_TAP_DELAY);
}

function continuousZoomAnchor(clientX, clientY, preferredTarget = null) {
  const hit = document.elementFromPoint(clientX, clientY);
  const target = hit?.closest?.('.continuous-page')
    || preferredTarget?.closest?.('.continuous-page')
    || state.continuousEntries[state.index]?.figure
    || elements.continuousPages;
  const rect = target.getBoundingClientRect();
  return {
    target,
    x: rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0.5,
    y: rect.height ? Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) : 0.5,
    clientX,
    clientY,
  };
}

function captureContinuousTouchPointer(pointerId) {
  try {
    elements.continuousReader.setPointerCapture(pointerId);
  } catch {
    // A browser may already have cancelled a contact claimed for native scrolling.
  }
}

function beginContinuousTouchZoom(kind, anchor) {
  clearContinuousDoubleTap();
  cancelContinuousTarget();
  setToolsOpen(false);
  continuousTouchZoom.kind = kind;
  continuousTouchZoom.target = anchor.target;
  continuousTouchZoom.anchorX = anchor.x;
  continuousTouchZoom.anchorY = anchor.y;
  continuousTouchZoom.anchorClientX = anchor.clientX;
  continuousTouchZoom.anchorClientY = anchor.clientY;
  continuousTouchZoom.targetClientX = anchor.clientX;
  continuousTouchZoom.targetClientY = anchor.clientY;
  continuousTouchZoom.startZoom = state.zoom;
  continuousTouchZoom.startIndex = state.index;
  continuousTouchZoom.previewZoom = state.zoom;
  continuousTouchZoom.suppressSync = true;
  continuousTouchZoom.moved = false;
  continuousTouchZoom.tapCandidate = null;
  continuousTouchZoom.target.dataset.gestureTarget = 'true';
  continuousTouchZoom.target.style.transformOrigin = `${anchor.x * 100}% ${anchor.y * 100}%`;
  elements.continuousScroll.dataset.gestureActive = 'true';
  if (state.continuousScrollFrame != null) window.cancelAnimationFrame(state.continuousScrollFrame);
  state.continuousScrollFrame = null;
  const addressUpdatePending = state.continuousSettleTimer != null;
  if (state.continuousSettleTimer != null) window.clearTimeout(state.continuousSettleTimer);
  state.continuousSettleTimer = null;
  if (addressUpdatePending) updateAddress();
  state.continuousTargetIndex = null;
  setContinuousZoomHud(state.zoom, { kind, visible: true });
}

function beginContinuousPinch() {
  const points = [...continuousTouchZoom.pointers.values()].slice(0, 2);
  if (points.length < 2) return;
  const distance = pointDistance(points[0], points[1]);
  if (distance < 8) return;
  const clientX = (points[0].x + points[1].x) / 2;
  const clientY = (points[0].y + points[1].y) / 2;
  beginContinuousTouchZoom('pinch', continuousZoomAnchor(clientX, clientY));
  continuousTouchZoom.lastDistance = distance;
  for (const point of points) captureContinuousTouchPointer(point.id);
}

function beginContinuousDoubleDrag(event, frame) {
  beginContinuousTouchZoom('double-drag', continuousZoomAnchor(event.clientX, event.clientY, frame));
  continuousTouchZoom.startY = event.clientY;
  continuousTouchZoom.lastY = event.clientY;
  captureContinuousTouchPointer(event.pointerId);
}

function queueContinuousZoomPreview(zoom, targetClientX, targetClientY) {
  continuousTouchZoom.previewZoom = clampContinuousZoom(zoom);
  continuousTouchZoom.targetClientX = targetClientX;
  continuousTouchZoom.targetClientY = targetClientY;
  continuousTouchZoom.moved = continuousTouchZoom.moved
    || Math.abs(continuousTouchZoom.previewZoom - continuousTouchZoom.startZoom) >= 0.005;
  if (continuousTouchZoom.previewFrame != null) return;
  continuousTouchZoom.previewFrame = window.requestAnimationFrame(() => {
    continuousTouchZoom.previewFrame = null;
    if (!continuousTouchZoom.kind || !continuousTouchZoom.target) return;
    const scale = continuousTouchZoom.previewZoom / continuousTouchZoom.startZoom;
    const translateX = continuousTouchZoom.kind === 'pinch'
      ? continuousTouchZoom.targetClientX - continuousTouchZoom.anchorClientX
      : 0;
    const translateY = continuousTouchZoom.kind === 'pinch'
      ? continuousTouchZoom.targetClientY - continuousTouchZoom.anchorClientY
      : 0;
    continuousTouchZoom.target.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
    setContinuousZoomHud(continuousTouchZoom.previewZoom);
  });
}

function releaseContinuousTouchPointers() {
  for (const pointerId of continuousTouchZoom.pointers.keys()) {
    try {
      if (elements.continuousReader.hasPointerCapture(pointerId)) elements.continuousReader.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture is already gone after pointerup/pointercancel in some browsers.
    }
  }
  continuousTouchZoom.pointers.clear();
}

function finishContinuousTouchZoom({ commit = true, showResult = true } = {}) {
  if (!continuousTouchZoom.kind) return;
  const target = continuousTouchZoom.target;
  const anchorX = continuousTouchZoom.anchorX;
  const anchorY = continuousTouchZoom.anchorY;
  const clientX = continuousTouchZoom.targetClientX;
  const clientY = continuousTouchZoom.targetClientY;
  const nextZoom = continuousTouchZoom.previewZoom;
  const startIndex = continuousTouchZoom.startIndex;
  const changed = continuousTouchZoom.moved && Math.abs(nextZoom - state.zoom) >= 0.005;

  if (continuousTouchZoom.previewFrame != null) window.cancelAnimationFrame(continuousTouchZoom.previewFrame);
  continuousTouchZoom.previewFrame = null;
  target?.style.removeProperty('transform');
  target?.style.removeProperty('transform-origin');
  target?.removeAttribute('data-gesture-target');
  elements.continuousScroll.removeAttribute('data-gesture-active');
  continuousTouchZoom.kind = '';
  continuousTouchZoom.target = null;
  continuousTouchZoom.tapCandidate = null;
  clearContinuousDoubleTap();
  releaseContinuousTouchPointers();

  if (commit && changed && target?.isConnected) {
    state.zoom = clampContinuousZoom(nextZoom);
    applyContinuousZoom();
    const rect = target.getBoundingClientRect();
    const deltaX = rect.left + (rect.width * anchorX) - clientX;
    const deltaY = rect.top + (rect.height * anchorY) - clientY;
    const maximumLeft = Math.max(0, elements.continuousScroll.scrollWidth - elements.continuousScroll.clientWidth);
    const maximumTop = Math.max(0, elements.continuousScroll.scrollHeight - elements.continuousScroll.clientHeight);
    elements.continuousScroll.scrollLeft = Math.max(0, Math.min(maximumLeft, elements.continuousScroll.scrollLeft + deltaX));
    elements.continuousScroll.scrollTop = Math.max(0, Math.min(maximumTop, elements.continuousScroll.scrollTop + deltaY));
    if (continuousTouchZoom.hydrationTimer != null) window.clearTimeout(continuousTouchZoom.hydrationTimer);
    continuousTouchZoom.hydrationTimer = window.setTimeout(() => {
      continuousTouchZoom.hydrationTimer = null;
      if (state.mode !== 'single' || elements.continuousReader.hidden) return;
      for (let index = Math.max(0, startIndex - 1); index <= Math.min(state.pages.length - 1, startIndex + 1); index += 1) {
        hydrateContinuousImage(index);
      }
    }, 140);
    window.requestAnimationFrame(() => {
      if (!continuousTouchZoom.kind) continuousTouchZoom.suppressSync = false;
    });
    announce(`Zoom ${Math.round(state.zoom * 100)} percent.`);
  } else {
    continuousTouchZoom.suppressSync = false;
  }

  if (showResult) {
    setContinuousZoomHud(commit && changed ? state.zoom : nextZoom, { kind: '', visible: true });
    continuousTouchZoom.hudTimer = window.setTimeout(() => setContinuousZoomHud(state.zoom, { visible: false }), 450);
  } else {
    setContinuousZoomHud(state.zoom, { visible: false });
  }
}

function cancelContinuousTouchZoom() {
  finishContinuousTouchZoom({ commit: false, showResult: false });
  if (continuousTouchZoom.hydrationTimer != null) window.clearTimeout(continuousTouchZoom.hydrationTimer);
  continuousTouchZoom.hydrationTimer = null;
  continuousTouchZoom.suppressSync = false;
  continuousTouchZoom.tapCandidate = null;
  clearContinuousDoubleTap();
  releaseContinuousTouchPointers();
  setContinuousZoomHud(state.zoom, { visible: false });
}

function handleContinuousPointerDown(event) {
  cancelContinuousTarget();
  if (!continuousTouchZoomEnabled(event)) return;
  const lastTap = continuousTouchZoom.lastTap;
  const frame = event.target === elements.doubleTapCatcher
    ? lastTap?.frame
    : event.target.closest?.('.continuous-image-frame');
  const insideScroll = elements.continuousScroll.contains(event.target);
  if (!insideScroll && event.target !== elements.doubleTapCatcher) return;
  if (continuousTouchZoom.kind) {
    event.preventDefault();
    return;
  }
  const point = { id: event.pointerId, x: event.clientX, y: event.clientY };
  continuousTouchZoom.pointers.set(event.pointerId, point);

  if (continuousTouchZoom.pointers.size >= 2) {
    event.preventDefault();
    beginContinuousPinch();
    return;
  }

  if (!frame) {
    clearContinuousDoubleTap();
    continuousTouchZoom.tapCandidate = null;
    return;
  }

  if (
    lastTap
    && lastTap.frame === frame
    && window.performance.now() - lastTap.time <= DOUBLE_TAP_DELAY
    && isSecondTap(
      { ...lastTap, target: lastTap.frame },
      { ...point, time: window.performance.now(), target: frame },
      { maxDelay: DOUBLE_TAP_DELAY, maxDistance: DOUBLE_TAP_MAX_DISTANCE },
    )
  ) {
    event.preventDefault();
    beginContinuousDoubleDrag(event, frame);
    return;
  }

  if (lastTap) clearContinuousDoubleTap();
  continuousTouchZoom.tapCandidate = {
    pointerId: event.pointerId,
    startedAt: window.performance.now(),
    startX: event.clientX,
    startY: event.clientY,
    frame,
  };
}

function handleContinuousPointerMove(event) {
  const point = continuousTouchZoom.pointers.get(event.pointerId);
  if (!point) return;
  point.x = event.clientX;
  point.y = event.clientY;

  if (continuousTouchZoom.kind === 'pinch') {
    event.preventDefault();
    const points = [...continuousTouchZoom.pointers.values()].slice(0, 2);
    if (points.length < 2) return;
    const distance = pointDistance(points[0], points[1]);
    const clientX = (points[0].x + points[1].x) / 2;
    const clientY = (points[0].y + points[1].y) / 2;
    queueContinuousZoomPreview(
      pinchZoom(
        continuousTouchZoom.previewZoom,
        continuousTouchZoom.lastDistance,
        distance,
        { min: CONTINUOUS_ZOOM_MIN, max: CONTINUOUS_ZOOM_MAX },
      ),
      clientX,
      clientY,
    );
    continuousTouchZoom.lastDistance = distance;
    return;
  }

  if (continuousTouchZoom.kind === 'double-drag') {
    event.preventDefault();
    const distanceFromStart = event.clientY - continuousTouchZoom.startY;
    if (!continuousTouchZoom.moved && Math.abs(distanceFromStart) < 7) return;
    const deltaY = continuousTouchZoom.moved
      ? event.clientY - continuousTouchZoom.lastY
      : distanceFromStart - (Math.sign(distanceFromStart) * 7);
    queueContinuousZoomPreview(
      dragZoom(continuousTouchZoom.previewZoom, deltaY, {
        sensitivity: 180,
        min: CONTINUOUS_ZOOM_MIN,
        max: CONTINUOUS_ZOOM_MAX,
      }),
      continuousTouchZoom.anchorClientX,
      continuousTouchZoom.anchorClientY,
    );
    continuousTouchZoom.lastY = event.clientY;
    return;
  }

  const candidate = continuousTouchZoom.tapCandidate;
  if (candidate?.pointerId === event.pointerId && Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) > TAP_MAX_TRAVEL) {
    continuousTouchZoom.tapCandidate = null;
    clearContinuousDoubleTap();
  }
}

function handleContinuousPointerUp(event) {
  if (!continuousTouchZoom.pointers.has(event.pointerId)) return;
  continuousTouchZoom.pointers.delete(event.pointerId);
  if (continuousTouchZoom.kind === 'pinch') {
    if (continuousTouchZoom.pointers.size < 2) finishContinuousTouchZoom();
    return;
  }
  if (continuousTouchZoom.kind === 'double-drag') {
    finishContinuousTouchZoom();
    return;
  }

  const candidate = continuousTouchZoom.tapCandidate;
  continuousTouchZoom.tapCandidate = null;
  if (
    candidate?.pointerId === event.pointerId
    && window.performance.now() - candidate.startedAt <= TAP_MAX_DURATION
    && Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) <= TAP_MAX_TRAVEL
  ) {
    armContinuousDoubleTap(candidate.frame, { x: event.clientX, y: event.clientY });
  }
}

function handleContinuousPointerCancel(event) {
  if (!continuousTouchZoom.pointers.has(event.pointerId) && !continuousTouchZoom.kind) return;
  continuousTouchZoom.pointers.delete(event.pointerId);
  cancelContinuousTouchZoom();
}

function handleContinuousLostPointerCapture(event) {
  if (event.target === elements.continuousReader && continuousTouchZoom.kind) handleContinuousPointerCancel(event);
}

function preventNativeContinuousTouchGesture(event) {
  if (!mobileMedia.matches || state.mode !== 'single' || elements.continuousReader.hidden) return;
  if (event.touches.length > 1 || continuousTouchZoom.kind) event.preventDefault();
}

function canLoadTify() {
  return Boolean(
    state.manifest && !state.tifyFailed && new URLSearchParams(window.location.search).get('fallback') !== '1',
  );
}

function updateTifyViewControls() {
  const canStart = canLoadTify();
  const enabled = Boolean(state.tify || (canStart && !state.tifyPromise));
  const view = state.tify ? textValue(state.tify.options?.view) : '';
  state.tifyView = view;
  for (const [name, button, label] of [
    ['info', elements.infoToggle, 'volume information'],
    ['export', elements.exportToggle, 'export options'],
  ]) {
    const active = view === name;
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', `${active ? 'Hide' : 'Show'} ${label}`);
  }
}

async function toggleTifyView(name) {
  if (!['info', 'export'].includes(name)) return;
  if (elements.drawer.dataset.open === 'true') closeDrawer({ restoreFocus: false });
  setToolsOpen(false);
  if (!state.tify) {
    elements.loadingTitle.textContent = name === 'info' ? 'Opening volume information' : 'Preparing export options';
    elements.loadingDetail.textContent = 'Starting the full IIIF interface…';
    elements.loading.hidden = false;
    try {
      await ensureTify();
    } catch (error) {
      elements.loading.hidden = true;
      announce(`The full IIIF interface could not be opened: ${error.message}`);
      return;
    }
    elements.loading.hidden = true;
  }
  const nextView = textValue(state.tify.options?.view) === name ? null : name;
  if (nextView && state.mode === 'single') syncTifyPages();
  state.tify.setView(nextView);
  updateTifyViewControls();
  updateReaderSurface();
}

function updatePageUi({ centerThumbnail: shouldCenterThumbnail = true, smoothThumbnail = true, updateUrl = true } = {}) {
  const page = state.pages[state.index];
  if (!page) return;
  const visibleIndices = currentSpreadIndices();
  if (document.activeElement !== elements.orderInput) elements.orderInput.value = pageInputValue(page, state.index);
  elements.orderInput.removeAttribute('min');
  elements.orderInput.removeAttribute('max');
  elements.orderInput.setCustomValidity('');
  elements.previous.disabled = state.index <= 0;
  elements.next.disabled = state.index >= state.pages.length - 1;
  elements.single.setAttribute('aria-pressed', String(state.mode === 'single'));
  elements.spread.setAttribute('aria-pressed', String(state.mode === 'spread'));
  elements.pageStatus.textContent = pageStatusText(visibleIndices);
  updateTifyViewControls();
  if (updateUrl) updateAddress();
  updateSourceHref();
  updateActiveToc();
  updateThumbnailRail({ center: shouldCenterThumbnail, smooth: smoothThumbnail });
}

function syncTifyPages() {
  if (!state.tify) return;
  state.tifyNavigationGuardUntil = window.performance.now() + 900;
  syncTifyPageSelection(state.tify, spreadPageNumbers());
}

function setCurrentIndex(index, { updateViewer = true, speak = true, scrollBehavior } = {}) {
  const nextIndex = Math.max(0, Math.min(state.pages.length - 1, index));
  state.index = nextIndex;
  updateContinuousSelection(nextIndex);
  if (state.mode === 'single') {
    const panelOpen = Boolean(state.tify && ['info', 'export'].includes(textValue(state.tify.options?.view)));
    if (state.tify && updateViewer && panelOpen) syncTifyPages();
    updateReaderSurface();
    if (updateViewer && !panelOpen) activateContinuousReader(nextIndex, { behavior: scrollBehavior });
  } else if (state.tify && updateViewer) {
    syncTifyPages();
    updateReaderSurface();
  } else if (!state.tify) {
    renderFallback();
    updateReaderSurface();
  }
  updatePageUi();
  if (speak) announce(elements.pageStatus.textContent);
}

function setMode(mode) {
  if (!['single', 'spread'].includes(mode)) return;
  cancelContinuousTouchZoom();
  if (state.mode === mode) {
    setToolsOpen(false);
    return;
  }
  if (state.tify && ['info', 'export'].includes(textValue(state.tify.options?.view))) state.tify.setView(null);
  state.mode = mode;
  state.zoom = 1;
  applyFallbackZoom();
  applyContinuousZoom();
  updateReaderSurface();
  setCurrentIndex(state.index, { scrollBehavior: 'auto' });
  setToolsOpen(false);
  if (mode === 'spread' && !state.tify && canLoadTify()) {
    ensureTify().catch((error) => {
      console.info('TIFY unavailable; continuing with the built-in reader.', error);
      elements.fallbackNote.textContent = 'Basic reader active. Full-resolution images are loaded directly from BBAW.';
      announce('The full IIIF interface is unavailable; the basic facing-page reader remains active.');
      updateReaderSurface();
    });
  }
}

function firstIndexFromQuery() {
  const requested = integerValue(new URLSearchParams(window.location.search).get('pn'));
  if (requested == null) {
    const defaultOrder = integerValue(state.volume.defaultPn, state.volume.default_pn, state.volume.startPn, state.volume.start_pn);
    return defaultOrder != null && state.orderIndex.has(defaultOrder) ? state.orderIndex.get(defaultOrder) : 0;
  }
  if (state.orderIndex.has(requested)) return state.orderIndex.get(requested);
  window.setTimeout(() => announce(`The linked page is not present in this volume. Opened page 1 instead.`), 100);
  return 0;
}

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const existing = [...document.styleSheets].find((sheet) => sheet.href === href);
    if (existing) return resolve(href);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve(href);
    link.onerror = () => {
      link.remove();
      reject(new Error(`Could not load ${href}`));
    };
    document.head.append(link);
  });
}

async function loadTifyAssets() {
  const candidates = [
    new URL('assets/vendor/tify/', BASE_URL),
    new URL('assets/tify/', BASE_URL),
    new URL('vendor/tify/', BASE_URL),
  ];
  let lastError;
  for (const directory of candidates) {
    try {
      const [module] = await Promise.all([
        import(new URL('tify.js', directory).href),
        loadStylesheet(new URL('tify.css', directory).href),
      ]);
      return module.default || module.Tify;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Self-hosted TIFY assets are not available.');
}

async function startTify(generation = state.generation) {
  if (!state.manifest || new URLSearchParams(window.location.search).get('fallback') === '1') throw new Error('Basic reader requested.');
  const Tify = await Promise.race([loadTifyAssets(), timeout(8000, 'TIFY assets timed out.')]);
  const pages = spreadPageNumbers();
  const viewer = new Tify({
    container: '#tify',
    manifestUrl: MANIFEST_URL.href,
    language: 'en',
    fallbackLanguage: 'en',
    colorMode: 'light',
    pageLabelFormat: 'P&nbsp;· L',
    pages,
    viewer: {
      immediateRender: true,
      showNavigationControl: false,
      preserveViewport: true,
    },
  });
  try {
    await Promise.race([viewer.ready, timeout(12000, 'TIFY did not become ready.')]);
  } catch (error) {
    viewer.destroy?.();
    throw error;
  }
  if (generation !== state.generation) {
    viewer.destroy?.();
    throw new Error('A newer reader load replaced this IIIF viewer.');
  }
  state.tify = viewer;
  elements.fallbackPages.replaceChildren();
  syncTifyPages();
  state.tifyPageSignature = arrayValue(state.tify.options?.pages).map(Number).join(',');
  state.tifyView = textValue(state.tify.options?.view);
  window.__cmgTify = viewer;
  updateReaderSurface();
  updatePageUi();

  state.tifyTimer = window.setInterval(() => {
    const rawPages = arrayValue(state.tify?.options?.pages).map(Number);
    const displayed = rawPages.filter((page) => page > 0);
    if (!displayed.length) return;
    const signature = rawPages.join(',');
    const displayedIndices = displayed.map((page) => page - 1);
    const observedIndex = displayedIndices.includes(state.index) ? state.index : displayedIndices[0];
    const observedMode = rawPages.length > 1 ? 'spread' : 'single';
    let observedView = textValue(state.tify?.options?.view);
    if (observedView && !['info', 'export'].includes(observedView)) {
      state.tify.setView(null);
      observedView = '';
    }
    let changed = signature !== state.tifyPageSignature;
    state.tifyPageSignature = signature;
    if (observedView !== state.tifyView) {
      state.tifyView = observedView;
      changed = true;
    }
    const shellOwnsNavigation = state.mode === 'single' || window.performance.now() < state.tifyNavigationGuardUntil;
    if (!shellOwnsNavigation && state.pages[observedIndex] && observedIndex !== state.index) {
      state.index = observedIndex;
      changed = true;
    }
    if (!shellOwnsNavigation && observedMode !== state.mode && !(state.mode === 'spread' && state.index === state.pages.length - 1)) {
      state.mode = observedMode;
      changed = true;
    }
    if (changed) {
      updateReaderSurface();
      updatePageUi({ centerThumbnail: false, smoothThumbnail: false });
    }
  }, 350);
}

function ensureTify() {
  if (state.tify) return Promise.resolve(state.tify);
  if (state.tifyPromise) return state.tifyPromise;
  const generation = state.generation;
  let pending;
  pending = startTify(generation)
    .then(() => state.tify)
    .catch((error) => {
      if (generation === state.generation) state.tifyFailed = true;
      throw error;
    })
    .finally(() => {
      if (state.tifyPromise === pending) state.tifyPromise = null;
      if (generation === state.generation) updateTifyViewControls();
    });
  state.tifyPromise = pending;
  updateTifyViewControls();
  return pending;
}

function showError(error) {
  console.error(error);
  elements.loading.hidden = true;
  elements.continuousReader.hidden = true;
  elements.fallback.hidden = true;
  elements.tify.hidden = true;
  elements.thumbnailStrip.hidden = true;
  elements.thumbnailsToggle.disabled = true;
  elements.thumbnailsToggle.setAttribute('aria-expanded', 'false');
  elements.thumbnailsToggle.setAttribute('aria-label', 'Show page thumbnails');
  updateTifyViewControls();
  elements.error.hidden = false;
  elements.errorMessage.textContent = error?.message || 'The page data may be temporarily unavailable.';
}

async function initialize() {
  if (!volumeId) {
    showError(new Error('No volume identifier was supplied in the viewer URL.'));
    return;
  }

  state.generation += 1;
  cancelContinuousTouchZoom();
  state.controller?.abort();
  state.controller = new AbortController();
  if (state.tifyTimer) window.clearInterval(state.tifyTimer);
  state.tifyTimer = null;
  state.tify?.destroy?.();
  state.tify = null;
  state.tifyPromise = null;
  state.tifyFailed = false;
  state.tifyPageSignature = '';
  state.tifyView = '';
  state.tifyNavigationGuardUntil = 0;
  state.continuousImageObserver?.disconnect();
  state.continuousImageObserver = null;
  state.continuousResizeObserver?.disconnect();
  state.continuousResizeObserver = null;
  if (state.continuousScrollFrame != null) window.cancelAnimationFrame(state.continuousScrollFrame);
  state.continuousScrollFrame = null;
  if (state.continuousSettleTimer != null) window.clearTimeout(state.continuousSettleTimer);
  state.continuousSettleTimer = null;
  if (state.continuousResizeTimer != null) window.clearTimeout(state.continuousResizeTimer);
  state.continuousResizeTimer = null;
  state.continuousObservedWidth = 0;
  for (const index of [...state.continuousLoadedIndices]) releaseContinuousImage(index);
  state.continuousEntries = [];
  state.continuousLoadedIndices = new Set();
  state.continuousPrimaryIndex = null;
  state.continuousReady = false;
  elements.continuousPages.replaceChildren();
  state.thumbnailObserver?.disconnect();
  state.thumbnailObserver = null;
  state.thumbnailEntries = [];
  state.thumbnailsRendered = false;
  state.thumbnailPrimaryIndex = null;
  state.thumbnailVisibleIndices = new Set();
  elements.thumbnailList.replaceChildren();
  elements.thumbnailStrip.hidden = true;
  elements.thumbnailsToggle.disabled = true;
  elements.thumbnailsToggle.setAttribute('aria-expanded', 'false');
  elements.thumbnailsToggle.setAttribute('aria-label', 'Show page thumbnails');
  updateTifyViewControls();
  elements.error.hidden = true;
  elements.continuousReader.hidden = true;
  elements.fallback.hidden = true;
  elements.fallbackPages.replaceChildren();
  elements.tify.hidden = true;
  elements.loading.hidden = false;
  elements.loadingTitle.textContent = 'Preparing the volume';
  elements.loadingDetail.textContent = 'Loading its description and IIIF manifest…';

  const [volumeResult, manifestResult] = await Promise.allSettled([
    fetchJson(VOLUME_URL, state.controller.signal),
    fetchJson(MANIFEST_URL, state.controller.signal),
  ]);
  if (state.controller.signal.aborted) return;

  state.volume = volumeResult.status === 'fulfilled' ? volumeResult.value : {};
  state.manifest = manifestResult.status === 'fulfilled' ? manifestResult.value : null;
  if (volumeResult.status === 'rejected' && manifestResult.status === 'rejected') {
    showError(new Error(`Neither the volume record nor its IIIF manifest could be loaded (${volumeResult.reason.message}; ${manifestResult.reason.message}).`));
    return;
  }

  state.pages = normalizePages(state.volume, state.manifest);
  state.orderIndex = new Map();
  state.pages.forEach((page, index) => {
    if (!state.orderIndex.has(page.order)) state.orderIndex.set(page.order, index);
  });
  if (!state.pages.length || !state.pages.some((page) => page.image)) {
    showError(new Error('No usable page images were found for this volume.'));
    return;
  }

  state.index = firstIndexFromQuery();
  state.zoom = 1;
  applyContinuousZoom();
  applyVolumeIdentity(state.volume, state.manifest);
  state.toc = buildToc(state.volume, state.manifest);
  renderToc();
  renderContinuousPages();
  elements.thumbnailsToggle.disabled = false;
  setThumbnailStripOpen(state.thumbnailsOpen);
  updatePageUi();
  updateReaderSurface();
  elements.loadingTitle.textContent = 'Opening the image reader';
  elements.loadingDetail.textContent = 'Starting the self-hosted IIIF interface…';
  if (state.mode === 'single') {
    elements.loading.hidden = true;
    announce(`Opened ${elements.title.textContent}, ${elements.pageStatus.textContent}`);
    return;
  }

  try {
    await ensureTify();
    elements.loading.hidden = true;
    updateReaderSurface();
    if (state.mode !== 'single') announce(`Opened ${elements.title.textContent}, ${elements.pageStatus.textContent}`);
  } catch (error) {
    console.info('TIFY unavailable; continuing with the built-in reader.', error);
    elements.loading.hidden = true;
    if (state.mode === 'spread') renderFallback();
    updateReaderSurface();
    elements.fallbackNote.textContent = state.manifest
      ? 'Basic reader active. Full-resolution images are loaded directly from BBAW.'
      : 'Fallback record active. This volume does not currently have a complete METS-derived manifest.';
    if (state.mode !== 'single') announce(`Opened the basic reader. ${elements.pageStatus.textContent}`);
  }
}

function movePage(direction) {
  const step = state.mode === 'spread' ? 2 : 1;
  setCurrentIndex(state.index + direction * step);
}

function changeZoom(factor) {
  cancelContinuousTouchZoom();
  if (state.mode === 'single' && !['info', 'export'].includes(textValue(state.tify?.options?.view))) {
    state.zoom = clampContinuousZoom(Math.round(state.zoom * factor * 100) / 100);
    applyContinuousZoom({ restorePage: true });
    return;
  }
  if (state.tify?.viewer?.viewport) {
    state.tify.viewer.viewport.zoomBy(factor);
    state.tify.viewer.viewport.applyConstraints();
    return;
  }
  state.zoom = Math.max(0.75, Math.min(4, Math.round(state.zoom * factor * 100) / 100));
  applyFallbackZoom();
}

function resetZoom() {
  cancelContinuousTouchZoom();
  if (state.mode === 'single' && !['info', 'export'].includes(textValue(state.tify?.options?.view))) {
    state.zoom = 1;
    applyContinuousZoom({ restorePage: true });
    return;
  }
  if (state.tify) {
    state.tify.resetScan(true);
    return;
  }
  state.zoom = 1;
  elements.fallbackScroll.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  applyFallbackZoom();
}

function nativeFullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement
    || document.msFullscreenElement
    || null;
}

function fullscreenMethod(owner, names) {
  for (const name of names) {
    if (typeof owner?.[name] === 'function') return owner[name];
  }
  return null;
}

function nativeFullscreenRequest({ ignoreFailure = false } = {}) {
  if (state.fullscreenNativeFailed && !ignoreFailure) return null;
  const standard = fullscreenMethod(elements.readerApp, ['requestFullscreen']);
  if (standard && document.fullscreenEnabled !== false) return standard;
  const webkit = fullscreenMethod(elements.readerApp, ['webkitRequestFullscreen', 'webkitRequestFullScreen']);
  if (webkit && document.webkitFullscreenEnabled !== false) return webkit;
  const legacy = fullscreenMethod(elements.readerApp, ['mozRequestFullScreen', 'msRequestFullscreen']);
  return legacy;
}

function nativeFullscreenExit() {
  return fullscreenMethod(document, [
    'exitFullscreen',
    'webkitExitFullscreen',
    'webkitCancelFullScreen',
    'mozCancelFullScreen',
    'msExitFullscreen',
  ]);
}

function focusFullscreenActive() {
  return elements.readerApp.dataset.fullscreenMode === 'focus';
}

function hideFullscreenNotice() {
  if (state.fullscreenNoticeTimer != null) window.clearTimeout(state.fullscreenNoticeTimer);
  state.fullscreenNoticeTimer = null;
  elements.fullscreenNotice.hidden = true;
}

function showFullscreenNotice(message) {
  hideFullscreenNotice();
  elements.fullscreenNotice.textContent = message;
  elements.fullscreenNotice.hidden = false;
  state.fullscreenNoticeTimer = window.setTimeout(hideFullscreenNotice, 3200);
}

function beginFullscreenLayoutTransition() {
  cancelContinuousTouchZoom();
  state.fullscreenTransitionToken += 1;
  state.fullscreenRestoreIndex = state.index;
  continuousTouchZoom.suppressSync = true;
  if (state.continuousScrollFrame != null) window.cancelAnimationFrame(state.continuousScrollFrame);
  state.continuousScrollFrame = null;
  const addressUpdatePending = state.continuousSettleTimer != null;
  if (state.continuousSettleTimer != null) window.clearTimeout(state.continuousSettleTimer);
  state.continuousSettleTimer = null;
  if (addressUpdatePending) updateAddress();
  state.continuousTargetIndex = null;
}

function refreshFullscreenLayout() {
  if (state.fullscreenLayoutTimer != null) window.clearTimeout(state.fullscreenLayoutTimer);
  const token = state.fullscreenTransitionToken;
  const restoreIndex = state.fullscreenRestoreIndex ?? state.index;
  state.fullscreenLayoutTimer = window.setTimeout(() => {
    state.fullscreenLayoutTimer = null;
    if (token !== state.fullscreenTransitionToken) return;
    if (state.mode === 'single' && !elements.continuousReader.hidden) {
      scrollToContinuousPage(restoreIndex, { behavior: 'auto' });
    }
    state.tify?.viewer?.viewport?.resize?.();
    state.tify?.viewer?.viewport?.applyConstraints?.();
    window.requestAnimationFrame(() => {
      if (token !== state.fullscreenTransitionToken) return;
      state.fullscreenRestoreIndex = null;
      continuousTouchZoom.suppressSync = false;
    });
  }, 140);
}

function syncFullscreenUi() {
  const nativeActive = Boolean(nativeFullscreenElement());
  if (nativeActive) {
    state.fullscreenNativeFailed = false;
    elements.readerApp.dataset.fullscreenMode = 'native';
    document.documentElement.removeAttribute('data-reader-fullscreen');
  } else if (elements.readerApp.dataset.fullscreenMode === 'native') {
    elements.readerApp.removeAttribute('data-fullscreen-mode');
  }
  const focusActive = focusFullscreenActive();
  elements.skipLink.inert = focusActive;
  const active = nativeActive || focusActive;
  const nativeAvailable = Boolean(nativeFullscreenRequest());
  const ariaLabel = nativeActive
    ? 'Exit full screen'
    : (focusActive
      ? 'Exit focus view'
      : (nativeAvailable ? 'Enter full screen' : 'Enter focus view'));
  const visibleLabel = nativeActive
    ? 'Exit full screen'
    : (focusActive ? 'Exit focus view' : (nativeAvailable ? 'Full screen' : 'Focus view'));
  elements.fullscreen.setAttribute('aria-label', ariaLabel);
  elements.fullscreen.setAttribute('aria-pressed', String(active));
  if (state.fullscreenRequestPending) elements.fullscreen.setAttribute('aria-busy', 'true');
  else elements.fullscreen.removeAttribute('aria-busy');
  elements.fullscreen.title = ariaLabel;
  const label = elements.fullscreen.querySelector('.fullscreen-label');
  if (label) label.textContent = visibleLabel;
}

function setFocusFullscreen(active, { notify = true } = {}) {
  if (active === focusFullscreenActive()) {
    syncFullscreenUi();
    refreshFullscreenLayout();
    return;
  }
  if (active) {
    elements.readerApp.dataset.fullscreenMode = 'focus';
    document.documentElement.dataset.readerFullscreen = 'focus';
  } else {
    state.fullscreenNativeFailed = !nativeFullscreenRequest({ ignoreFailure: true });
    elements.readerApp.removeAttribute('data-fullscreen-mode');
    document.documentElement.removeAttribute('data-reader-fullscreen');
  }
  syncFullscreenUi();
  refreshFullscreenLayout();
  if (!notify) return;
  if (active) {
    const exitLocation = mobileMedia.matches ? 'Exit from More.' : 'Use the toolbar to exit.';
    showFullscreenNotice(`Focus view active. Browser controls remain visible. ${exitLocation}`);
  } else {
    hideFullscreenNotice();
    announce('Focus view closed.');
  }
}

function waitForNativeFullscreen(result) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const events = ['fullscreenchange', 'webkitfullscreenchange'];
    const errorEvents = ['fullscreenerror', 'webkitfullscreenerror'];
    const cleanup = () => {
      for (const eventName of events) document.removeEventListener(eventName, handleChange);
      for (const eventName of errorEvents) document.removeEventListener(eventName, handleError);
      window.clearTimeout(timer);
    };
    const finish = (active) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(active);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleChange = () => {
      if (nativeFullscreenElement()) finish(true);
    };
    const handleError = () => finish(false);
    for (const eventName of events) document.addEventListener(eventName, handleChange);
    for (const eventName of errorEvents) document.addEventListener(eventName, handleError);
    const timer = window.setTimeout(() => finish(Boolean(nativeFullscreenElement())), 1500);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(() => {
        if (nativeFullscreenElement()) finish(true);
      }, fail);
    }
    if (nativeFullscreenElement()) finish(true);
  });
}

async function enterReaderFullscreen() {
  if (state.fullscreenRequestPending) return;
  const requestToken = ++state.fullscreenRequestToken;
  beginFullscreenLayoutTransition();
  const request = nativeFullscreenRequest();
  if (!request) {
    state.fullscreenNativeFailed = true;
    setToolsOpen(false);
    setFocusFullscreen(true);
    return;
  }

  state.fullscreenRequestPending = true;
  state.fullscreenRequestKind = 'enter';
  syncFullscreenUi();
  try {
    const result = request.call(elements.readerApp);
    setToolsOpen(false);
    const active = await waitForNativeFullscreen(result);
    if (requestToken !== state.fullscreenRequestToken) return;
    state.fullscreenRequestPending = false;
    state.fullscreenRequestKind = '';
    if (!active) {
      state.fullscreenNativeFailed = true;
      if (!focusFullscreenActive()) setFocusFullscreen(true);
      return;
    }
    syncFullscreenUi();
    refreshFullscreenLayout();
  } catch {
    if (requestToken !== state.fullscreenRequestToken) return;
    state.fullscreenRequestPending = false;
    state.fullscreenRequestKind = '';
    state.fullscreenNativeFailed = true;
    setToolsOpen(false);
    if (!focusFullscreenActive()) setFocusFullscreen(true);
  }
}

async function exitReaderFullscreen() {
  if (state.fullscreenRequestPending) return;
  const requestToken = ++state.fullscreenRequestToken;
  beginFullscreenLayoutTransition();
  if (focusFullscreenActive() && !nativeFullscreenElement()) {
    setToolsOpen(false);
    setFocusFullscreen(false);
    return;
  }
  const exit = nativeFullscreenExit();
  if (!exit) {
    setToolsOpen(false);
    announce('Use the browser controls to exit full screen.');
    refreshFullscreenLayout();
    return;
  }
  state.fullscreenRequestPending = true;
  state.fullscreenRequestKind = 'exit';
  syncFullscreenUi();
  try {
    const result = exit.call(document);
    setToolsOpen(false);
    if (result && typeof result.then === 'function') await result;
    if (requestToken !== state.fullscreenRequestToken) return;
    state.fullscreenRequestPending = false;
    state.fullscreenRequestKind = '';
    syncFullscreenUi();
    refreshFullscreenLayout();
  } catch (error) {
    if (requestToken !== state.fullscreenRequestToken) return;
    state.fullscreenRequestPending = false;
    state.fullscreenRequestKind = '';
    syncFullscreenUi();
    announce(`Full screen could not be closed: ${error.message}`);
    refreshFullscreenLayout();
  }
}

function handleNativeFullscreenChange() {
  if (state.fullscreenRestoreIndex == null) beginFullscreenLayoutTransition();
  state.fullscreenRequestPending = false;
  state.fullscreenRequestKind = '';
  syncFullscreenUi();
  refreshFullscreenLayout();
}

function handleNativeFullscreenError() {
  if (!state.fullscreenRequestPending || nativeFullscreenElement()) return;
  const requestKind = state.fullscreenRequestKind;
  state.fullscreenRequestPending = false;
  state.fullscreenRequestKind = '';
  if (requestKind !== 'enter') {
    syncFullscreenUi();
    refreshFullscreenLayout();
    announce('Full screen could not be closed.');
    return;
  }
  state.fullscreenNativeFailed = true;
  setToolsOpen(false);
  if (!focusFullscreenActive()) setFocusFullscreen(true);
}

function setToolsOpen(open, options = {}) {
  toolsMenu.setOpen(open, options);
}

function openDrawer() {
  corpusContents.showBook();
  setToolsOpen(false);
  if (state.tify && ['info', 'export'].includes(textValue(state.tify.options?.view))) {
    state.tify.setView(null);
    updateTifyViewControls();
    updateReaderSurface();
  }
  elements.drawer.inert = false;
  elements.drawer.setAttribute('aria-hidden', 'false');
  elements.drawer.dataset.open = 'true';
  elements.drawerBackdrop.hidden = false;
  elements.drawerToggle.setAttribute('aria-expanded', 'true');
  elements.drawerClose.focus();
}

function closeDrawer({ restoreFocus = true } = {}) {
  elements.drawer.removeAttribute('data-open');
  elements.drawer.setAttribute('aria-hidden', 'true');
  elements.drawer.inert = true;
  elements.drawerBackdrop.hidden = true;
  elements.drawerToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) elements.drawerToggle.focus();
}

elements.previous.addEventListener('click', () => movePage(-1));
elements.next.addEventListener('click', () => movePage(1));
elements.single.addEventListener('click', () => setMode('single'));
elements.spread.addEventListener('click', () => setMode('spread'));
elements.zoomOut.addEventListener('click', () => changeZoom(0.75));
elements.zoomIn.addEventListener('click', () => changeZoom(1.333));
elements.resetZoom.addEventListener('click', resetZoom);
function goToPageFromField() {
  const requested = textValue(elements.orderInput.value);
  const folded = requested.toLocaleLowerCase();
  const labelMatches = state.pages
    .map((page, index) => ({ index, label: sourcePageLabel(page).toLocaleLowerCase() }))
    .filter((entry) => entry.label && entry.label === folded)
    .map((entry) => entry.index);
  let targetIndex = null;
  if (labelMatches.includes(state.index)) {
    targetIndex = state.index;
  } else if (labelMatches.length) {
    targetIndex = labelMatches.reduce((nearest, index) => (
      Math.abs(index - state.index) < Math.abs(nearest - state.index) ? index : nearest
    ), labelMatches[0]);
  } else {
    const pageNumber = integerValue(requested);
    if (pageNumber != null && state.orderIndex.has(pageNumber)) {
      targetIndex = state.orderIndex.get(pageNumber);
    } else if (pageNumber != null && state.pages[pageNumber - 1]) {
      targetIndex = pageNumber - 1;
    }
  }
  if (targetIndex == null) {
    elements.orderInput.setCustomValidity('Enter a page number or label available in this volume.');
    elements.orderInput.reportValidity();
    return false;
  }
  elements.orderInput.setCustomValidity('');
  setCurrentIndex(targetIndex);
  return true;
}
elements.jumpForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!goToPageFromField()) return;
  if (mobileMedia.matches) {
    // Return to reading and dismiss the software keyboard after Go/Enter.
    elements.orderInput.blur();
    elements.stage.focus({ preventScroll: true });
  } else {
    elements.orderInput.select();
  }
});
elements.orderInput.addEventListener('input', () => elements.orderInput.setCustomValidity(''));
elements.orderInput.addEventListener('focus', () => elements.orderInput.select());
elements.orderInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  const page = state.pages[state.index];
  if (page) elements.orderInput.value = pageInputValue(page, state.index);
  elements.orderInput.setCustomValidity('');
  elements.orderInput.blur();
  elements.stage.focus({ preventScroll: true });
});
elements.contents.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page-index]');
  if (!button) return;
  setCurrentIndex(Number(button.dataset.pageIndex));
  closeDrawer({ restoreFocus: false });
  elements.stage.focus();
});
elements.thumbnailsToggle.addEventListener('click', () => {
  setThumbnailStripOpen(!state.thumbnailsOpen, { smooth: true });
  setToolsOpen(false);
});
elements.infoToggle.addEventListener('click', () => toggleTifyView('info'));
elements.exportToggle.addEventListener('click', () => toggleTifyView('export'));
elements.thumbnailScroller.addEventListener('wheel', (event) => {
  if (elements.thumbnailScroller.scrollWidth <= elements.thumbnailScroller.clientWidth) return;
  const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!rawDelta) return;
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 32
    : (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? elements.thumbnailScroller.clientWidth : 1);
  const previous = elements.thumbnailScroller.scrollLeft;
  elements.thumbnailScroller.scrollLeft += rawDelta * scale;
  if (elements.thumbnailScroller.scrollLeft !== previous) event.preventDefault();
}, { passive: false });
elements.thumbnailList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page-index]');
  if (!button) return;
  const index = Number(button.dataset.pageIndex);
  if (!Number.isInteger(index) || !state.pages[index]) return;
  setCurrentIndex(index);
});
elements.thumbnailList.addEventListener('keydown', (event) => {
  const button = event.target.closest('button[data-page-index]');
  if (!button) return;
  const index = Number(button.dataset.pageIndex);
  if (!Number.isInteger(index)) return;
  let nextIndex = null;
  if (event.key === 'ArrowLeft') nextIndex = index - 1;
  if (event.key === 'ArrowRight') nextIndex = index + 1;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = Math.max(0, state.pages.length - (state.mode === 'spread' ? 2 : 1));
  if (event.key === 'PageUp') nextIndex = index - 10;
  if (event.key === 'PageDown') nextIndex = index + 10;
  if (nextIndex == null) return;
  event.preventDefault();
  nextIndex = Math.max(0, Math.min(state.pages.length - 1, nextIndex));
  setCurrentIndex(nextIndex);
  state.thumbnailEntries[nextIndex]?.button.focus({ preventScroll: true });
  centerThumbnail(nextIndex);
});
elements.drawerToggle.addEventListener('click', () => {
  if (elements.drawer.dataset.open === 'true') closeDrawer();
  else openDrawer();
});
elements.drawerClose.addEventListener('click', () => closeDrawer());
elements.drawerBackdrop.addEventListener('click', () => closeDrawer());
elements.retry.addEventListener('click', initialize);
mobileMedia.addEventListener('change', () => {
  setToolsOpen(false);
  if (!mobileMedia.matches) cancelContinuousTouchZoom();
});

setupSharePanel({
  toggle: elements.share,
  panel: document.querySelector('#share-panel'),
  field: document.querySelector('#share-link'),
  copy: document.querySelector('#copy-view-link'),
  close: document.querySelector('#share-close'),
  status: document.querySelector('#share-status'),
  getUrl: () => window.location.href,
  clipboard: navigator.clipboard,
});

elements.fullscreen.addEventListener('click', async () => {
  if (nativeFullscreenElement() || focusFullscreenActive()) await exitReaderFullscreen();
  else await enterReaderFullscreen();
});

document.addEventListener('fullscreenchange', handleNativeFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleNativeFullscreenChange);
document.addEventListener('fullscreenerror', handleNativeFullscreenError);
document.addEventListener('webkitfullscreenerror', handleNativeFullscreenError);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelContinuousTouchZoom();
});

elements.tify.addEventListener('keydown', (event) => {
  if (event.target.closest('input, select, textarea, button, a')) return;
  if (!mobileMedia.matches && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    event.stopPropagation();
    movePage(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  const actions = {
    2: () => setThumbnailStripOpen(!state.thumbnailsOpen, { smooth: true }),
    3: () => (elements.drawer.dataset.open === 'true' ? closeDrawer() : openDrawer()),
    b: () => setMode(state.mode === 'spread' ? 'single' : 'spread'),
    f: () => elements.fullscreen.click(),
  };
  const action = actions[event.key];
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    action();
  }
}, { capture: true });

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape' && state.toolsOpen) {
    setToolsOpen(false, { restoreFocus: true });
    return;
  }
  if (event.key === 'Escape' && elements.drawer.dataset.open === 'true') {
    closeDrawer();
    return;
  }
  if (event.key === 'Escape' && focusFullscreenActive()) {
    event.preventDefault();
    void exitReaderFullscreen();
    return;
  }
  if (event.key === 'Tab' && elements.drawer.dataset.open === 'true') {
    const focusable = [...elements.drawer.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), summary')].filter((control) => control.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.defaultPrevented) return;
  const target = event.target;
  if (target.closest('input, select, textarea, a, #tify, #contents-drawer, #reader-secondary-tools, #share-panel')) return;
  if (!mobileMedia.matches && event.key === 'ArrowLeft' && (!target.closest('button') || target.closest('.reader-toolbar'))) {
    event.preventDefault();
    movePage(-1);
    return;
  }
  if (!mobileMedia.matches && event.key === 'ArrowRight' && (!target.closest('button') || target.closest('.reader-toolbar'))) {
    event.preventDefault();
    movePage(1);
    return;
  }
  if (target.closest('button')) return;
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    changeZoom(1.333);
  }
  if (event.key === '-') {
    event.preventDefault();
    changeZoom(0.75);
  }
  if (event.key === '0') {
    event.preventDefault();
    resetZoom();
  }
});

let swipeStart = null;
elements.fallbackScroll.addEventListener('pointerdown', (event) => {
  if (state.mode === 'spread' && state.zoom <= 1.01) swipeStart = { x: event.clientX, y: event.clientY };
});
elements.fallbackScroll.addEventListener('pointerup', (event) => {
  if (!swipeStart) return;
  const x = event.clientX - swipeStart.x;
  const y = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(x) > 60 && Math.abs(x) > Math.abs(y) * 1.3) movePage(x > 0 ? -1 : 1);
});
elements.fallbackScroll.addEventListener('pointercancel', () => { swipeStart = null; });
elements.continuousScroll.addEventListener('scroll', () => {
  if (!continuousTouchZoom.kind) clearContinuousDoubleTap();
  scheduleContinuousPageSync();
}, { passive: true });
elements.continuousScroll.addEventListener('wheel', cancelContinuousTarget, { passive: true });
elements.continuousReader.addEventListener('pointerdown', handleContinuousPointerDown, { passive: false });
elements.continuousReader.addEventListener('pointermove', handleContinuousPointerMove, { passive: false });
elements.continuousReader.addEventListener('pointerup', handleContinuousPointerUp);
elements.continuousReader.addEventListener('pointercancel', handleContinuousPointerCancel);
elements.continuousReader.addEventListener('lostpointercapture', handleContinuousLostPointerCapture);
elements.continuousReader.addEventListener('touchstart', preventNativeContinuousTouchGesture, { passive: false });
elements.continuousReader.addEventListener('touchmove', preventNativeContinuousTouchGesture, { passive: false });
elements.continuousScroll.addEventListener('scrollend', cancelContinuousTarget, { passive: true });

window.addEventListener('pagehide', () => {
  state.fullscreenRequestToken += 1;
  hideFullscreenNotice();
  if (state.fullscreenLayoutTimer != null) window.clearTimeout(state.fullscreenLayoutTimer);
  state.fullscreenLayoutTimer = null;
  state.fullscreenRestoreIndex = null;
  state.fullscreenRequestPending = false;
  state.fullscreenRequestKind = '';
  continuousTouchZoom.suppressSync = false;
  elements.readerApp.removeAttribute('data-fullscreen-mode');
  document.documentElement.removeAttribute('data-reader-fullscreen');
  elements.skipLink.inert = false;
});

window.addEventListener('pageshow', syncFullscreenUi);

window.addEventListener('beforeunload', () => {
  cancelContinuousTouchZoom();
  for (const index of [...state.continuousLoadedIndices]) releaseContinuousImage(index);
  state.controller?.abort();
  if (state.tifyTimer) window.clearInterval(state.tifyTimer);
  state.thumbnailObserver?.disconnect();
  state.continuousImageObserver?.disconnect();
  state.continuousResizeObserver?.disconnect();
  if (state.continuousScrollFrame != null) window.cancelAnimationFrame(state.continuousScrollFrame);
  if (state.continuousSettleTimer != null) window.clearTimeout(state.continuousSettleTimer);
  if (state.continuousResizeTimer != null) window.clearTimeout(state.continuousResizeTimer);
  if (continuousTouchZoom.hudTimer != null) window.clearTimeout(continuousTouchZoom.hudTimer);
  if (continuousTouchZoom.hydrationTimer != null) window.clearTimeout(continuousTouchZoom.hydrationTimer);
  if (state.fullscreenLayoutTimer != null) window.clearTimeout(state.fullscreenLayoutTimer);
  if (state.fullscreenNoticeTimer != null) window.clearTimeout(state.fullscreenNoticeTimer);
  state.tify?.destroy?.();
});

syncFullscreenUi();
initialize();

// Volume links keep the hierarchy open at the newly selected book.
if (new URLSearchParams(window.location.search).get('contents') === '1') openDrawer();
