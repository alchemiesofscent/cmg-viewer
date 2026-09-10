// Convert source volume records and IIIF metadata without DOM or global reader state.
import { textValue, listValue, integerValue, arrayValue } from './viewer-values.js';

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

export function normalizePages(volume, manifest) {
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
    const record = recordByIndex.get(index) || {};
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
      derivative: textValue(record.maxDerivativeUrl),
      service: imageServiceUrl(record, canvas),
      image: imageUrl(record, canvas),
      thumbnail: thumbnailUrl(record, canvas),
      width: integerValue(record.width, annotationBody(canvas).width, canvas.width),
      height: integerValue(record.height, annotationBody(canvas).height, canvas.height),
    };
  });
}

export function sourceLink(volume) {
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

export function manifestLabel(manifest) {
  return textValue(manifest?.label) || 'Untitled volume';
}


export function buildToc(volume, manifest, pages) {
  const state = { pages, orderIndex: new Map() };
  pages.forEach((page, index) => { if (!state.orderIndex.has(page.order)) state.orderIndex.set(page.order, index); });
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
      const nested = rangeMap.get(reference) || (typeof item === 'object' && item);
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
      if (id && (!rangeMap.has(id) || range.items || range.ranges || range.canvases)) rangeMap.set(id, range);
      arrayValue(range?.items || range?.ranges).forEach((item) => {
        const type = textValue(item?.type || item?.['@type']);
        if (typeof item === 'object' && /range/i.test(type)) collect(item);
      });
    };
    structures.forEach(collect);
  
    const normalize = (range, depth = 0, ancestors = new Set()) => {
      const id = textValue(range?.id || range?.['@id']);
      if (id && ancestors.has(id)) return null;
      const seen = new Set(ancestors);
      if (id) seen.add(id);
      const children = arrayValue(range?.items || range?.ranges).map((item) => {
        const reference = typeof item === 'string' ? item : textValue(item?.id || item?.['@id']);
        const type = textValue(item?.type || item?.['@type']);
        const nested = rangeMap.get(reference) || (/range/i.test(type) && item);
        return nested ? normalize(nested, depth + 1, seen) : null;
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
    return structures.map((range) => normalize(range)).filter((range) => range && (range.label || range.children.length));
  }
  
  function build(volume, manifest) {
    const direct = volume.toc || volume.contents || volume.logicalContents || volume.logical_contents || volume.structures;
    const nodes = arrayValue(direct).map((node) => normalizeTocNode(node)).filter(Boolean);
    return nodes.length ? nodes : normalizeManifestRanges(manifest);
  }
  
  return build(volume, manifest);
}
