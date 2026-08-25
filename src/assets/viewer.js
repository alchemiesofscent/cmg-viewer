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
const VOLUME_URL = new URL(`data/volumes/${encodeURIComponent(volumeId)}.json`, BASE_URL);
const MANIFEST_URL = new URL(`iiif/${encodeURIComponent(volumeId)}/manifest.json`, BASE_URL);

const elements = {
  catalogueLink: document.querySelector('#catalogue-link'),
  title: document.querySelector('#volume-title'),
  meta: document.querySelector('#volume-meta'),
  cmgSource: document.querySelector('#cmg-source'),
  share: document.querySelector('#share-view'),
  stage: document.querySelector('#reader-stage'),
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
  thumbnailCount: document.querySelector('#thumbnail-count'),
  live: document.querySelector('#reader-live'),
};

const state = {
  volume: {},
  manifest: null,
  pages: [],
  orderIndex: new Map(),
  index: 0,
  mode: new URLSearchParams(window.location.search).get('view') === 'single'
    ? 'single'
    : (new URLSearchParams(window.location.search).get('view') === 'spread' || window.matchMedia('(min-width: 48rem)').matches ? 'spread' : 'single'),
  zoom: 1,
  tify: null,
  tifyTimer: null,
  tifyPageSignature: '',
  tifyView: '',
  toc: [],
  tocEntries: [],
  thumbnailsOpen: true,
  thumbnailEntries: [],
  thumbnailObserver: null,
  thumbnailPrimaryIndex: null,
  thumbnailVisibleIndices: new Set(),
  sourceUrl: '',
  controller: null,
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
  if (!label) return `Image ${index + 1}`;
  return /^(?:Abb\.|Tafel)\s/i.test(label) ? label : `Page ${label}`;
}

