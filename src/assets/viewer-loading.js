export function pageLoadOrder(index, count, radius = 1) {
  const indices = [];
  if (index < 0 || index >= count) return indices;
  indices.push(index);
  for (let distance = 1; distance <= radius; distance += 1) {
    if (index + distance < count) indices.push(index + distance);
    if (index - distance >= 0) indices.push(index - distance);
  }
  return indices;
}

// The returned cleanup also invalidates a late load event, so a preview can
// never cover a sharper image or reappear after navigation releases the page.
export function startImagePreview(frame, source, { alt, width, height, createImage = () => document.createElement('img') }) {
  const image = createImage();
  let active = true;
  image.alt = alt;
  image.decoding = 'async';
  image.fetchPriority = 'high';
  image.draggable = false;
  if (width) image.width = width;
  if (height) image.height = height;
  image.addEventListener('load', () => {
    if (!active) return;
    frame.prepend(image);
    frame.dataset.preview = 'true';
  }, { once: true });
  // A missing thumbnail must never interfere with the reading image request.
  image.addEventListener('error', () => {}, { once: true });
  image.src = source;
  return () => {
    active = false;
    image.removeAttribute('src');
    image.remove();
    frame.removeAttribute('data-preview');
  };
}
