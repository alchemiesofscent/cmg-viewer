import { integerValue } from './viewer-values.js';
import { startImagePreview } from './viewer-loading.js';

// Owns request priority, decode, preview replacement and bounded image retention.
// Navigation remains authoritative in the shared reader position state.
export function createContinuousImages({ state, elements, loadingMetrics, sourcePageLabel, pageDisplay,
  createImage = () => document.createElement('img'),
  devicePixelRatio = () => window.devicePixelRatio || 1, now = () => Date.now(),
}) {
const CONTINUOUS_IMAGE_RETRY_DELAY = 10000;
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
  const requestedWidth = Math.ceil(renderedWidth * Math.min(devicePixelRatio() || 1, 2));
  const pixelWidth = continuousImagePixelWidth(page, requestedWidth);
  if (entry.image && entry.pixelWidth >= pixelWidth) return;
  if (
    entry.image
    && entry.failedPixelWidth === pixelWidth
    && now() - entry.failedAt < CONTINUOUS_IMAGE_RETRY_DELAY
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

  const image = createImage();
  const finishImageTiming = loadingMetrics.start('reading-image', { scan: index + 1, primary, requestedWidth: pixelWidth });
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
    finishImageTiming(usingThumbnailFallback ? 'thumbnail-fallback' : 'ok');
    const previousImage = entry.image;
    entry.pendingImage = null;
    entry.pendingPixelWidth = 0;
    entry.image = image;
    entry.pixelWidth = usingThumbnailFallback ? Math.min(pixelWidth, 400) : pixelWidth;
    entry.failedPixelWidth = usingThumbnailFallback ? pixelWidth : 0;
    entry.failedAt = usingThumbnailFallback ? now() : 0;
    entry.failed = false;
    entry.frame.prepend(image);
    if (index === state.index) {
      loadingMetrics.mark('first-visible-page', { scan: index + 1 });
      if (!usingThumbnailFallback) loadingMetrics.mark('first-sharp-page', { scan: index + 1, requestedWidth: pixelWidth });
    }
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
    finishImageTiming('error');
    entry.failedPixelWidth = pixelWidth;
    entry.failedAt = now();
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
  const finishPreview = loadingMetrics.start('preview', { scan: index + 1 });
  entry.cancelPreview = startImagePreview(entry.frame, page.thumbnail, {
    onReady: () => { finishPreview(); if (index === state.index) loadingMetrics.mark('first-visible-page', { scan: index + 1 }); },
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

return { hydrateContinuousImage, releaseContinuousImage, releaseDistantContinuousImages };
}