function pageStatusText(indices) {
  if (!indices.length) return '—';
  const first = indices[0] + 1;
  const last = indices.at(-1) + 1;
  const total = state.pages.length;
  if (indices.length === 1) {
    const label = sourcePageLabel(state.pages[indices[0]]);
    return label ? `${pageDisplay(state.pages[indices[0]], indices[0])} · image ${first} of ${total}` : `Image ${first} of ${total}`;
  }
  const labels = indices.map((index) => sourcePageLabel(state.pages[index]));
  if (!labels.some(Boolean)) return `Images ${first}–${last} of ${total}`;
  const pages = indices.map((index, offset) => labels[offset] ? pageDisplay(state.pages[index], index) : `image ${index + 1}`);
  return `${pages.join(' + ')} · images ${first}–${last} of ${total}`;
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

function imageUrl(record, canvas) {
  const direct = textValue(record?.imageUrl || record?.image_url || record?.image || record?.resourceUrl || record?.resource_url);
  if (direct) return direct;
  const body = annotationBody(canvas);
  const bodyId = textValue(body.id || body['@id']);
  if (bodyId) return bodyId;
  const service = serviceId(body) || textValue(
    record?.imageServiceId || record?.image_service_id || record?.imageService || record?.image_service || record?.serviceId || record?.service_id,
  );
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
  const body = annotationBody(canvas);
  const service = textValue(
    record?.imageServiceId || record?.image_service_id || record?.imageService ||
    record?.image_service || record?.serviceId || record?.service_id,
  ) || serviceId(body);
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
    message.textContent = 'No logical contents are available for this volume yet. Use the page-image field or arrow buttons to move through the volume.';
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

function currentSpreadIndices() {
  if (!state.pages.length) return [];
  if (state.mode === 'single' || state.index >= state.pages.length - 1) return [state.index];
  return [state.index, state.index + 1];
}

function displayedPageIndices() {
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
      ? `Open ${pageDisplay(page, index)}; image ${index + 1} of ${state.pages.length}`
      : `Open image ${index + 1} of ${state.pages.length}`;
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
  elements.thumbnailCount.textContent = `${state.pages.length.toLocaleString()} total`;
  observeThumbnailImages();
  updateThumbnailRail({ center: false });
}

function setThumbnailStripOpen(open, { smooth = false } = {}) {
  state.thumbnailsOpen = Boolean(open);
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
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
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

function renderFallback() {
  const indices = currentSpreadIndices();
  const fragment = document.createDocumentFragment();

  for (const index of indices) {
    const page = state.pages[index];
    const printedLabel = sourcePageLabel(page);
    const frame = document.createElement('figure');
    frame.className = 'scan-frame';
    const image = document.createElement('img');
    image.src = page.image;
    image.alt = printedLabel
      ? `${pageDisplay(page, index)}, image ${index + 1} of ${state.pages.length}`
      : `Page image ${index + 1} of ${state.pages.length}`;
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
  applyFallbackZoom();
}

function applyFallbackZoom() {
  elements.fallbackPages.style.width = `${Math.round(state.zoom * 100)}%`;
  elements.fallbackPages.dataset.zoomed = state.zoom > 1.01 ? 'true' : 'false';
  elements.resetZoom.textContent = state.zoom === 1 ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
}

function updateTifyViewControls() {
  const enabled = Boolean(state.tify);
  const view = enabled ? textValue(state.tify.options?.view) : '';
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

function toggleTifyView(name) {
  if (!state.tify || !['info', 'export'].includes(name)) return;
  if (elements.drawer.dataset.open === 'true') closeDrawer({ restoreFocus: false });
  const nextView = textValue(state.tify.options?.view) === name ? null : name;
  state.tify.setView(nextView);
  updateTifyViewControls();
}

function updatePageUi() {
  const page = state.pages[state.index];
  if (!page) return;
  const visibleIndices = currentSpreadIndices();
  elements.orderInput.value = String(state.index + 1);
  elements.orderInput.min = '1';
  elements.orderInput.max = String(state.pages.length);
  elements.orderInput.setCustomValidity('');
  elements.previous.disabled = state.index <= 0;
  elements.next.disabled = state.index >= state.pages.length - 1;
  elements.single.setAttribute('aria-pressed', String(state.mode === 'single'));
  elements.spread.setAttribute('aria-pressed', String(state.mode === 'spread'));
  elements.pageStatus.textContent = pageStatusText(visibleIndices);
  updateTifyViewControls();
  updateAddress();
  updateSourceHref();
  updateActiveToc();
  updateThumbnailRail();
}

function syncTifyPages() {
  if (!state.tify) return;
  const pages = currentSpreadIndices().map((pageIndex) => pageIndex + 1);
  state.tify.toggleDoublePage?.(state.mode === 'spread');
  state.tify.setPage(pages);
}

function setCurrentIndex(index, { updateViewer = true, speak = true } = {}) {
  const nextIndex = Math.max(0, Math.min(state.pages.length - 1, index));
  state.index = nextIndex;
  if (state.tify && updateViewer) {
    syncTifyPages();
  } else if (!state.tify) {
    renderFallback();
  }
  updatePageUi();
  if (speak) announce(elements.pageStatus.textContent);
}

function setMode(mode) {
  if (!['single', 'spread'].includes(mode) || state.mode === mode) return;
  state.mode = mode;
  setCurrentIndex(state.index);
}

function firstIndexFromQuery() {
  const requested = integerValue(new URLSearchParams(window.location.search).get('pn'));
  if (requested == null) {
    const defaultOrder = integerValue(state.volume.defaultPn, state.volume.default_pn, state.volume.startPn, state.volume.start_pn);
    return defaultOrder != null && state.orderIndex.has(defaultOrder) ? state.orderIndex.get(defaultOrder) : 0;
  }
  if (state.orderIndex.has(requested)) return state.orderIndex.get(requested);
  window.setTimeout(() => announce(`The linked page is not present in this volume. Opened image 1 instead.`), 100);
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

async function startTify() {
  if (!state.manifest || new URLSearchParams(window.location.search).get('fallback') === '1') throw new Error('Basic reader requested.');
  const Tify = await Promise.race([loadTifyAssets(), timeout(8000, 'TIFY assets timed out.')]);
  const pages = currentSpreadIndices().map((index) => index + 1);
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
  await Promise.race([viewer.ready, timeout(12000, 'TIFY did not become ready.')]);
  state.tify = viewer;
  state.tifyPageSignature = arrayValue(state.tify.options?.pages).map(Number).join(',');
  state.tifyView = textValue(state.tify.options?.view);
  elements.tify.hidden = false;
  elements.fallback.hidden = true;
  window.__cmgTify = viewer;
  updatePageUi();

  state.tifyTimer = window.setInterval(() => {
    const rawPages = arrayValue(state.tify?.options?.pages).map(Number);
    const displayed = rawPages.filter((page) => page > 0);
    if (!displayed.length) return;
    const signature = rawPages.join(',');
    const observedIndex = displayed[0] - 1;
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
    if (state.pages[observedIndex] && observedIndex !== state.index) {
      state.index = observedIndex;
      changed = true;
    }
    if (observedMode !== state.mode && !(state.mode === 'spread' && state.index === state.pages.length - 1)) {
      state.mode = observedMode;
      changed = true;
    }
    if (changed) updatePageUi();
  }, 350);
}

function showError(error) {
  console.error(error);
  elements.loading.hidden = true;
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

  state.controller?.abort();
  state.controller = new AbortController();
  if (state.tifyTimer) window.clearInterval(state.tifyTimer);
  state.tifyTimer = null;
  state.tify?.destroy?.();
  state.tify = null;
  state.tifyPageSignature = '';
  state.tifyView = '';
  state.thumbnailObserver?.disconnect();
  state.thumbnailObserver = null;
  state.thumbnailEntries = [];
  state.thumbnailPrimaryIndex = null;
  state.thumbnailVisibleIndices = new Set();
  elements.thumbnailList.replaceChildren();
  elements.thumbnailStrip.hidden = true;
  elements.thumbnailsToggle.disabled = true;
  elements.thumbnailsToggle.setAttribute('aria-expanded', 'false');
  elements.thumbnailsToggle.setAttribute('aria-label', 'Show page thumbnails');
  updateTifyViewControls();
  elements.error.hidden = true;
  elements.fallback.hidden = true;
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
  applyVolumeIdentity(state.volume, state.manifest);
  state.toc = buildToc(state.volume, state.manifest);
  renderToc();
  renderFallback();
  renderThumbnailRail();
  elements.thumbnailsToggle.disabled = false;
  setThumbnailStripOpen(state.thumbnailsOpen);
  updatePageUi();
  elements.fallback.hidden = false;
  elements.loadingTitle.textContent = 'Opening the image reader';
  elements.loadingDetail.textContent = 'Starting the self-hosted IIIF interface…';

  try {
    await startTify();
    elements.loading.hidden = true;
    announce(`Opened ${elements.title.textContent}, ${elements.pageStatus.textContent}`);
  } catch (error) {
    console.info('TIFY unavailable; continuing with the built-in reader.', error);
    elements.loading.hidden = true;
    elements.fallback.hidden = false;
    elements.fallbackNote.textContent = state.manifest
      ? 'Basic reader active. Full-resolution images are loaded directly from BBAW.'
      : 'Fallback record active. This volume does not currently have a complete METS-derived manifest.';
    announce(`Opened the basic reader. ${elements.pageStatus.textContent}`);
  }
}

function movePage(direction) {
  const step = state.mode === 'spread' ? 2 : 1;
  setCurrentIndex(state.index + direction * step);
}

function changeZoom(factor) {
  if (state.tify?.viewer?.viewport) {
    state.tify.viewer.viewport.zoomBy(factor);
    state.tify.viewer.viewport.applyConstraints();
    return;
  }
  state.zoom = Math.max(0.75, Math.min(4, Math.round(state.zoom * factor * 100) / 100));
  applyFallbackZoom();
}

function resetZoom() {
  if (state.tify) {
    state.tify.resetScan(true);
    return;
  }
  state.zoom = 1;
  elements.fallbackScroll.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  applyFallbackZoom();
}

function openDrawer() {
  if (state.tify && ['info', 'export'].includes(textValue(state.tify.options?.view))) {
    state.tify.setView(null);
    updateTifyViewControls();
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
function goToImageFromField() {
  const imageNumber = integerValue(elements.orderInput.value);
  if (imageNumber == null || !state.pages[imageNumber - 1]) {
    elements.orderInput.setCustomValidity(`Enter an image number from 1 to ${state.pages.length}.`);
    elements.orderInput.reportValidity();
    return false;
  }
  elements.orderInput.setCustomValidity('');
  setCurrentIndex(imageNumber - 1);
  return true;
}
elements.jumpForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!goToImageFromField()) return;
  elements.orderInput.select();
});
elements.orderInput.addEventListener('input', () => elements.orderInput.setCustomValidity(''));
elements.orderInput.addEventListener('change', goToImageFromField);
elements.contents.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page-index]');
  if (!button) return;
  setCurrentIndex(Number(button.dataset.pageIndex));
  closeDrawer({ restoreFocus: false });
  elements.stage.focus();
});
elements.thumbnailsToggle.addEventListener('click', () => {
  setThumbnailStripOpen(!state.thumbnailsOpen, { smooth: true });
});
elements.infoToggle.addEventListener('click', () => toggleTifyView('info'));
elements.exportToggle.addEventListener('click', () => toggleTifyView('export'));
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

elements.share.addEventListener('click', async () => {
  const title = elements.title.textContent;
  try {
    await navigator.clipboard.writeText(window.location.href);
    announce('Link copied to the clipboard.');
    const label = elements.share.querySelector('.wide-label');
    const previous = label.textContent;
    label.textContent = 'Copied';
    window.setTimeout(() => { label.textContent = previous; }, 1500);
  } catch {
    window.prompt(`Copy a link to ${title}`, window.location.href);
  }
});

elements.fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    announce(`Full screen could not be opened: ${error.message}`);
  }
});

