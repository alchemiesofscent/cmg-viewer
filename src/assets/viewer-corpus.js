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
  const toggle = document.querySelector('#contents-scope');
  const book = document.querySelector('#book-contents');
  const corpus = document.querySelector('#corpus-contents');
  const heading = document.querySelector('#contents-heading');
  const eyebrow = document.querySelector('#contents-eyebrow');
  let showingCorpus = false;
  let loaded = false;
  let pending = false;

  async function load() {
    if (loaded || pending) return;
    pending = true;
    corpus.setAttribute('aria-busy', 'true');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Loading volumes…';
    corpus.replaceChildren(status);
    try {
      const response = await fetch(new URL('data/catalogue.json', baseUrl));
      if (!response.ok) throw new Error(`Catalogue request returned ${response.status}`);
      const groups = corpusGroups(await response.json());
      if (!groups.length) throw new Error('No volumes found');
      const fragment = document.createDocumentFragment();
      for (const group of groups) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const isCurrent = group.volumes.some((volume) => volume.id === volumeId);
        summary.textContent = `${group.label}${isCurrent ? ' · Current volume' : ''}`;
        details.append(summary);
        const list = document.createElement('ul');
        for (const volume of group.volumes) {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = new URL(`viewer/${encodeURIComponent(volume.id)}/`, baseUrl).href;
          const label = document.createElement('strong');
          label.textContent = volume.shelfmark;
          const title = document.createElement('span');
          title.textContent = volume.titles.join(' / ');
          link.append(label, title);
          if (volume.id === volumeId) {
            link.setAttribute('aria-current', 'page');
            label.append(' · Current volume');
            link.addEventListener('click', (event) => {
              event.preventDefault();
              showBook();
              toggle.focus();
            });
          }
          item.append(link);
          list.append(item);
        }
        details.append(list);
        fragment.append(details);
      }
      corpus.replaceChildren(fragment);
      loaded = true;
    } catch {
      status.textContent = 'The volume list could not be loaded. You can retry or open the catalogue.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => { toggle.focus(); void load(); });
      const catalogue = document.createElement('a');
      catalogue.href = baseUrl.href;
      catalogue.textContent = 'Open catalogue';
      corpus.append(retry, catalogue);
    } finally {
      pending = false;
      corpus.removeAttribute('aria-busy');
    }
  }

  function setScope(value) {
    showingCorpus = value;
    book.hidden = value;
    corpus.hidden = !value;
    toggle.textContent = value ? '← Current book’s contents' : 'All CMG volumes →';
    heading.textContent = value ? 'All volumes' : 'Contents';
    eyebrow.textContent = value ? 'Entire corpus' : 'This volume';
    if (value) void load();
  }
  function showBook() { setScope(false); }
  toggle.addEventListener('click', () => setScope(!showingCorpus));
  return { showBook };
}
