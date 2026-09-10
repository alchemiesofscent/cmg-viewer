// Page labels, source orders and scan positions are distinct coordinates.
export function resolvePageEntry(value, pages, currentIndex, labelOf) {
  const requested = String(value).trim();
  const scan = requested.match(/^scan\s+(\d+)$/i);
  if (scan) {
    const index = Number(scan[1]) - 1;
    return index >= 0 && index < pages.length ? index : null;
  }
  const matches = pages.map((page, index) => ({ index, label: labelOf(page).toLocaleLowerCase() }))
    .filter(entry => entry.label && entry.label === requested.toLocaleLowerCase()).map(entry => entry.index);
  if (matches.includes(currentIndex)) return currentIndex;
  if (matches.length) return matches.reduce((nearest, index) =>
    Math.abs(index - currentIndex) < Math.abs(nearest - currentIndex) ? index : nearest, matches[0]);
  if (!/^\d+$/.test(requested)) return null;
  const number = Number(requested);
  const source = pages.findIndex(page => page.order === number);
  return source >= 0 ? source : (pages[number - 1] ? number - 1 : null);
}

export function pageReference({ label, order, index, count }) {
  const location = `Scan ${index + 1} of ${count}`;
  return label ? `Page label ${label} · ${location}` : `${location} · Source page ${order}`;
}

export function pageCitation({ title, label, order, index, url }) {
  const location = label ? `p. ${label}` : `scan ${index + 1} (source page ${order})`;
  return `${title}. ${location}. ${url}`;
}
