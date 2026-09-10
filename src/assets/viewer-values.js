// Shared value readers for the volume model and reader controls.
export function textValue(value) {
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

export function listValue(...candidates) {
  const value = candidates.find((candidate) => candidate != null && textValue(candidate));
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => {
    if (typeof entry === 'string' && /\s*[;|]\s*/.test(entry)) return entry.split(/\s*[;|]\s*/);
    return [textValue(entry)];
  }).map((entry) => entry.trim()).filter(Boolean))];
}

export function integerValue(...values) {
  for (const value of values) {
    const number = Number.parseInt(value, 10);
    if (Number.isInteger(number)) return number;
  }
  return null;
}

export function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

