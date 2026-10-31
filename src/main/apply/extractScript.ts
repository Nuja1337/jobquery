// Runs inside the application page (any frame) and lists its form fields.
// Kept as a plain JavaScript string so the bundler can't add helpers that don't exist in the page.
//
// Each field element gets a data-jp-id attribute so the filler can find it again in the same
// page session. Radio and checkbox groups also return one id per option.

export interface ExtractedField {
  key: string
  jpId: string
  label: string
  type: string
  required: boolean
  options: string[]
  optionIds: string[]
  placeholder: string | null
  maxLength: number | null
  fileHint: 'resume' | 'cover_letter' | 'other' | null
}

export const EXTRACT_FIELDS_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();
  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  let counter = Number(document.documentElement.dataset.jpCounter || '0');
  const idFor = (el) => {
    if (!el.dataset.jpId) { el.dataset.jpId = 'jp' + (counter++); }
    return el.dataset.jpId;
  };
  const textOfIds = (ids) => ids.split(/\s+/).map((id) => {
    const n = document.getElementById(id);
    return n ? n.textContent : '';
  }).join(' ');

  const labelFor = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) { const t = clean(textOfIds(labelledBy)); if (t) return t; }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) { const t = clean(lab.textContent); if (t) return t; }
    }
    const wrap = el.closest('label');
    if (wrap) {
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll('input, select, textarea, option').forEach((n) => n.remove());
      const t = clean(copy.textContent);
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    // Walk up a few levels looking for a label-like element in the same field container.
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const cand = node.querySelector('label, legend, [class*="label" i], [class*="question" i], h3, h4');
      if (cand && !cand.contains(el)) { const t = clean(cand.textContent); if (t && t.length < 400) return t; }
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '');
  };

  const groupLabel = (el) => {
    const fs = el.closest('fieldset');
    if (fs) { const lg = fs.querySelector('legend'); if (lg) { const t = clean(lg.textContent); if (t) return t; } }
    const group = el.closest('[role="radiogroup"], [role="group"]');
    if (group) {
      const lb = group.getAttribute('aria-labelledby');
      if (lb) { const t = clean(textOfIds(lb)); if (t) return t; }
      const al = group.getAttribute('aria-label');
      if (al) return clean(al);
    }
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const cand = node.querySelector('legend, [class*="label" i], [class*="question" i], h3, h4, p');
      if (cand && !cand.contains(el) && !cand.querySelector('input')) { const t = clean(cand.textContent); if (t && t.length < 400) return t; }
    }
    return clean(el.name || '');
  };

  const isRequired = (el, label) =>
    el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label || '') || /\(required\)/i.test(label || '');

  const fileHint = (text) => {
    const t = (text || '').toLowerCase();
    if (/cover/.test(t)) return 'cover_letter';
    if (/resume|résumé|\bcv\b/.test(t)) return 'resume';
    return 'other';
  };

  const fields = [];
  const usedKeys = new Set();
  const uniqueKey = (base) => {
    let key = (base || 'field').toString().slice(0, 120);
    let n = 2;
    while (usedKeys.has(key)) key = base + '_' + (n++);
    usedKeys.add(key);
    return key;
  };
  const doneGroups = new Set();

  const all = Array.from(document.querySelectorAll('input, textarea, select'));
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search', 'password'].includes(type)) continue;
    if (el.disabled) continue;
    if (type !== 'file' && !isVisible(el) && !(type === 'radio' || type === 'checkbox')) continue;

    if (type === 'radio' || type === 'checkbox') {
      const name = el.name || '';
      const peers = name ? all.filter((x) => x.name === name && (x.getAttribute('type') || '').toLowerCase() === type) : [el];
      if (type === 'checkbox' && peers.length <= 1) {
        const rawLabel = labelFor(el);
        fields.push({
          key: uniqueKey(name || el.id || rawLabel), jpId: idFor(el), label: clean(rawLabel), type: 'checkbox',
          required: isRequired(el, rawLabel), options: [], optionIds: [], placeholder: null, maxLength: null, fileHint: null
        });
        continue;
      }
      if (doneGroups.has(type + ':' + name)) continue;
      doneGroups.add(type + ':' + name);
      const rawLabel = groupLabel(el);
      fields.push({
        key: uniqueKey(name || rawLabel), jpId: idFor(el), label: clean(rawLabel), type: type === 'radio' ? 'radio' : 'checkboxes',
        required: peers.some((p) => isRequired(p, rawLabel)), options: peers.map((p) => labelFor(p)), optionIds: peers.map(idFor),
        placeholder: null, maxLength: null, fileHint: null
      });
      continue;
    }

    const rawLabel = labelFor(el);
    let fieldType = 'text';
    let options = [];
    if (tag === 'select') {
      fieldType = el.multiple ? 'multiselect' : 'select';
      options = Array.from(el.options).filter((o) => o.value !== '' && !/^(select|choose|please select|--)/i.test(o.text.trim())).map((o) => clean(o.text));
    } else if (tag === 'textarea') {
      fieldType = 'textarea';
    } else if (type === 'file') {
      fieldType = 'file';
    } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') {
      fieldType = 'combobox';
    } else if (['email', 'tel', 'url', 'number', 'date'].includes(type)) {
      fieldType = type;
    }
    const max = el.maxLength && el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : null;
    fields.push({
      key: uniqueKey(el.name || el.id || rawLabel),
      jpId: idFor(el),
      label: clean(rawLabel),
      type: fieldType,
      required: isRequired(el, rawLabel),
      options,
      optionIds: [],
      placeholder: el.getAttribute('placeholder'),
      maxLength: max,
      fileHint: fieldType === 'file' ? fileHint(rawLabel + ' ' + (el.name || '') + ' ' + (el.id || '')) : null
    });
  }
  document.documentElement.dataset.jpCounter = String(counter);
  return fields;
})()`