document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  elements.fullscreen.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
});

elements.tify.addEventListener('keydown', (event) => {
  if (event.target.closest('input, select, textarea, button, a')) return;
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
  if (event.key === 'Escape' && elements.drawer.dataset.open === 'true') {
    closeDrawer();
    return;
  }
  if (event.key === 'Tab' && elements.drawer.dataset.open === 'true') {
    const focusable = [...elements.drawer.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled)')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  const target = event.target;
  if (target.closest('input, select, textarea, button, a, #tify')) return;
  if (event.key === 'ArrowLeft') movePage(-1);
  if (event.key === 'ArrowRight') movePage(1);
  if (event.key === '+' || event.key === '=') changeZoom(1.333);
  if (event.key === '-') changeZoom(0.75);
  if (event.key === '0') resetZoom();
});

let swipeStart = null;
elements.fallbackScroll.addEventListener('pointerdown', (event) => {
  if (state.zoom <= 1.01) swipeStart = { x: event.clientX, y: event.clientY };
});
elements.fallbackScroll.addEventListener('pointerup', (event) => {
  if (!swipeStart) return;
  const x = event.clientX - swipeStart.x;
  const y = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(x) > 60 && Math.abs(x) > Math.abs(y) * 1.3) movePage(x > 0 ? -1 : 1);
});
elements.fallbackScroll.addEventListener('pointercancel', () => { swipeStart = null; });

window.addEventListener('beforeunload', () => {
  state.controller?.abort();
  if (state.tifyTimer) window.clearInterval(state.tifyTimer);
  state.thumbnailObserver?.disconnect();
  state.tify?.destroy?.();
});

initialize();
