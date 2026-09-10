// Store only the last source-page order per volume, on this browser.
export const PROGRESS_KEY = 'cmg-reader-progress-v1';
export function createProgressStore(getStorage = () => window.localStorage) {
  function read() {
    try {
      const value = JSON.parse(getStorage().getItem(PROGRESS_KEY) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([id, item]) =>
        /^[a-zA-Z0-9_-]+$/.test(id) && Number.isSafeInteger(item?.order)
        && item.order >= 0 && Number.isFinite(item?.updatedAt)));
    } catch { return {}; }
  }
  return {
    get(id) { return read()[id]?.order ?? null; },
    save(id, order) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isSafeInteger(order) || order < 0) return;
      try {
        const entries = read();
        if (entries[id]?.order === order) return;
        const recent = [[id, { order, updatedAt: Date.now() }], ...Object.entries(entries).filter(([key]) => key !== id)]
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 50);
        getStorage().setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(recent)));
      } catch { /* Blocked or full storage must never prevent reading. */ }
    },
  };
}

export function initialPageIndex({ query, savedOrder, defaultOrder, orderIndex }) {
  // Even an invalid explicit link takes precedence over personal history.
  if (query.has('pn')) {
    const raw = query.get('pn');
    const order = /^\d+$/.test(raw) ? Number(raw) : null;
    return { index: orderIndex.get(order) ?? 0, invalidLink: !orderIndex.has(order), resumed: false };
  }
  if (savedOrder != null && orderIndex.has(savedOrder)) {
    return { index: orderIndex.get(savedOrder), invalidLink: false, resumed: true };
  }
  return { index: orderIndex.get(defaultOrder) ?? 0, invalidLink: false, resumed: false };
}
