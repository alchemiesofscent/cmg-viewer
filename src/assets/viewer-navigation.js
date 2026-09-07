// TIFY reloads image metadata whenever setPage receives a new array, even if
// its values are unchanged. Overlapping identical requests can duplicate its
// tile-source cache and render each page twice.
export function syncTifyPageSelection(viewer, pages) {
  if (!viewer) return false;
  const current = viewer.options?.pages || [];
  if (current.length === pages.length && current.every((page, index) => Number(page) === pages[index])) {
    return false;
  }
  // TIFY's setPage([n]) otherwise keeps a previously selected facing-page mode.
  if (pages.length === 1 && current.length > 1) viewer.toggleDoublePage?.(false);
  viewer.setPage([...pages]);
  return true;
}
