const COLLECTIONS = ['CMG', 'CMG Supplementum', 'CMG Supplementum Orientale', 'CML', 'Weitere Ausgaben', 'Übersetzungen', 'Diels'];
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function romanValue(roman) {
  const digits = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  return [...roman].reduce((sum, char, i) => sum + (digits[char] < (digits[roman[i + 1]] || 0) ? -digits[char] : digits[char]), 0);
}

export function corpusGroups(catalogue) {
  if (!Array.isArray(catalogue?.items)) throw new Error('Missing catalogue items');
  const volumes = new Map();
  for (const item of catalogue.items) {
    const id = String(item.volumeId || '').trim();
    if (!id) continue;
    const collection = String(item.collection || 'Other');
    const number = String(item.seriesNumber || '');
    const roman = number.match(/(?:^|\s)([IVXLCDM]+)(?=\s*(?:\d|$))/i)?.[1]?.toUpperCase() || '';
    if (!volumes.has(id)) volumes.set(id, {
      id, collection, number,
      ordinal: roman ? romanValue(roman) : Number.MAX_SAFE_INTEGER,
      group: collection === 'CMG' && roman ? `CMG ${roman}` : collection,
      shelfmark: number.toLowerCase().startsWith(collection.toLowerCase()) ? number : `${collection} ${number}`.trim(),
      titles: [],
    });
    const title = String(item.label || '').trim();
    const volume = volumes.get(id);
    if (title && !volume.titles.includes(title)) volume.titles.push(title);
  }
  const rank = (collection) => COLLECTIONS.includes(collection) ? COLLECTIONS.indexOf(collection) : COLLECTIONS.length;
  const ordered = [...volumes.values()].sort((a, b) => rank(a.collection) - rank(b.collection)
    || collator.compare(a.collection, b.collection) || a.ordinal - b.ordinal
    || collator.compare(a.shelfmark, b.shelfmark) || collator.compare(a.id, b.id));
  const groups = new Map();
  for (const volume of ordered) {
    if (!groups.has(volume.group)) groups.set(volume.group, { label: volume.group, volumes: [] });
    groups.get(volume.group).volumes.push(volume);
  }
  return [...groups.values()];
}

export function setupCorpusContents({ baseUrl, volumeId }) {
  const up = document.querySelector('#contents-up');
  const book = document.querySelector('#book-contents');
  const corpus = document.querySelector('#corpus-contents');
  const heading = document.querySelector('#contents-heading');
  const eyebrow = document.querySelector('#contents-eyebrow');
  let level = 'book';
  let selectedGroup = null;
  let groups = null;
  let pending = null;
  let failed = false;
  let bookLabel = 'Contents';
  const currentGroup = () => groups?.find(group => group.volumes.some(volume => volume.id === volumeId));

  function row(label, detail, { href, action, current = false, marker = '›' } = {}) {
    const item = document.createElement('li');
    item.className = 'contents-entry';
    const control = document.createElement(href ? 'a' : 'button');
    if (href) control.href = href;
    else control.type = 'button';
    const text = document.createElement('span');
    text.textContent = label;
    if (detail) {
      const subtitle = document.createElement('span');
      subtitle.className = 'contents-subtitle';
      subtitle.textContent = detail;
      text.append(subtitle);
    }
    const arrow = document.createElement('span');
    arrow.className = 'contents-order';
    arrow.textContent = marker;
    arrow.setAttribute('aria-hidden', 'true');
    control.append(text, arrow);
    if (current) control.setAttribute('aria-current', 'location');
    if (action) control.addEventListener('click', action);
    item.append(control);
    return item;
  }

  function render({ focus = false } = {}) {
    book.hidden = level !== 'book';
    corpus.hidden = level === 'book';
    up.hidden = level === 'root';
    up.setAttribute('aria-label', level === 'book' ? 'Up to volumes in this series' : 'Up to all series');
    up.title = up.getAttribute('aria-label');
    const group = selectedGroup || currentGroup();
    heading.textContent = level === 'book' ? bookLabel : level === 'root' ? 'All CMG volumes' : (group?.label || 'Volumes');
    eyebrow.textContent = level === 'book' ? 'Contents' : level === 'root' ? 'Corpus' : 'Series';
    if (level !== 'book') {
      const list = document.createElement('ol');
      if (!groups) {
        const status = document.createElement('li');
        status.className = 'contents-loading';
        status.setAttribute('role', 'status');
        status.textContent = failed ? 'Could not load the volumes.' : 'Loading volumes…';
        list.append(status);
        if (failed) {
          list.append(row('Retry', '', { action: () => { void load(); heading.focus(); }, marker: '↻' }));
          list.append(row('Open catalogue', '', { href: baseUrl.href }));
        }
      } else if (level === 'root' || !group) {
        // A missing catalogue entry must still let the reader reach the corpus.
        level = 'root';
        up.hidden = true;
        heading.textContent = 'All CMG volumes';
        eyebrow.textContent = 'Corpus';
        for (const entry of groups) {
          list.append(row(entry.label, '', {
            current: entry === currentGroup(),
            action: () => { selectedGroup = entry; level = 'group'; render({ focus: true }); },
          }));
        }
      } else {
        for (const volume of group.volumes) {
          const current = volume.id === volumeId;
          const href = new URL(`viewer/${encodeURIComponent(volume.id)}/?contents=1`, baseUrl).href;
          list.append(row(volume.shelfmark, volume.titles.join(' / '), current ? {
            current: true, action: () => showBook({ focus: true }),
          } : { href }));
        }
      }
      corpus.replaceChildren(list);
      corpus.scrollTop = 0;
    }
    if (focus) heading.focus({ preventScroll: true });
  }

  async function load() {
    if (groups || pending) return pending;
    failed = false;
    render();
    pending = (async () => {
      try {
        const response = await fetch(new URL('data/catalogue.json', baseUrl));
        if (!response.ok) throw new Error(`Catalogue request returned ${response.status}`);
        const result = corpusGroups(await response.json());
        if (!result.length) throw new Error('No volumes found');
        groups = result;
      } catch {
        failed = true;
      } finally {
        pending = null;
        render();
      }
    })();
    return pending;
  }

  function showBook(options = {}) { level = 'book'; selectedGroup = null; render(options); }
  up.addEventListener('click', () => {
    level = level === 'book' ? 'group' : 'root';
    selectedGroup = null;
    render({ focus: true });
    void load();
  });
  return {
    showBook,
    setVolumeLabel(label) { bookLabel = label || 'Contents'; render(); },
  };
}
